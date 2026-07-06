"""
Feature engineering for the XGBoost price forecasting model.

All grade strings are encoded to numeric ordinals so XGBoost sees monotonic
relationships (D=0 is "better than" E=1 on color, FL=0 > IF=1 > ... on clarity).
Shape is one-hot encoded so the model can learn shape-specific price multipliers
without imposing an arbitrary ordering.

Feature vector layout (order matters — must match training and inference):
  carat_weight        float   — from cert/scale (FR-2 hard rule)
  color_ordinal       int     — D=0 … Z=22 (lower = better = more expensive)
  clarity_ordinal     int     — FL=0 … I3=10 (lower = better)
  cut_ordinal         int     — Excellent=0 … Poor=4 (lower = better); -1 if N/A
  fluorescence_ordinal int    — None=0, Faint=1, Medium=2, Strong=3, Very Strong=4
  depth_pct           float   — e.g. 61.5
  table_pct           float   — e.g. 57.0
  length_mm           float
  width_mm            float
  depth_mm            float
  shape_<name>        0/1     — one-hot for each stone_shape enum value

Absent optional measurements default to their column mean (imputed at training
time) or a sentinel value of -1 (flagged separately).  The model is trained with
XGBoost's native missing-value handling (use_label_encoder=False, tree_method=hist)
so NaN passes through safely.

Per-shape models (future)
-------------------------
With >500 stones per shape, split training by shape and train separate models.
Flag this as TODO until the data volume justifies it.  The feature schema is
designed so the shape one-hot can be dropped without other changes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np

# ── Grade ordinal maps ────────────────────────────────────────────────────────

COLOR_ORDINAL: Dict[str, int] = {
    g: i for i, g in enumerate([
        "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
        "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
    ])
}

CLARITY_ORDINAL: Dict[str, int] = {
    g: i for i, g in enumerate([
        "FL", "IF", "VVS1", "VVS2", "VS1", "VS2", "SI1", "SI2", "I1", "I2", "I3",
    ])
}

CUT_ORDINAL: Dict[str, int] = {
    g: i for i, g in enumerate(["Excellent", "Very Good", "Good", "Fair", "Poor"])
}

FLUORESCENCE_ORDINAL: Dict[str, int] = {
    "None": 0, "Faint": 1, "Medium": 2, "Strong": 3, "Very Strong": 4,
}

SHAPES: List[str] = [
    "round_brilliant", "princess", "cushion", "oval", "emerald",
    "pear", "radiant", "asscher", "heart", "marquise", "other",
]

# Canonical feature names in vector order.
FEATURE_NAMES: List[str] = (
    ["carat_weight", "color_ordinal", "clarity_ordinal", "cut_ordinal",
     "fluorescence_ordinal", "depth_pct", "table_pct",
     "length_mm", "width_mm", "depth_mm"]
    + [f"shape_{s}" for s in SHAPES]
)


@dataclass
class StoneFeatures:
    """
    Parsed, validated feature set for one stone ready for model inference.
    Absent optional fields are NaN so XGBoost handles them natively.
    """
    carat_weight: float
    color_ordinal: int
    clarity_ordinal: int
    cut_ordinal: int             # -1 encodes as NaN for fancy shapes
    fluorescence_ordinal: int
    depth_pct: float             # NaN if absent
    table_pct: float             # NaN if absent
    length_mm: float             # NaN if absent
    width_mm: float              # NaN if absent
    depth_mm: float              # NaN if absent
    shape: str                   # raw stone_shape enum value

    def to_vector(self) -> np.ndarray:
        """Return a 1-D float64 array in FEATURE_NAMES order."""
        # Shape one-hot
        shape_ohe = [1.0 if s == self.shape else 0.0 for s in SHAPES]

        vec = [
            float(self.carat_weight),
            float(self.color_ordinal),
            float(self.clarity_ordinal),
            float(self.cut_ordinal) if self.cut_ordinal >= 0 else np.nan,
            float(self.fluorescence_ordinal),
            float(self.depth_pct) if not np.isnan(self.depth_pct) else np.nan,
            float(self.table_pct) if not np.isnan(self.table_pct) else np.nan,
            float(self.length_mm) if not np.isnan(self.length_mm) else np.nan,
            float(self.width_mm) if not np.isnan(self.width_mm) else np.nan,
            float(self.depth_mm) if not np.isnan(self.depth_mm) else np.nan,
        ] + shape_ohe

        return np.array(vec, dtype=np.float64)

    def to_dict(self) -> dict:
        """Serialisable snapshot for storage in input_snapshot column."""
        return {
            "carat_weight": self.carat_weight,
            "color_ordinal": self.color_ordinal,
            "clarity_ordinal": self.clarity_ordinal,
            "cut_ordinal": self.cut_ordinal,
            "fluorescence_ordinal": self.fluorescence_ordinal,
            "depth_pct": None if np.isnan(self.depth_pct) else self.depth_pct,
            "table_pct": None if np.isnan(self.table_pct) else self.table_pct,
            "length_mm": None if np.isnan(self.length_mm) else self.length_mm,
            "width_mm": None if np.isnan(self.width_mm) else self.width_mm,
            "depth_mm": None if np.isnan(self.depth_mm) else self.depth_mm,
            "shape": self.shape,
        }


def build_features(
    *,
    carat_weight: float,
    color_grade: str,
    clarity_grade: str,
    cut_grade: Optional[str],
    fluorescence: Optional[str] = None,
    depth_pct: Optional[float] = None,
    table_pct: Optional[float] = None,
    measurements_mm: Optional[str] = None,
    shape: Optional[str] = None,
) -> StoneFeatures:
    """
    Build a StoneFeatures from grade strings and raw measurements.

    measurements_mm format: "L x W x D" e.g. "6.41 x 6.45 x 3.97"
    Unknown grades fall back to the median ordinal to avoid poisoning the model.
    """
    color_ord = COLOR_ORDINAL.get(color_grade, 11)     # default to ~M (midpoint)
    clarity_ord = CLARITY_ORDINAL.get(clarity_grade, 5) # default to VS2
    cut_ord = CUT_ORDINAL.get(cut_grade, -1) if cut_grade else -1
    fluor_ord = FLUORESCENCE_ORDINAL.get(fluorescence or "None", 0)

    l_mm = w_mm = d_mm = np.nan
    if measurements_mm:
        parts = [p.strip() for p in measurements_mm.replace("×", "x").split("x")]
        try:
            if len(parts) >= 3:
                l_mm, w_mm, d_mm = float(parts[0]), float(parts[1]), float(parts[2])
            elif len(parts) == 1:
                l_mm = float(parts[0])
        except (ValueError, IndexError):
            pass

    return StoneFeatures(
        carat_weight=float(carat_weight),
        color_ordinal=color_ord,
        clarity_ordinal=clarity_ord,
        cut_ordinal=cut_ord,
        fluorescence_ordinal=fluor_ord,
        depth_pct=float(depth_pct) if depth_pct is not None else np.nan,
        table_pct=float(table_pct) if table_pct is not None else np.nan,
        length_mm=l_mm,
        width_mm=w_mm,
        depth_mm=d_mm,
        shape=shape or "other",
    )
