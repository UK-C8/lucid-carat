#!/usr/bin/env python3
"""
Offline training script for the DiamondGradingModel.

Usage
-----
    python tools/train_grading.py \
        --db-url postgresql://user@host/lucidcarat \
        --video-base-dir /data/videos \
        --checkpoint-dir /data/checkpoints \
        --epochs 30 \
        --batch-size 16

Data source
-----------
Pulls stones with dataset_split IN ('training', 'validation') from the DB.
Labels come from the confirmed_* fields on the stones table (human-confirmed
grades), falling back to the cert grade when confirmed_* is NULL.

Label priority (per dimension):
  1. stones.confirmed_color / confirmed_cut / confirmed_clarity  (human override)
  2. certificates.color_grade / cut_grade / clarity_grade        (cert)
  3. Skip this stone for this dimension if no label available

Only stones where the video file exists on disk (--video-base-dir/<s3_key_filename>)
are included in training batches.

Architecture
------------
Single DiamondGradingModel with three heads.  The loss is a sum of three
CrossEntropyLoss terms with equal weighting.  A future improvement is to weight
Color and Cut more heavily than Clarity until the Clarity head is validated.

The checkpoint saved at each epoch is loadable by the grading service without
any extra code — set GRADING_CHECKPOINT env var to the .pth path.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

# Allow running from repo root or tools/ dir.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "grading"))

import psycopg
import psycopg.rows
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms
import cv2
import numpy as np

from grading.models import (
    DiamondGradingModel,
    COLOR_LABEL_TO_IDX, CUT_LABEL_TO_IDX, CLARITY_LABEL_TO_IDX,
    save_checkpoint,
)
from grading.pipeline import extract_frames, N_FRAMES

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

_NORMALIZE = transforms.Normalize(
    mean=[0.485, 0.456, 0.406],
    std=[0.229, 0.224, 0.225],
)
_AUG = transforms.Compose([
    transforms.ToPILImage(),
    transforms.RandomHorizontalFlip(),
    transforms.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.1),
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    _NORMALIZE,
])
_EVAL = transforms.Compose([
    transforms.ToPILImage(),
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    _NORMALIZE,
])


class DiamondDataset(Dataset):
    """
    Each item is a single frame + label triple (color_idx, cut_idx, clarity_idx).
    Frames from all stones in the split are flattened into one dataset so the
    DataLoader can shuffle freely across stones.
    -1 means the label is absent for that dimension.
    """

    def __init__(self, records: list, video_base_dir: Path, augment: bool = True):
        self.items: list = []
        self.transform = _AUG if augment else _EVAL
        skipped = 0

        for rec in records:
            video_file = _resolve_video(rec["video_s3_key"], video_base_dir)
            if video_file is None:
                skipped += 1
                continue
            try:
                frames = extract_frames(str(video_file), n_frames=N_FRAMES)
            except Exception as e:
                logger.warning("Skipping stone %s — frame extraction failed: %s", rec["stone_id"], e)
                skipped += 1
                continue

            color_idx = _label_idx(rec.get("color_grade"), COLOR_LABEL_TO_IDX)
            cut_idx = _label_idx(rec.get("cut_grade"), CUT_LABEL_TO_IDX)
            clarity_idx = _label_idx(rec.get("clarity_grade"), CLARITY_LABEL_TO_IDX)

            for frame in frames:
                self.items.append((frame, color_idx, cut_idx, clarity_idx))

        logger.info(
            "Dataset: %d frame items from %d records  skipped=%d",
            len(self.items), len(records), skipped,
        )

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, idx: int):
        frame_bgr, c, k, cl = self.items[idx]
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        tensor = self.transform(rgb)
        return tensor, c, k, cl


def _resolve_video(s3_key: str, base_dir: Path) -> Path | None:
    """Find video file by S3 key filename under base_dir."""
    filename = Path(s3_key).name
    candidate = base_dir / filename
    if candidate.exists():
        return candidate
    # Also search recursively (useful when files are stored by stone_id subfolder).
    matches = list(base_dir.rglob(filename))
    return matches[0] if matches else None


def _label_idx(grade: str | None, mapping: dict) -> int:
    if grade is None:
        return -1
    return mapping.get(grade, -1)


def _fetch_records(conn: psycopg.Connection, split: str) -> list:
    """
    Join stones + certificates to get labeled records for the given split.
    Human-confirmed grades take priority over cert grades.
    """
    rows = conn.execute(
        """
        SELECT
            s.id                                            AS stone_id,
            s.video_s3_key,
            s.shape,
            COALESCE(s.confirmed_color, c.color_grade)     AS color_grade,
            COALESCE(s.confirmed_cut, c.cut_grade)         AS cut_grade,
            COALESCE(s.confirmed_clarity, c.clarity_grade) AS clarity_grade
        FROM stones s
        LEFT JOIN certificates c ON c.stone_id = s.id
        WHERE s.dataset_split = %s
          AND s.video_s3_key IS NOT NULL
        """,
        (split,),
    ).fetchall()
    return [dict(r) for r in rows]


def train(args: argparse.Namespace) -> None:
    device = torch.device(
        "cuda" if torch.cuda.is_available()
        else "mps" if torch.backends.mps.is_available()
        else "cpu"
    )
    logger.info("Training device: %s", device)

    conn = psycopg.connect(args.db_url, row_factory=psycopg.rows.dict_row)
    train_recs = _fetch_records(conn, "training")
    val_recs = _fetch_records(conn, "validation")
    conn.close()

    if not train_recs:
        logger.error(
            "No training records found (dataset_split='training' stones with video_s3_key). "
            "Ingest training data with tools/ingest/ingest.py --split training first."
        )
        sys.exit(1)

    logger.info("Training records: %d  Validation records: %d", len(train_recs), len(val_recs))

    video_base = Path(args.video_base_dir)
    train_ds = DiamondDataset(train_recs, video_base, augment=True)
    val_ds = DiamondDataset(val_recs, video_base, augment=False) if val_recs else None

    if not train_ds:
        logger.error("No usable training frames found — check --video-base-dir and S3 key filenames.")
        sys.exit(1)

    train_loader = DataLoader(
        train_ds, batch_size=args.batch_size, shuffle=True, num_workers=2, pin_memory=True,
    )
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False, num_workers=2) if val_ds else None

    model = DiamondGradingModel(pretrained=True).to(device)

    # Freeze backbone for first 3 epochs (head warm-up), then unfreeze.
    for param in model.backbone.parameters():
        param.requires_grad = False

    optimizer = torch.optim.AdamW(
        filter(lambda p: p.requires_grad, model.parameters()),
        lr=args.lr,
        weight_decay=1e-4,
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    criterion = nn.CrossEntropyLoss(ignore_index=-1)

    ckpt_dir = Path(args.checkpoint_dir)
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    best_val_color_acc = 0.0

    for epoch in range(1, args.epochs + 1):
        if epoch == 4:
            # Unfreeze backbone with a lower LR.
            for param in model.backbone.parameters():
                param.requires_grad = True
            optimizer.add_param_group({
                "params": model.backbone.parameters(),
                "lr": args.lr * 0.1,
            })
            logger.info("Backbone unfrozen at epoch %d", epoch)

        model.train()
        total_loss = 0.0
        n_batches = 0

        for frames, c_labels, k_labels, cl_labels in train_loader:
            frames = frames.to(device)
            c_labels = c_labels.to(device)
            k_labels = k_labels.to(device)
            cl_labels = cl_labels.to(device)

            color_logits, cut_logits, clarity_logits = model(frames)
            loss = (
                criterion(color_logits, c_labels)
                + criterion(cut_logits, k_labels)
                + criterion(clarity_logits, cl_labels)
            )

            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            total_loss += loss.item()
            n_batches += 1

        scheduler.step()
        avg_loss = total_loss / max(n_batches, 1)
        logger.info("Epoch %d/%d  train_loss=%.4f", epoch, args.epochs, avg_loss)

        val_metrics: dict = {"epoch": epoch, "train_loss": round(avg_loss, 4)}

        if val_loader:
            val_metrics.update(_evaluate(model, val_loader, device))
            color_acc = val_metrics.get("color_exact_match", 0.0)
            if color_acc > best_val_color_acc:
                best_val_color_acc = color_acc
                best_path = ckpt_dir / "best.pth"
                save_checkpoint(model, best_path, epoch, val_metrics)

        epoch_path = ckpt_dir / f"epoch_{epoch:03d}.pth"
        save_checkpoint(model, epoch_path, epoch, val_metrics)

    logger.info("Training complete.  Best validation color exact-match: %.3f", best_val_color_acc)


@torch.no_grad()
def _evaluate(model, loader, device) -> dict:
    model.eval()
    color_total = color_correct = color_within1 = 0
    cut_total = cut_correct = cut_within1 = 0

    from grading.models import COLOR_GRADES, CUT_GRADES

    for frames, c_labels, k_labels, cl_labels in loader:
        frames = frames.to(device)
        color_logits, cut_logits, _ = model(frames)

        for pred, true in zip(color_logits.argmax(1).cpu(), c_labels):
            if true.item() == -1:
                continue
            color_total += 1
            if pred.item() == true.item():
                color_correct += 1
            if abs(pred.item() - true.item()) <= 1:
                color_within1 += 1

        for pred, true in zip(cut_logits.argmax(1).cpu(), k_labels):
            if true.item() == -1:
                continue
            cut_total += 1
            if pred.item() == true.item():
                cut_correct += 1
            if abs(pred.item() - true.item()) <= 1:
                cut_within1 += 1

    metrics = {}
    if color_total:
        metrics["color_exact_match"] = round(color_correct / color_total, 4)
        metrics["color_within1"] = round(color_within1 / color_total, 4)
    if cut_total:
        metrics["cut_exact_match"] = round(cut_correct / cut_total, 4)
        metrics["cut_within1"] = round(cut_within1 / cut_total, 4)

    logger.info("Validation  color: exact=%.3f ±1=%.3f  cut: exact=%.3f ±1=%.3f",
                metrics.get("color_exact_match", 0),
                metrics.get("color_within1", 0),
                metrics.get("cut_exact_match", 0),
                metrics.get("cut_within1", 0))
    return metrics


def main() -> None:
    p = argparse.ArgumentParser(description="Train LucidCarat grading model")
    p.add_argument("--db-url", default=os.environ.get("LC_DATABASE_URL",
                   "postgresql://urvilkargathala@localhost/lucidcarat_dev"))
    p.add_argument("--video-base-dir", required=True, help="Directory containing .mp4 video files")
    p.add_argument("--checkpoint-dir", default="checkpoints/grading")
    p.add_argument("--epochs", type=int, default=30)
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--lr", type=float, default=1e-3)
    args = p.parse_args()
    train(args)


if __name__ == "__main__":
    main()
