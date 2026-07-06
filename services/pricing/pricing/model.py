"""
XGBoost price forecasting model.

Three models are trained together:
  point   — standard regression (objective=reg:squarederror), predicts fair_price_usd
  low     — quantile regression at alpha=0.05 (lower bound of 90% CI)
  high    — quantile regression at alpha=0.95 (upper bound of 90% CI)

All three share the same hyperparameters for simplicity.  When more data
arrives, tune each independently (point model cares about MSE; quantile models
care about pinball loss).

Explainability
--------------
Feature contributions are computed via SHAP TreeExplainer on the point model.
The top N drivers are returned as:
  [{"feature": "carat_weight", "direction": "up", "value": 1.23, "importance": 0.42}, ...]
  direction: "up"  = this feature is pushing the price higher
             "down" = pushing it lower

Per-shape models
----------------
Currently flagged as a TODO.  With fewer than ~500 stones per shape in the
training set, per-shape models risk overfitting.  The shape one-hot in the
feature vector lets the single model learn shape multipliers implicitly.
When a per-shape split is warranted, load a model dict keyed by shape and
dispatch in PricingModel.predict().

Model versioning
----------------
The checkpoint is a joblib file containing {"point": model, "low": model,
"high": model, "feature_names": [...], "trained_at": ISO8601, "n_train": int}.
PRICING_MODEL_VERSION env var is embedded in every price_forecasts row so
forecasts are traceable to a training run.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

try:
    import xgboost as xgb
    import shap
    _HAS_XGB = True
except ImportError:
    _HAS_XGB = False
    logger.warning("xgboost/shap not installed — pricing model will use fallback heuristic")

try:
    import joblib
    _HAS_JOBLIB = True
except ImportError:
    _HAS_JOBLIB = False

from .features import FEATURE_NAMES, StoneFeatures

TOP_N_DRIVERS = 5
CONFIDENCE_LEVEL = 0.90   # 90% prediction interval


@dataclass
class PriceForecast:
    fair_price_usd: float
    confidence_low_usd: float
    confidence_high_usd: float
    confidence_level: float
    top_drivers: List[Dict]    # [{"feature", "direction", "value", "importance"}]
    model_version: str


def _heuristic_price(features: StoneFeatures) -> PriceForecast:
    """
    Rule-based fallback price when no trained model checkpoint exists.

    Uses Rapaport-inspired logic:
      base = RapSheet-like carat-weight × grade multipliers
    This is intentionally conservative and clearly labelled as a fallback.
    The confidence band is wide (±40%) to signal low confidence.
    """
    # Color multipliers (D=best, higher is more expensive relative to H baseline)
    color_mult = max(0.3, 1.0 - (features.color_ordinal * 0.04))
    # Clarity multipliers (FL=best)
    clarity_mult = max(0.3, 1.0 - (features.clarity_ordinal * 0.07))
    # Cut multipliers (Excellent=best); fancy shapes default to 0.85
    if features.cut_ordinal >= 0:
        cut_mult = max(0.6, 1.0 - (features.cut_ordinal * 0.08))
    else:
        cut_mult = 0.85
    # Shape premium (round brilliants command ~10% over average fancy)
    shape_mult = 1.10 if features.shape == "round_brilliant" else 1.0
    # Fluorescence discount (strong/very strong fluor reduces price)
    fluor_mult = max(0.85, 1.0 - (features.fluorescence_ordinal * 0.04))

    # Base: rough $/ct figure × carat^1.9 (super-linear for larger stones)
    base_per_ct = 3_000.0
    raw = base_per_ct * (features.carat_weight ** 1.9) * color_mult * clarity_mult * cut_mult * shape_mult * fluor_mult

    fair = round(max(raw, 100.0), 2)
    low  = round(fair * 0.60, 2)
    high = round(fair * 1.40, 2)

    drivers = [
        {"feature": "carat_weight", "direction": "up",
         "value": features.carat_weight, "importance": 0.45},
        {"feature": "color_ordinal", "direction": "up" if features.color_ordinal <= 5 else "down",
         "value": features.color_ordinal, "importance": 0.25},
        {"feature": "clarity_ordinal", "direction": "up" if features.clarity_ordinal <= 3 else "down",
         "value": features.clarity_ordinal, "importance": 0.15},
        {"feature": "cut_ordinal", "direction": "up" if features.cut_ordinal <= 1 else "down",
         "value": features.cut_ordinal, "importance": 0.10},
        {"feature": "shape", "direction": "up" if features.shape == "round_brilliant" else "neutral",
         "value": features.shape, "importance": 0.05},
    ]

    return PriceForecast(
        fair_price_usd=fair,
        confidence_low_usd=low,
        confidence_high_usd=high,
        confidence_level=CONFIDENCE_LEVEL,
        top_drivers=drivers,
        model_version="heuristic-fallback",
    )


class PricingModel:
    """
    Wraps three XGBoost regressors (point, low quantile, high quantile)
    plus a SHAP TreeExplainer for feature attribution.

    Instantiate once at service startup; call predict() per stone.
    Falls back to heuristic pricing if no checkpoint is available.
    """

    def __init__(
        self,
        checkpoint_path: Optional[str] = None,
        model_version: str = "heuristic-fallback",
    ):
        self.model_version = model_version
        self._point: Optional[object] = None
        self._low: Optional[object] = None
        self._high: Optional[object] = None
        self._explainer: Optional[object] = None
        self._use_heuristic = True

        if checkpoint_path and Path(checkpoint_path).exists():
            self._load(checkpoint_path)
        else:
            if checkpoint_path:
                logger.warning(
                    "Pricing checkpoint not found at %s — using heuristic fallback. "
                    "Run tools/train_pricing.py to train a model.",
                    checkpoint_path,
                )
            else:
                logger.info("No pricing checkpoint — using heuristic fallback.")

    def _load(self, path: str) -> None:
        if not _HAS_JOBLIB:
            logger.error("joblib not installed — cannot load pricing checkpoint")
            return
        try:
            bundle = joblib.load(path)
            self._point = bundle["point"]
            self._low   = bundle["low"]
            self._high  = bundle["high"]
            if _HAS_XGB:
                self._explainer = shap.TreeExplainer(self._point)
            self._use_heuristic = False
            self.model_version = bundle.get("model_version", self.model_version)
            logger.info(
                "Loaded pricing checkpoint from %s  version=%s  n_train=%s",
                path, self.model_version, bundle.get("n_train", "?"),
            )
        except Exception as exc:
            logger.error("Failed to load pricing checkpoint %s: %s — using heuristic", path, exc)

    def predict(self, features: StoneFeatures) -> PriceForecast:
        if self._use_heuristic:
            result = _heuristic_price(features)
            result.model_version = self.model_version
            return result
        return self._predict_xgb(features)

    def _predict_xgb(self, features: StoneFeatures) -> PriceForecast:
        vec = features.to_vector().reshape(1, -1)

        # XGBRegressor (sklearn API) takes numpy arrays directly.
        fair_price = float(self._point.predict(vec)[0])
        low_price  = float(self._low.predict(vec)[0])
        high_price = float(self._high.predict(vec)[0])

        # Ensure band is ordered and prices are positive.
        fair_price = max(fair_price, 1.0)
        low_price  = max(min(low_price, fair_price * 0.99), 1.0)
        high_price = max(high_price, fair_price * 1.01)

        # SHAP feature contributions.
        drivers: List[Dict] = []
        if self._explainer is not None:
            try:
                shap_values = self._explainer.shap_values(vec)
                contributions = shap_values[0]   # shape (n_features,)
                ranked_idx = np.argsort(np.abs(contributions))[::-1][:TOP_N_DRIVERS]
                for idx in ranked_idx:
                    val = float(contributions[idx])
                    drivers.append({
                        "feature": FEATURE_NAMES[idx],
                        "direction": "up" if val > 0 else "down",
                        "value": float(vec[0, idx]) if not np.isnan(vec[0, idx]) else None,
                        "importance": round(abs(val) / (np.sum(np.abs(contributions)) + 1e-9), 4),
                    })
            except Exception as exc:
                logger.warning("SHAP explanation failed: %s", exc)

        return PriceForecast(
            fair_price_usd=round(fair_price, 2),
            confidence_low_usd=round(low_price, 2),
            confidence_high_usd=round(high_price, 2),
            confidence_level=CONFIDENCE_LEVEL,
            top_drivers=drivers,
            model_version=self.model_version,
        )


# ── Checkpoint helpers ────────────────────────────────────────────────────────

def train_and_save(
    X: np.ndarray,
    y: np.ndarray,
    checkpoint_path: str,
    model_version: str,
    n_estimators: int = 400,
    max_depth: int = 5,
    learning_rate: float = 0.05,
) -> dict:
    """
    Train point + low/high quantile models and save a joblib bundle.
    Returns validation metrics dict (empty if no val split passed).

    Called from tools/train_pricing.py.
    """
    if not _HAS_XGB:
        raise RuntimeError("xgboost not installed")
    if not _HAS_JOBLIB:
        raise RuntimeError("joblib not installed")

    import datetime

    common = dict(
        n_estimators=n_estimators,
        max_depth=max_depth,
        learning_rate=learning_rate,
        subsample=0.8,
        colsample_bytree=0.8,
        tree_method="hist",
        random_state=42,
    )

    point_model = xgb.XGBRegressor(objective="reg:squarederror", **common)
    low_model   = xgb.XGBRegressor(objective="reg:quantileerror", quantile_alpha=0.05, **common)
    high_model  = xgb.XGBRegressor(objective="reg:quantileerror", quantile_alpha=0.95, **common)

    point_model.fit(X, y)
    low_model.fit(X, y)
    high_model.fit(X, y)

    bundle = {
        "point": point_model,
        "low":   low_model,
        "high":  high_model,
        "feature_names": FEATURE_NAMES,
        "model_version": model_version,
        "trained_at": datetime.datetime.utcnow().isoformat(),
        "n_train": len(y),
    }
    Path(checkpoint_path).parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, checkpoint_path)
    logger.info("Saved pricing checkpoint to %s  n_train=%d", checkpoint_path, len(y))
    return bundle
