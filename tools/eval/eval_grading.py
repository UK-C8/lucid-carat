#!/usr/bin/env python3
"""
Offline eval harness for the CV grading model.

Runs the grading pipeline against stones in the holdout split and reports:
  - Exact match %  (CV grade == cert/confirmed grade)
  - Within ±1 %    (|CV_idx - cert_idx| <= 1)

Per dimension: Color, Cut, Clarity.

This script is the measurement pipeline that fulfils the Phase 1 acceptance
criteria gating (BR-1: ≥90% within ±1, ≥70% exact on 1,000-stone holdout).
Right now we likely have a tiny dataset — the script handles that gracefully
and shows per-stone results alongside aggregate metrics.

Usage
-----
    python tools/eval/eval_grading.py \
        --db-url postgresql://user@host/lucidcarat \
        --video-base-dir /data/videos \
        [--checkpoint /data/checkpoints/best.pth] \
        [--split holdout] \
        [--output-json results.json]

Exit codes
----------
  0  Eval completed (even if dataset is empty)
  1  Fatal error (DB unreachable, video dir missing, etc.)
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "services" / "grading"))

import psycopg
import psycopg.rows

from grading.models import COLOR_GRADES, CUT_GRADES, CLARITY_GRADES
from grading.pipeline import GradingPipeline, GradingResult

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# Acceptance-criteria targets from CLAUDE.md / BRD.
TARGET_WITHIN1 = 0.90
TARGET_EXACT   = 0.70


@dataclass
class DimMetrics:
    n_evaluated: int
    exact_match: float
    within_one: float
    meets_within1_target: bool
    meets_exact_target: bool

    def report(self, dim: str) -> str:
        flag = "✓" if self.meets_within1_target and self.meets_exact_target else "✗"
        return (
            f"  {dim:10s}  n={self.n_evaluated:4d}  "
            f"exact={self.exact_match:.1%}  "
            f"±1={self.within_one:.1%}  "
            f"[target: exact≥{TARGET_EXACT:.0%} ±1≥{TARGET_WITHIN1:.0%}]  {flag}"
        )


@dataclass
class StonePrediction:
    stone_id: str
    cert_number: Optional[str]
    cert_color: Optional[str]
    cert_cut: Optional[str]
    cert_clarity: Optional[str]
    cv_color: Optional[str]
    cv_cut: Optional[str]
    cv_clarity: Optional[str]
    color_confidence: float
    cut_confidence: float
    clarity_confidence: float
    color_exact: Optional[bool]
    color_within1: Optional[bool]
    cut_exact: Optional[bool]
    cut_within1: Optional[bool]
    clarity_exact: Optional[bool]
    clarity_within1: Optional[bool]
    error: Optional[str] = None


def _within_one(predicted: Optional[str], cert: Optional[str], grade_list: List[str]) -> Optional[bool]:
    if predicted is None or cert is None:
        return None
    try:
        return abs(grade_list.index(predicted) - grade_list.index(cert)) <= 1
    except ValueError:
        return None


def _exact(predicted: Optional[str], cert: Optional[str]) -> Optional[bool]:
    if predicted is None or cert is None:
        return None
    return predicted == cert


def _dim_metrics(preds: List[StonePrediction], dim: str) -> DimMetrics:
    exact_vals = [getattr(p, f"{dim}_exact") for p in preds if getattr(p, f"{dim}_exact") is not None]
    within1_vals = [getattr(p, f"{dim}_within1") for p in preds if getattr(p, f"{dim}_within1") is not None]
    n = len(exact_vals)
    if n == 0:
        return DimMetrics(0, 0.0, 0.0, False, False)
    exact = sum(exact_vals) / n
    w1 = sum(within1_vals) / max(len(within1_vals), 1)
    return DimMetrics(
        n_evaluated=n,
        exact_match=round(exact, 4),
        within_one=round(w1, 4),
        meets_within1_target=w1 >= TARGET_WITHIN1,
        meets_exact_target=exact >= TARGET_EXACT,
    )


def _resolve_video(s3_key: str, base_dir: Path) -> Optional[Path]:
    filename = Path(s3_key).name
    candidate = base_dir / filename
    if candidate.exists():
        return candidate
    matches = list(base_dir.rglob(filename))
    return matches[0] if matches else None


def run_eval(args: argparse.Namespace) -> int:
    video_base = Path(args.video_base_dir)
    if not video_base.exists():
        logger.error("--video-base-dir %s does not exist", video_base)
        return 1

    try:
        conn = psycopg.connect(args.db_url, row_factory=psycopg.rows.dict_row)
    except Exception as e:
        logger.error("Cannot connect to DB: %s", e)
        return 1

    rows = conn.execute(
        """
        SELECT
            s.id                                            AS stone_id,
            s.video_s3_key,
            s.shape,
            c.cert_number,
            COALESCE(s.confirmed_color, c.color_grade)     AS color_grade,
            COALESCE(s.confirmed_cut, c.cut_grade)         AS cut_grade,
            COALESCE(s.confirmed_clarity, c.clarity_grade) AS clarity_grade
        FROM stones s
        LEFT JOIN certificates c ON c.stone_id = s.id
        WHERE s.dataset_split = %s
          AND s.video_s3_key IS NOT NULL
        """,
        (args.split,),
    ).fetchall()
    conn.close()

    if not rows:
        print(f"\nEval harness: 0 {args.split} stones found in the DB.\n"
              f"Ingest holdout stones with tools/ingest/ingest.py --split {args.split} to populate.\n"
              f"The measurement pipeline is ready — accuracy metrics will appear once data exists.")
        return 0

    logger.info("Evaluating %d %s stones", len(rows), args.split)

    pipeline = GradingPipeline(
        checkpoint_path=args.checkpoint,
        model_version=f"eval-{args.split}",
    )

    predictions: List[StonePrediction] = []
    skipped = 0

    for rec in rows:
        stone_id = str(rec["stone_id"])
        video_path = _resolve_video(rec["video_s3_key"], video_base)

        if video_path is None:
            logger.warning("Video not found for stone %s  s3_key=%s", stone_id, rec["video_s3_key"])
            skipped += 1
            continue

        try:
            result: GradingResult = pipeline.grade_stone(
                video_path=str(video_path),
                stone_id=stone_id,
                shape=rec.get("shape"),
                cert_color=rec.get("color_grade"),
                cert_cut=rec.get("cut_grade"),
                cert_clarity=rec.get("clarity_grade"),
            )

            pred = StonePrediction(
                stone_id=stone_id,
                cert_number=rec.get("cert_number"),
                cert_color=rec.get("color_grade"),
                cert_cut=rec.get("cut_grade"),
                cert_clarity=rec.get("clarity_grade"),
                cv_color=result.color.grade,
                cv_cut=result.cut.grade,
                cv_clarity=result.clarity.grade,
                color_confidence=result.color.confidence,
                cut_confidence=result.cut.confidence,
                clarity_confidence=result.clarity.confidence,
                color_exact=_exact(result.color.grade, rec.get("color_grade")),
                color_within1=_within_one(result.color.grade, rec.get("color_grade"), COLOR_GRADES),
                cut_exact=_exact(result.cut.grade, rec.get("cut_grade")),
                cut_within1=_within_one(result.cut.grade, rec.get("cut_grade"), CUT_GRADES),
                clarity_exact=_exact(result.clarity.grade, rec.get("clarity_grade")),
                clarity_within1=_within_one(result.clarity.grade, rec.get("clarity_grade"), CLARITY_GRADES),
            )
        except Exception as exc:
            logger.error("Error grading stone %s: %s", stone_id, exc)
            pred = StonePrediction(
                stone_id=stone_id, cert_number=rec.get("cert_number"),
                cert_color=rec.get("color_grade"), cert_cut=rec.get("cut_grade"),
                cert_clarity=rec.get("clarity_grade"),
                cv_color=None, cv_cut=None, cv_clarity=None,
                color_confidence=0.0, cut_confidence=0.0, clarity_confidence=0.0,
                color_exact=None, color_within1=None,
                cut_exact=None, cut_within1=None,
                clarity_exact=None, clarity_within1=None,
                error=str(exc),
            )
            skipped += 1

        predictions.append(pred)

    # ── Aggregate metrics ─────────────────────────────────────────────────────
    successful = [p for p in predictions if p.error is None]
    color_m = _dim_metrics(successful, "color")
    cut_m = _dim_metrics(successful, "cut")
    clarity_m = _dim_metrics(successful, "clarity")

    print("\n" + "=" * 70)
    print(f"LucidCarat Grading Eval Harness  —  split={args.split}")
    print(f"Stones evaluated: {len(successful)}  skipped: {skipped}")
    print("=" * 70)
    print(color_m.report("Color"))
    print(cut_m.report("Cut"))
    print(clarity_m.report("Clarity (beta, capped ≤0.55)"))
    print("=" * 70)

    gate_passed = (
        color_m.meets_within1_target and color_m.meets_exact_target and
        cut_m.meets_within1_target and cut_m.meets_exact_target
    )
    if len(successful) == 0:
        print("STATUS: No data evaluated yet — run more holdout stones through the pipeline.")
    elif gate_passed:
        print("STATUS: GATE PASSED — Color and Cut accuracy targets met.")
    else:
        print("STATUS: GATE NOT YET MET — continue training or expand the holdout set.")
    print("=" * 70 + "\n")

    if len(successful) > 0 and len(successful) <= 20:
        print("Per-stone detail:")
        for p in successful:
            print(
                f"  {str(p.stone_id)[:8]}…  cert={p.cert_number}  "
                f"color: cert={p.cert_color} cv={p.cv_color}({'✓' if p.color_exact else '≈' if p.color_within1 else '✗'})  "
                f"cut: cert={p.cert_cut} cv={p.cv_cut}({'✓' if p.cut_exact else '≈' if p.cut_within1 else '✗'})  "
                f"clarity: cert={p.cert_clarity} cv={p.cv_clarity}({'✓' if p.clarity_exact else '≈' if p.clarity_within1 else '✗'})"
            )
        print()

    if args.output_json:
        output = {
            "split": args.split,
            "n_evaluated": len(successful),
            "n_skipped": skipped,
            "color": asdict(color_m),
            "cut": asdict(cut_m),
            "clarity": asdict(clarity_m),
            "gate_passed": gate_passed,
            "per_stone": [asdict(p) for p in predictions],
        }
        Path(args.output_json).write_text(json.dumps(output, indent=2))
        logger.info("Results written to %s", args.output_json)

    return 0


def main() -> None:
    p = argparse.ArgumentParser(description="LucidCarat grading eval harness")
    p.add_argument("--db-url", default=os.environ.get("LC_DATABASE_URL",
                   "postgresql://urvilkargathala@localhost/lucidcarat_dev"))
    p.add_argument("--video-base-dir", required=True, help="Directory containing video files")
    p.add_argument("--checkpoint", default=None, help="Path to fine-tuned .pth checkpoint")
    p.add_argument("--split", default="holdout", choices=["holdout", "validation", "training"])
    p.add_argument("--output-json", default=None, help="Write full results to this JSON file")
    args = p.parse_args()
    sys.exit(run_eval(args))


if __name__ == "__main__":
    main()
