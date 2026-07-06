"""
LucidCarat Pricing Service — FastAPI application (FR-5).

Endpoints
---------
POST /forecast              — generate a price forecast for a stone
POST /forecast/adjust       — apply markup/markdown to current forecast
GET  /forecast/{stone_id}   — retrieve current forecast for a stone
GET  /health                — liveness probe

Design
------
• XGBoost point model + quantile models for 90% confidence band.
• SHAP TreeExplainer for ranked feature contributions (top_drivers).
• Heuristic fallback when no trained checkpoint exists.
• Response time target: < 2s (XGBoost inference is <50ms; DB ops < 200ms).
• Manual markup/markdown stored in-row; original fair_price_usd never overwritten.
• Emits price_forecast_generated and price_adjusted analytics events (CLAUDE.md §11).
"""
from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional
from uuid import UUID

import psycopg
import psycopg.rows
from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

from pricing.features import build_features, FEATURE_NAMES
from pricing.model import PricingModel
from pricing.writer import write_forecast, apply_adjustment

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

DATABASE_URL     = os.environ.get("LC_DATABASE_URL",
                    "postgresql://urvilkargathala@localhost/lucidcarat_dev")
PRICING_CHECKPOINT   = os.environ.get("PRICING_CHECKPOINT")
PRICING_MODEL_VERSION = os.environ.get("PRICING_MODEL_VERSION", "heuristic-fallback")


# ── Singletons ────────────────────────────────────────────────────────────────

_db_conn: psycopg.Connection | None = None
_pricing_model: PricingModel | None = None


def get_db() -> psycopg.Connection:
    global _db_conn
    if _db_conn is None or _db_conn.closed:
        _db_conn = psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row, autocommit=True)
    return _db_conn


def get_model() -> PricingModel:
    if _pricing_model is None:
        raise RuntimeError("Pricing model not initialised")
    return _pricing_model


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db_conn, _pricing_model
    _db_conn = psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row, autocommit=True)
    _pricing_model = PricingModel(
        checkpoint_path=PRICING_CHECKPOINT,
        model_version=PRICING_MODEL_VERSION,
    )
    logger.info("Pricing service ready  model_version=%s", _pricing_model.model_version)
    yield
    if _db_conn and not _db_conn.closed:
        _db_conn.close()


app = FastAPI(
    title="LucidCarat Pricing Service",
    version="0.1.0",
    lifespan=lifespan,
)


# ── Request / response models ─────────────────────────────────────────────────

class ForecastRequest(BaseModel):
    stone_id: UUID
    tenant_id: UUID

    # Confirmed grade inputs from Step 3 override workflow.
    color_grade: str
    clarity_grade: str
    cut_grade: Optional[str] = None      # None for fancy shapes
    shape: Optional[str] = "round_brilliant"

    # Optional cert/measurement inputs for richer predictions.
    carat_weight: float = Field(..., gt=0, description="From cert/scale (FR-2 hard rule)")
    fluorescence: Optional[str] = None
    depth_pct: Optional[float] = None
    table_pct: Optional[float] = None
    measurements_mm: Optional[str] = None   # "L x W x D"

    # Tracing
    actor_id: Optional[UUID] = None
    request_id: Optional[str] = None


class DriverOut(BaseModel):
    feature: str
    direction: str      # "up" | "down"
    value: Any
    importance: float


class ForecastResponse(BaseModel):
    forecast_id: str
    stone_id: str
    model_version: str
    fair_price_usd: float
    confidence_low_usd: float
    confidence_high_usd: float
    confidence_level: float
    top_drivers: List[DriverOut]
    adjusted_price_usd: float      # = fair_price_usd when markup_pct=0
    markup_pct: float
    response_time_ms: float


class AdjustRequest(BaseModel):
    stone_id: UUID
    tenant_id: UUID
    markup_pct: float = Field(..., description="Positive=markup, negative=markdown")
    actor_id: UUID
    adjustment_note: Optional[str] = None
    request_id: Optional[str] = None


class AdjustResponse(BaseModel):
    forecast_id: str
    stone_id: str
    fair_price_usd: float
    markup_pct: float
    adjusted_price_usd: float
    model_version: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict:
    model = get_model()
    return {
        "status": "ok",
        "service": "pricing",
        "model_version": model.model_version,
        "using_heuristic": model._use_heuristic,
    }


@app.post("/forecast", response_model=ForecastResponse, status_code=status.HTTP_201_CREATED)
def generate_forecast(req: ForecastRequest) -> ForecastResponse:
    """
    Generate a price forecast for a stone using the XGBoost model.

    Inputs are the confirmed grades from Step 3's override workflow.
    The response includes a 90% confidence band and ranked top price drivers.
    Target response time: < 2s (typically < 200ms).
    """
    t0 = time.monotonic()

    features = build_features(
        carat_weight=req.carat_weight,
        color_grade=req.color_grade,
        clarity_grade=req.clarity_grade,
        cut_grade=req.cut_grade,
        fluorescence=req.fluorescence,
        depth_pct=req.depth_pct,
        table_pct=req.table_pct,
        measurements_mm=req.measurements_mm,
        shape=req.shape,
    )

    model = get_model()
    forecast = model.predict(features)

    conn = get_db()
    try:
        with conn.transaction():
            forecast_id = write_forecast(
                conn,
                forecast=forecast,
                features=features,
                stone_id=str(req.stone_id),
                tenant_id=str(req.tenant_id),
                actor_id=str(req.actor_id) if req.actor_id else None,
                request_id=req.request_id,
            )
    except psycopg.Error as exc:
        logger.error("DB error writing forecast: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    elapsed_ms = round((time.monotonic() - t0) * 1000, 1)

    return ForecastResponse(
        forecast_id=forecast_id,
        stone_id=str(req.stone_id),
        model_version=forecast.model_version,
        fair_price_usd=forecast.fair_price_usd,
        confidence_low_usd=forecast.confidence_low_usd,
        confidence_high_usd=forecast.confidence_high_usd,
        confidence_level=forecast.confidence_level,
        top_drivers=[
            DriverOut(
                feature=d["feature"],
                direction=d["direction"],
                value=d["value"],
                importance=d["importance"],
            )
            for d in forecast.top_drivers
        ],
        adjusted_price_usd=forecast.fair_price_usd,   # no markup yet
        markup_pct=0.0,
        response_time_ms=elapsed_ms,
    )


@app.post("/forecast/adjust", response_model=AdjustResponse)
def adjust_forecast(req: AdjustRequest) -> AdjustResponse:
    """
    Apply a markup (positive) or markdown (negative) to the current forecast.

    The original fair_price_usd is preserved. adjusted_price_usd =
    fair_price_usd * (1 + markup_pct / 100).
    Emits the price_adjusted analytics event.
    """
    conn = get_db()
    try:
        with conn.transaction():
            result = apply_adjustment(
                conn,
                stone_id=str(req.stone_id),
                tenant_id=str(req.tenant_id),
                markup_pct=float(req.markup_pct),
                actor_id=str(req.actor_id),
                adjustment_note=req.adjustment_note,
                request_id=req.request_id,
            )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except psycopg.Error as exc:
        logger.error("DB error adjusting forecast: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    return AdjustResponse(
        forecast_id=result["forecast_id"],
        stone_id=str(req.stone_id),
        fair_price_usd=result["fair_price_usd"],
        markup_pct=result["markup_pct"],
        adjusted_price_usd=result["adjusted_price_usd"],
        model_version=result["model_version"],
    )


@app.get("/forecast/{stone_id}", response_model=ForecastResponse)
def get_forecast(stone_id: str, tenant_id: UUID) -> ForecastResponse:
    """Retrieve the current active forecast for a stone."""
    conn = get_db()
    row = conn.execute(
        """
        SELECT id, model_version, fair_price_usd, confidence_low_usd,
               confidence_high_usd, confidence_level, top_drivers,
               markup_pct, adjusted_by, adjusted_at
        FROM   price_forecasts
        WHERE  stone_id = %s AND tenant_id = %s AND is_current = true
        """,
        (stone_id, str(tenant_id)),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"No current forecast for stone {stone_id}")

    markup = float(row["markup_pct"] or 0)
    fair   = float(row["fair_price_usd"])
    adjusted = round(fair * (1 + markup / 100.0), 2)

    return ForecastResponse(
        forecast_id=str(row["id"]),
        stone_id=stone_id,
        model_version=row["model_version"],
        fair_price_usd=fair,
        confidence_low_usd=float(row["confidence_low_usd"]),
        confidence_high_usd=float(row["confidence_high_usd"]),
        confidence_level=float(row["confidence_level"]),
        top_drivers=[
            DriverOut(**d) for d in (row["top_drivers"] or [])
        ],
        adjusted_price_usd=adjusted,
        markup_pct=markup,
        response_time_ms=0.0,   # retrieve, not forecast
    )
