#!/usr/bin/env python3
"""
Offline MAPE eval harness for the XGBoost price forecasting model (FR-5, BR-2).

Usage
-----
    python tools/eval/eval_pricing.py \
        --db-url postgresql://user@host/lucidcarat \
        [--checkpoint checkpoints/pricing/model.joblib] \
        [--split holdout]          # or 'validation' or 'training'
        [--output-json eval_pricing.json]

Targets (BR-2):
    ≤8%  MAPE on round brilliants
    ≤12% MAPE on fancy shapes

Data source
-----------
Stones with dataset_split = <split> that have list_price_usd set in the stones table.
A "holdout" split is the gold standard; validation can be used during training.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "services" / "pricing"))

import psycopg
import psycopg.rows

from pricing.features import build_features
from pricing.model import PricingModel

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


ROUND_TARGET = 8.0
FANCY_TARGET = 12.0


def _fetch_holdout(conn: psycopg.Connection, split: str) -> list:
    rows = conn.execute(
        """
        SELECT
            s.id, s.shape,
            s.carat_weight,
            COALESCE(s.confirmed_color, c.color_grade)      AS color_grade,
            COALESCE(s.confirmed_cut, c.cut_grade)          AS cut_grade,
            COALESCE(s.confirmed_clarity, c.clarity_grade)  AS clarity_grade,
            c.fluorescence,
            c.depth_pct, c.table_pct, c.measurements_mm,
            s.list_price_usd                                 AS true_price
        FROM stones s
        LEFT JOIN certificates c ON c.stone_id = s.id
        WHERE s.dataset_split = %s
          AND s.list_price_usd IS NOT NULL
        """,
        (split,),
    ).fetchall()
    return [dict(r) for r in rows]


def _mape(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.mean(np.abs((y_true - y_pred) / np.clip(y_true, 1, None))) * 100)


def main() -> None:
    p = argparse.ArgumentParser(description="Eval LucidCarat pricing MAPE")
    p.add_argument("--db-url", default=os.environ.get("LC_DATABASE_URL",
                   "postgresql://urvilkargathala@localhost/lucidcarat_dev"))
    p.add_argument("--checkpoint", default=os.environ.get("PRICING_CHECKPOINT"))
    p.add_argument("--split", default="holdout",
                   help="dataset_split value: holdout | validation | training")
    p.add_argument("--output-json", default=None)
    args = p.parse_args()

    conn = psycopg.connect(args.db_url, row_factory=psycopg.rows.dict_row)
    records = _fetch_holdout(conn, args.split)
    conn.close()

    if not records:
        logger.warning(
            "No %s stones with list_price_usd found.\n"
            "  Set list_price_usd and dataset_split on stones to enable MAPE eval:\n"
            "    UPDATE stones SET list_price_usd = <price>, dataset_split = '%s'\n"
            "    WHERE id = '<stone_id>';\n"
            "MAPE eval: N/A (0 holdout stones) — this is expected at Phase 0/1.",
            args.split, args.split,
        )
        result = {
            "split": args.split,
            "n_total": 0,
            "n_round": 0,
            "n_fancy": 0,
            "mape_all": None,
            "mape_round": None,
            "mape_fancy": None,
            "gate_round_pass": None,
            "gate_fancy_pass": None,
            "model_version": "N/A",
        }
        if args.output_json:
            Path(args.output_json).write_text(json.dumps(result, indent=2))
        return

    model = PricingModel(checkpoint_path=args.checkpoint)

    y_true_all, y_pred_all, shapes = [], [], []
    skipped = 0
    for rec in records:
        if not rec["carat_weight"] or not rec["color_grade"] or not rec["clarity_grade"]:
            skipped += 1
            continue
        try:
            feats = build_features(
                carat_weight=float(rec["carat_weight"]),
                color_grade=rec["color_grade"],
                clarity_grade=rec["clarity_grade"],
                cut_grade=rec.get("cut_grade"),
                fluorescence=rec.get("fluorescence"),
                depth_pct=float(rec["depth_pct"]) if rec.get("depth_pct") else None,
                table_pct=float(rec["table_pct"]) if rec.get("table_pct") else None,
                measurements_mm=rec.get("measurements_mm"),
                shape=rec.get("shape") or "other",
            )
            forecast = model.predict(feats)
            y_true_all.append(float(rec["true_price"]))
            y_pred_all.append(forecast.fair_price_usd)
            shapes.append(rec.get("shape") or "other")
        except Exception as exc:
            logger.warning("Skipping stone %s: %s", rec["id"], exc)
            skipped += 1

    if not y_true_all:
        logger.error("No usable eval rows after feature building.")
        sys.exit(1)

    y_true = np.array(y_true_all)
    y_pred = np.array(y_pred_all)
    shapes_arr = np.array(shapes)

    is_round = shapes_arr == "round_brilliant"
    is_fancy = ~is_round

    mape_all   = _mape(y_true, y_pred)
    mape_round = _mape(y_true[is_round], y_pred[is_round]) if is_round.any() else None
    mape_fancy = _mape(y_true[is_fancy], y_pred[is_fancy]) if is_fancy.any() else None

    logger.info("=" * 60)
    logger.info("Pricing eval — split=%s  n=%d  skipped=%d", args.split, len(y_true), skipped)
    logger.info("  MAPE (all):    %.2f%%", mape_all)
    if mape_round is not None:
        gate_r = mape_round <= ROUND_TARGET
        logger.info("  MAPE (round):  %.2f%%  [target ≤%.0f%%]  %s",
                    mape_round, ROUND_TARGET, "✓ PASS" if gate_r else "✗ FAIL")
    else:
        gate_r = None
        logger.info("  MAPE (round):  N/A (no round stones in split)")
    if mape_fancy is not None:
        gate_f = mape_fancy <= FANCY_TARGET
        logger.info("  MAPE (fancy):  %.2f%%  [target ≤%.0f%%]  %s",
                    mape_fancy, FANCY_TARGET, "✓ PASS" if gate_f else "✗ FAIL")
    else:
        gate_f = None
        logger.info("  MAPE (fancy):  N/A (no fancy stones in split)")
    logger.info("  Model version: %s  (heuristic=%s)", model.model_version, model._use_heuristic)
    logger.info("=" * 60)

    result = {
        "split": args.split,
        "n_total": len(y_true),
        "n_round": int(is_round.sum()),
        "n_fancy": int(is_fancy.sum()),
        "mape_all": round(mape_all, 4),
        "mape_round": round(mape_round, 4) if mape_round is not None else None,
        "mape_fancy": round(mape_fancy, 4) if mape_fancy is not None else None,
        "gate_round_pass": gate_r,
        "gate_fancy_pass": gate_f,
        "model_version": model.model_version,
    }

    if args.output_json:
        Path(args.output_json).write_text(json.dumps(result, indent=2))
        logger.info("Results written to %s", args.output_json)

    if gate_r is False or gate_f is False:
        logger.warning(
            "MAPE gate not met — do NOT promote pricing feature publicly until "
            "targets are met on a holdout set (BR-2 / CLAUDE.md §8)."
        )
        sys.exit(2)   # non-zero to fail CI pipelines


if __name__ == "__main__":
    main()
