#!/usr/bin/env python3
"""
Offline training script for the XGBoost price forecasting model (FR-5).

Usage
-----
    python tools/train_pricing.py \
        --db-url postgresql://user@host/lucidcarat \
        --checkpoint checkpoints/pricing/v1.0.joblib \
        --model-version 1.0.0 \
        [--val-fraction 0.15]

Data source
-----------
Pulls stones in dataset_split='training' joined to certificates and
price_forecasts (for any reference prices stored by the ingest pipeline).

Label column: stones.sold_price_usd if available, else price_forecasts
reference price (from RapNet-sourced benchmarks or manual entry).
Stones without a label are skipped with a warning.

Per-shape models
----------------
Currently a single multi-shape model is trained with shape as a one-hot feature.
When any shape has ≥ 500 labeled stones, add --per-shape flag to split training.

TODO (Phase 2): wire RapNet price feed as additional training signal.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "pricing"))

import psycopg
import psycopg.rows

from pricing.features import build_features, FEATURE_NAMES
from pricing.model import train_and_save

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def _fetch_labeled(conn: psycopg.Connection, split: str) -> list:
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
            s.list_price_usd                                 AS label
        FROM stones s
        LEFT JOIN certificates c     ON c.stone_id = s.id
        WHERE s.dataset_split = %s
          AND s.list_price_usd IS NOT NULL
        """,
        (split,),
    ).fetchall()
    return [dict(r) for r in rows]


def main() -> None:
    p = argparse.ArgumentParser(description="Train LucidCarat pricing model")
    p.add_argument("--db-url", default=os.environ.get("LC_DATABASE_URL",
                   "postgresql://urvilkargathala@localhost/lucidcarat_dev"))
    p.add_argument("--checkpoint", default="checkpoints/pricing/model.joblib")
    p.add_argument("--model-version", default="1.0.0")
    p.add_argument("--val-fraction", type=float, default=0.15)
    p.add_argument("--n-estimators", type=int, default=400)
    p.add_argument("--max-depth", type=int, default=5)
    p.add_argument("--learning-rate", type=float, default=0.05)
    args = p.parse_args()

    conn = psycopg.connect(args.db_url, row_factory=psycopg.rows.dict_row)
    records = _fetch_labeled(conn, "training")
    conn.close()

    if not records:
        logger.error(
            "No labeled training stones found. Stones need dataset_split='training' "
            "and a reference_price_usd in price_forecasts. "
            "Add price benchmarks via the ingest pipeline or manually."
        )
        sys.exit(1)

    logger.info("Building feature matrix from %d labeled stones", len(records))
    X_rows, y = [], []
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
            X_rows.append(feats.to_vector())
            y.append(float(rec["label"]))
        except Exception as exc:
            logger.warning("Skipping stone %s: %s", rec["id"], exc)
            skipped += 1

    if not X_rows:
        logger.error("No usable training rows after feature building. Exiting.")
        sys.exit(1)

    X = np.stack(X_rows)
    y_arr = np.array(y)
    logger.info("Training  X=%s  y_range=[%.0f, %.0f]  skipped=%d",
                X.shape, y_arr.min(), y_arr.max(), skipped)

    # Validation split (random, not stratified — OK for regression)
    n_val = max(1, int(len(X) * args.val_fraction))
    idx = np.random.default_rng(42).permutation(len(X))
    val_idx, train_idx = idx[:n_val], idx[n_val:]
    X_train, y_train = X[train_idx], y_arr[train_idx]
    X_val,   y_val   = X[val_idx],   y_arr[val_idx]

    logger.info("Train=%d  Val=%d", len(X_train), len(X_val))

    bundle = train_and_save(
        X_train, y_train,
        checkpoint_path=args.checkpoint,
        model_version=args.model_version,
        n_estimators=args.n_estimators,
        max_depth=args.max_depth,
        learning_rate=args.learning_rate,
    )

    # Quick validation metrics — XGBRegressor takes numpy arrays directly
    preds = bundle["point"].predict(X_val)
    mape = float(np.mean(np.abs((y_val - preds) / np.clip(y_val, 1, None))) * 100)
    logger.info("Validation MAPE: %.2f%%  (target: rounds ≤8%%, fancies ≤12%%)", mape)

    if mape <= 8.0:
        logger.info("GATE: MAPE target met for round brilliants ✓")
    else:
        logger.warning(
            "GATE: MAPE %.2f%% above target. Continue training or add more data.", mape
        )


if __name__ == "__main__":
    main()
