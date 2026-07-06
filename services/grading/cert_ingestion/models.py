"""
Pydantic models for the certificate ingestion pipeline.

ParsedCert is the canonical output of the parser regardless of whether the
source was a PDF or structured JSON.  Confidence scores live alongside every
field so callers never have to inspect a separate structure to know whether
a value should be trusted.
"""
from __future__ import annotations

import enum
from datetime import date
from decimal import Decimal
from typing import Any, List, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class CertLab(str, enum.Enum):
    GIA = "GIA"
    IGI = "IGI"
    HRD = "HRD"
    AGS = "AGS"
    OTHER = "other"


class LabGrownFlag(str, enum.Enum):
    NATURAL = "natural"
    LAB_GROWN = "lab_grown"
    UNKNOWN = "unknown"


class FieldConfidence(str, enum.Enum):
    """
    HIGH   – field extracted from an unambiguous, well-structured region of the cert.
    MEDIUM – field found but source text had minor formatting issues or
             required normalization beyond simple mapping.
    LOW    – field found but source was ambiguous, OCR quality was poor,
             or the value doesn't match known valid ranges/scales.
    MISSING – field was not found at all in the cert.
    """
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    MISSING = "missing"


class FieldResult(BaseModel):
    """A single extracted field with its confidence annotation."""
    value: Optional[Any] = None
    confidence: FieldConfidence
    # Raw text as it appeared in the source before normalization.
    raw: Optional[str] = None
    # Human-readable explanation when confidence is LOW or MISSING.
    note: Optional[str] = None

    @property
    def is_low_confidence(self) -> bool:
        return self.confidence in (FieldConfidence.LOW, FieldConfidence.MISSING)


class ParsedCert(BaseModel):
    """
    Canonical output of the certificate parser.

    All numeric measurements are Decimal to avoid float rounding.
    Every field has a FieldResult so consumers can inspect confidence without
    parallel data structures.

    HARD RULE (FR-2 / CLAUDE.md): carat_weight.value must always come from
    the cert document or a physical scale.  If the cert doesn't contain a
    readable carat weight, carat_weight.confidence is set to MISSING and the
    field is added to low_confidence_fields.  The CV model must never supply
    this value — that invariant is enforced in writer.py.
    """
    lab: CertLab
    cert_number: FieldResult           # always required; parser raises if absent
    carat_weight: FieldResult          # HARD RULE: cert/scale only, never CV
    shape: FieldResult
    color_grade: FieldResult
    clarity_grade: FieldResult
    cut_grade: FieldResult             # present for round brilliants; MISSING for fancies
    polish: FieldResult
    symmetry: FieldResult
    fluorescence: FieldResult
    measurements_mm: FieldResult
    depth_pct: FieldResult
    table_pct: FieldResult
    issued_date: FieldResult
    lab_grown: LabGrownFlag = LabGrownFlag.UNKNOWN

    # Fields whose confidence is LOW or MISSING, collected for quick DB lookup.
    # Populated automatically by model_post_init.
    low_confidence_fields: List[str] = Field(default_factory=list)

    # Full raw extraction payload for debugging and retraining.
    raw_parsed: dict = Field(default_factory=dict)

    # Parser version — recorded in DB so extraction logic changes are traceable.
    parser_version: str = "1.0.0"

    def model_post_init(self, __context: Any) -> None:  # noqa: ANN401
        flagged: list[str] = []
        for name in (
            "cert_number", "carat_weight", "shape", "color_grade",
            "clarity_grade", "cut_grade", "polish", "symmetry",
            "fluorescence", "measurements_mm", "depth_pct",
            "table_pct", "issued_date",
        ):
            field_result: FieldResult = getattr(self, name)
            if field_result.is_low_confidence:
                flagged.append(name)
        self.low_confidence_fields = flagged


# ── GIA grading scale constants ───────────────────────────────────────────────

GIA_COLOR_GRADES = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
                    "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W",
                    "X", "Y", "Z"]

GIA_CLARITY_GRADES = ["FL", "IF", "VVS1", "VVS2", "VS1", "VS2",
                      "SI1", "SI2", "I1", "I2", "I3"]

GIA_CUT_GRADES = ["Excellent", "Very Good", "Good", "Fair", "Poor"]

IGI_COLOR_GRADES = GIA_COLOR_GRADES  # IGI uses the same D–Z scale
IGI_CLARITY_GRADES = GIA_CLARITY_GRADES
IGI_CUT_GRADES = ["Ideal", "Excellent", "Very Good", "Good", "Fair", "Poor"]

FLUORESCENCE_VALUES = ["None", "Faint", "Medium", "Strong", "Very Strong"]

KNOWN_SHAPES = [
    "Round", "Round Brilliant",
    "Princess", "Cushion", "Oval", "Emerald", "Pear",
    "Radiant", "Asscher", "Heart", "Marquise",
]

# Round brilliant is the only shape with a formal cut grade in GIA grading.
SHAPES_WITH_CUT_GRADE = {"Round", "Round Brilliant"}
