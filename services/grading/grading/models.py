"""
PyTorch model definitions for 4Cs grading.

Architecture
------------
All three classifiers share the same backbone (EfficientNet-B0 pretrained on
ImageNet-1K) with a task-specific linear head.  The heads are small because the
visual features most predictive of Color and Cut are well-represented in general
image embeddings; we expect modest fine-tuning on ~1,000+ labeled stones to
converge quickly.

Clarity is architecturally identical but is explicitly marked as "beta" — the
confidence output is hard-capped at MAX_CLARITY_CONFIDENCE at inference time.
This reflects the known difficulty of detecting inclusions (I1 vs IF) from
360° video versus a microscope or loupe.  The cap prevents the model from
reporting false certainty while we collect more data.

Grade label ordering follows the GIA scale (worst → best for numerics, but
stored as readable strings for human display).

Training contract
-----------------
• Input:  batch of frame tensors, shape (B, C, N_FRAMES, H, W) — but the model
  averages across frames internally, so the forward pass receives (B, C, H, W)
  per frame and the caller aggregates.
• Output: (logits tensor of shape (B, N_CLASSES),)
• Loss:   CrossEntropyLoss — one-hot label = cert grade index.
• Labels: use LABEL_TO_IDX dicts to convert cert grade strings to class indices.

The pipeline (pipeline.py) handles multi-frame aggregation by averaging softmax
probabilities across extracted frames before argmax/confidence.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import torch
import torch.nn as nn
from torchvision.models import efficientnet_b0, EfficientNet_B0_Weights

logger = logging.getLogger(__name__)

# ── Grade label definitions ───────────────────────────────────────────────────

COLOR_GRADES: List[str] = [
    "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
    "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
]

CUT_GRADES: List[str] = ["Excellent", "Very Good", "Good", "Fair", "Poor"]

CLARITY_GRADES: List[str] = [
    "FL", "IF", "VVS1", "VVS2", "VS1", "VS2", "SI1", "SI2", "I1", "I2", "I3",
]

COLOR_LABEL_TO_IDX: Dict[str, int] = {g: i for i, g in enumerate(COLOR_GRADES)}
CUT_LABEL_TO_IDX: Dict[str, int] = {g: i for i, g in enumerate(CUT_GRADES)}
CLARITY_LABEL_TO_IDX: Dict[str, int] = {g: i for i, g in enumerate(CLARITY_GRADES)}

# Confidence from Clarity is capped to prevent false certainty.
# This should be raised only after the model passes rigorous holdout validation.
MAX_CLARITY_CONFIDENCE = 0.55


# ── Backbone + head ───────────────────────────────────────────────────────────

class GradingHead(nn.Module):
    """Single task-specific classification head on top of EfficientNet-B0."""

    def __init__(self, in_features: int, num_classes: int, dropout: float = 0.3):
        super().__init__()
        self.classifier = nn.Sequential(
            nn.Dropout(p=dropout),
            nn.Linear(in_features, num_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.classifier(x)


class DiamondGradingModel(nn.Module):
    """
    EfficientNet-B0 backbone with three independent grading heads.

    Can be used as a single multi-task model (shared backbone, three heads) or
    the heads can be frozen/loaded independently for ablation studies.

    In production all three grades are inferred in one forward pass per frame to
    avoid redundant feature extraction.
    """

    def __init__(
        self,
        pretrained: bool = True,
        dropout: float = 0.3,
    ):
        super().__init__()

        weights = EfficientNet_B0_Weights.DEFAULT if pretrained else None
        backbone = efficientnet_b0(weights=weights)

        # Remove the original classifier head; keep the feature extractor.
        in_features = backbone.classifier[1].in_features
        backbone.classifier = nn.Identity()
        self.backbone = backbone

        self.color_head = GradingHead(in_features, len(COLOR_GRADES), dropout)
        self.cut_head = GradingHead(in_features, len(CUT_GRADES), dropout)
        self.clarity_head = GradingHead(in_features, len(CLARITY_GRADES), dropout)

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Args:
            x: (B, 3, H, W) batch of frames, ImageNet-normalized.
        Returns:
            (color_logits, cut_logits, clarity_logits) — each (B, N_CLASSES).
        """
        feats = self.backbone(x)
        return (
            self.color_head(feats),
            self.cut_head(feats),
            self.clarity_head(feats),
        )


# ── Checkpoint helpers ────────────────────────────────────────────────────────

def load_model(
    checkpoint_path: Optional[Path],
    device: torch.device,
    pretrained_backbone: bool = True,
) -> DiamondGradingModel:
    """
    Load model from checkpoint, or return an ImageNet-pretrained model with
    randomly initialized heads if no checkpoint exists.

    A missing checkpoint is logged as a WARNING — callers should set confidence
    thresholds accordingly (the pipeline reports low confidence for untrained heads).
    """
    model = DiamondGradingModel(pretrained=pretrained_backbone)

    if checkpoint_path is None or not Path(checkpoint_path).exists():
        if checkpoint_path is not None:
            logger.warning(
                "Grading checkpoint not found at %s — using untrained heads. "
                "Predictions will be unreliable until a fine-tuned checkpoint is provided.",
                checkpoint_path,
            )
        else:
            logger.info("No checkpoint path set — using ImageNet-pretrained backbone with untrained heads.")
        model.eval()
        return model.to(device)

    state = torch.load(checkpoint_path, map_location=device)
    # Support both raw state_dict and {"model_state_dict": ...} convention.
    state_dict = state.get("model_state_dict", state)
    model.load_state_dict(state_dict, strict=True)
    logger.info("Loaded grading checkpoint from %s", checkpoint_path)
    model.eval()
    return model.to(device)


def save_checkpoint(
    model: DiamondGradingModel,
    path: Path,
    epoch: int,
    val_metrics: dict,
) -> None:
    torch.save(
        {
            "model_state_dict": model.state_dict(),
            "epoch": epoch,
            "val_metrics": val_metrics,
        },
        path,
    )
    logger.info("Saved checkpoint to %s (epoch %d)", path, epoch)
