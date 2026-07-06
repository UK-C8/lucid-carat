"""
Persist price forecasts to the price_forecasts table and emit analytics events.

Two operations:
  1. write_forecast() — initial forecast from the model; emits price_forecast_generated
  2. apply_adjustment() — sales staff markup/markdown; emits price_adjusted

Both preserve the original fair_price_usd. The adjusted price is always derived
as fair_price_usd * (1 + markup_pct / 100) and never stored directly — callers
compute it from the stored markup_pct when needed, avoiding a stored redundancy
that could fall out of sync.

adjusted_price_usd (computed) = fair_price_usd × (1 + markup_pct / 100)

is_current ensures only one active forecast per stone (same pattern as
grading_results). A re-forecast retires the previous row before inserting.
"""
from __future__ import annotations

import json
import logging
from decimal import Decimal
from typing import Optional

import psycopg

from .model import PriceForecast
from .features import StoneFeatures

logger = logging.getLogger(__name__)


def write_forecast(
    conn: psycopg.Connection,
    *,
    forecast: PriceForecast,
    features: StoneFeatures,
    stone_id: str,
    tenant_id: str,
    actor_id: Optional[str] = None,
    request_id: Optional[str] = None,
) -> str:
    """
    Retire any current forecast for this stone, insert the new one, and emit
    the price_forecast_generated analytics event.

    Returns the new price_forecast row id.
    """
    # ── 1. Retire previous current forecast ──────────────────────────────────
    conn.execute(
        "UPDATE price_forecasts SET is_current = false WHERE stone_id = %s AND is_current = true",
        (stone_id,),
    )

    # ── 2. Insert new forecast ────────────────────────────────────────────────
    row = conn.execute(
        """
        INSERT INTO price_forecasts (
            stone_id, tenant_id, model_version,
            fair_price_usd, confidence_low_usd, confidence_high_usd, confidence_level,
            top_drivers, input_snapshot, is_current
        ) VALUES (
            %(stone_id)s, %(tenant_id)s, %(model_version)s,
            %(fair_price)s, %(low)s, %(high)s, %(conf_level)s,
            %(top_drivers)s, %(snapshot)s, true
        )
        RETURNING id
        """,
        {
            "stone_id":     stone_id,
            "tenant_id":    tenant_id,
            "model_version": forecast.model_version,
            "fair_price":   Decimal(str(round(forecast.fair_price_usd, 2))),
            "low":          Decimal(str(round(forecast.confidence_low_usd, 2))),
            "high":         Decimal(str(round(forecast.confidence_high_usd, 2))),
            "conf_level":   Decimal(str(forecast.confidence_level)),
            "top_drivers":  json.dumps(forecast.top_drivers),
            "snapshot":     json.dumps(features.to_dict()),
        },
    ).fetchone()
    forecast_id = str(row["id"])

    # ── 3. Update stone status: priced → priced (no change needed; already priced)
    # The stone must already be in 'priced' status before requesting a forecast.
    # We do NOT change status here — that was done by advance_to_priced().

    # ── 4. Analytics event (CLAUDE.md §11) ────────────────────────────────────
    conn.execute(
        """
        INSERT INTO audit_log
            (tenant_id, actor_id, event_type, entity_type, entity_id, payload, request_id)
        VALUES (%s, %s, 'price_forecast_generated', 'stone', %s, %s, %s)
        """,
        (
            tenant_id, actor_id, stone_id,
            json.dumps({
                "forecast_id":      forecast_id,
                "model_version":    forecast.model_version,
                "fair_price_usd":   forecast.fair_price_usd,
                "confidence_low":   forecast.confidence_low_usd,
                "confidence_high":  forecast.confidence_high_usd,
                "top_driver":       forecast.top_drivers[0]["feature"] if forecast.top_drivers else None,
            }),
            request_id,
        ),
    )

    logger.info(
        "price_forecast_generated  stone=%s  fair=%.2f  band=[%.2f, %.2f]  model=%s",
        stone_id, forecast.fair_price_usd,
        forecast.confidence_low_usd, forecast.confidence_high_usd,
        forecast.model_version,
    )
    return forecast_id


def apply_adjustment(
    conn: psycopg.Connection,
    *,
    stone_id: str,
    tenant_id: str,
    markup_pct: float,
    actor_id: str,
    adjustment_note: Optional[str] = None,
    request_id: Optional[str] = None,
) -> dict:
    """
    Apply a markup (positive) or markdown (negative) percentage to the current forecast.

    The original fair_price_usd is never modified.
    Returns a dict with forecast_id, fair_price_usd, markup_pct, adjusted_price_usd.

    Raises ValueError if no current forecast exists for the stone.
    """
    row = conn.execute(
        """
        SELECT id, fair_price_usd, model_version
        FROM   price_forecasts
        WHERE  stone_id = %s AND tenant_id = %s AND is_current = true
        """,
        (stone_id, tenant_id),
    ).fetchone()

    if row is None:
        raise ValueError(f"No current forecast for stone {stone_id} — run /forecast first")

    forecast_id = str(row["id"])
    fair_price  = float(row["fair_price_usd"])
    adjusted    = round(fair_price * (1 + markup_pct / 100.0), 2)

    conn.execute(
        """
        UPDATE price_forecasts
        SET    markup_pct      = %s,
               adjusted_by     = %s,
               adjusted_at     = NOW(),
               adjustment_note = %s
        WHERE  id = %s
        """,
        (Decimal(str(round(markup_pct, 4))), actor_id, adjustment_note, forecast_id),
    )

    # ── Analytics event (CLAUDE.md §11) ──────────────────────────────────────
    conn.execute(
        """
        INSERT INTO audit_log
            (tenant_id, actor_id, event_type, entity_type, entity_id, payload, request_id)
        VALUES (%s, %s, 'price_adjusted', 'stone', %s, %s, %s)
        """,
        (
            tenant_id, actor_id, stone_id,
            json.dumps({
                "forecast_id":       forecast_id,
                "fair_price_usd":    fair_price,
                "markup_pct":        markup_pct,
                "adjusted_price_usd": adjusted,
                "adjustment_note":   adjustment_note,
            }),
            request_id,
        ),
    )

    logger.info(
        "price_adjusted  stone=%s  markup=%.2f%%  fair=%.2f  adjusted=%.2f",
        stone_id, markup_pct, fair_price, adjusted,
    )

    return {
        "forecast_id":        forecast_id,
        "fair_price_usd":     fair_price,
        "markup_pct":         markup_pct,
        "adjusted_price_usd": adjusted,
        "model_version":      str(row["model_version"]),
    }
