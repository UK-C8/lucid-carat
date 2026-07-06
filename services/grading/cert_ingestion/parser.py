"""
Certificate parser for GIA and IGI lab certificates.

Input:  a PDF file path  OR  a pre-extracted dict of raw text fields
        (the latter is used for structured IGI JSON exports and in tests).

Output: ParsedCert — every field annotated with a FieldConfidence level.
        Fields that are absent or ambiguous are set to confidence=LOW/MISSING
        and added to ParsedCert.low_confidence_fields.  Nothing is silently
        dropped or guessed.

Design principles
-----------------
- Carat weight MUST come from the cert.  If it cannot be reliably extracted,
  carat_weight.confidence = MISSING.  The caller (writer.py) will refuse to
  mark the stone ready-for-grading until this is resolved by a human.
- Confidence is set conservatively: prefer MEDIUM/LOW over HIGH when there
  is any ambiguity — a flagged field is far less dangerous than a silently
  wrong one.
- Normalization (e.g. "EX" → "Excellent") is recorded in FieldResult.raw so
  the original text is always preserved.
"""
from __future__ import annotations

import io
import re
import logging
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from .models import (
    CertLab, FieldConfidence, FieldResult, LabGrownFlag,
    ParsedCert,
    GIA_COLOR_GRADES, GIA_CLARITY_GRADES, GIA_CUT_GRADES,
    IGI_COLOR_GRADES, IGI_CLARITY_GRADES, IGI_CUT_GRADES,
    FLUORESCENCE_VALUES, KNOWN_SHAPES, SHAPES_WITH_CUT_GRADE,
)

logger = logging.getLogger(__name__)

# ── Optional PDF extraction (pdfplumber) ─────────────────────────────────────
try:
    import pdfplumber  # type: ignore
    _PDF_AVAILABLE = True
except ImportError:
    _PDF_AVAILABLE = False
    logger.warning(
        "pdfplumber not installed — PDF parsing disabled. "
        "Install with: pip install pdfplumber"
    )


# ── Normalization maps ────────────────────────────────────────────────────────

_CUT_ALIASES: dict[str, str] = {
    "EX": "Excellent", "EXCELLENT": "Excellent",
    "VG": "Very Good",  "VERY GOOD": "Very Good",
    "GD": "Good",       "GOOD": "Good",
    "FR": "Fair",       "FAIR": "Fair",
    "PR": "Poor",       "POOR": "Poor",
    "ID": "Ideal",      "IDEAL": "Ideal",   # IGI
}

_FLUOR_ALIASES: dict[str, str] = {
    "NON": "None", "NONE": "None", "NIL": "None", "N": "None",
    "FNT": "Faint", "FAINT": "Faint", "SLT": "Faint",
    "MED": "Medium", "MEDIUM": "Medium",
    "STG": "Strong", "STRONG": "Strong",
    "VST": "Very Strong", "VERY STRONG": "Very Strong",
}

_SHAPE_ALIASES: dict[str, str] = {
    "RD": "Round Brilliant", "BR": "Round Brilliant",
    "ROUND BRILLIANT": "Round Brilliant",
    "ROUND": "Round Brilliant",
    "PR": "Princess", "PRINCESS": "Princess",
    "CU": "Cushion", "CUSHION": "Cushion",
    "OV": "Oval", "OVAL": "Oval",
    "EM": "Emerald", "EMERALD": "Emerald",
    "PE": "Pear", "PEAR": "Pear",
    "RA": "Radiant", "RADIANT": "Radiant",
    "AS": "Asscher", "ASSCHER": "Asscher",
    "HT": "Heart", "HEART": "Heart",
    "MQ": "Marquise", "MARQUISE": "Marquise",
}

_LAB_GROWN_MARKERS = [
    "laboratory grown", "lab grown", "lab-grown",
    "laboratory-grown", "synthetic", "cvd", "hpht",
    "man-made", "man made",
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make(
    value: Any,
    confidence: FieldConfidence,
    raw: str | None = None,
    note: str | None = None,
) -> FieldResult:
    return FieldResult(value=value, confidence=confidence, raw=raw, note=note)


def _missing(field_name: str) -> FieldResult:
    return FieldResult(
        value=None,
        confidence=FieldConfidence.MISSING,
        note=f"{field_name} not found in cert",
    )


def _parse_carat(raw: str) -> FieldResult:
    """
    HARD RULE (FR-2): carat_weight comes from the cert only.
    Returns LOW confidence if the value is outside plausible bounds (0.01–20 ct)
    rather than silently accepting a misparse.
    """
    if not raw:
        return _missing("carat_weight")
    cleaned = raw.strip().replace(",", ".").split()[0]  # "1.01 ct" → "1.01"
    try:
        value = Decimal(cleaned)
    except InvalidOperation:
        return FieldResult(
            value=None,
            confidence=FieldConfidence.LOW,
            raw=raw,
            note=f"Could not parse carat value from: {raw!r}",
        )
    if not (Decimal("0.01") <= value <= Decimal("20.00")):
        return FieldResult(
            value=value,
            confidence=FieldConfidence.LOW,
            raw=raw,
            note=f"Carat {value} is outside expected range 0.01–20.00 ct",
        )
    return _make(value, FieldConfidence.HIGH, raw=raw)


def _parse_color(raw: str, lab: CertLab) -> FieldResult:
    if not raw:
        return _missing("color_grade")
    normalized = raw.strip().upper()
    valid = GIA_COLOR_GRADES if lab != CertLab.IGI else IGI_COLOR_GRADES
    if normalized in valid:
        confidence = FieldConfidence.HIGH
    else:
        # Try to strip trailing descriptors like "G (Near Colorless)"
        match = re.match(r"^([A-Z]{1,2})", normalized)
        if match and match.group(1) in valid:
            normalized = match.group(1)
            confidence = FieldConfidence.MEDIUM
        else:
            return FieldResult(
                value=normalized, confidence=FieldConfidence.LOW, raw=raw,
                note=f"Color grade {raw!r} not in {lab.value} scale",
            )
    return _make(normalized, confidence, raw=raw)


def _parse_clarity(raw: str, lab: CertLab) -> FieldResult:
    if not raw:
        return _missing("clarity_grade")
    normalized = raw.strip().upper().replace(" ", "")
    valid = GIA_CLARITY_GRADES if lab != CertLab.IGI else IGI_CLARITY_GRADES
    # Map common variants
    aliases = {"VVS-1": "VVS1", "VVS-2": "VVS2", "VS-1": "VS1", "VS-2": "VS2",
               "SI-1": "SI1",  "SI-2": "SI2",  "I-1": "I1", "I-2": "I2", "I-3": "I3"}
    normalized = aliases.get(normalized, normalized)
    if normalized in valid:
        return _make(normalized, FieldConfidence.HIGH, raw=raw)
    return FieldResult(
        value=normalized, confidence=FieldConfidence.LOW, raw=raw,
        note=f"Clarity grade {raw!r} not in {lab.value} scale",
    )


def _parse_cut(raw: str | None, shape: str | None, lab: CertLab) -> FieldResult:
    """Cut grade only exists for round brilliants."""
    shape_norm = (shape or "").upper().strip()
    is_round = any(s.upper() in shape_norm or shape_norm in s.upper()
                   for s in SHAPES_WITH_CUT_GRADE)

    if not is_round:
        return FieldResult(
            value=None,
            confidence=FieldConfidence.MISSING,
            note="Cut grade not applicable for fancy shapes",
        )
    if not raw:
        return FieldResult(
            value=None,
            confidence=FieldConfidence.MISSING,
            note="Cut grade not found in cert",
        )
    normalized = _CUT_ALIASES.get(raw.strip().upper(), raw.strip())
    valid = GIA_CUT_GRADES if lab != CertLab.IGI else IGI_CUT_GRADES
    if normalized in valid:
        return _make(normalized, FieldConfidence.HIGH, raw=raw)
    return FieldResult(
        value=normalized, confidence=FieldConfidence.LOW, raw=raw,
        note=f"Cut grade {raw!r} not recognized for {lab.value}",
    )


def _parse_polish_symmetry(raw: str | None, field_name: str) -> FieldResult:
    if not raw:
        return _missing(field_name)
    normalized = _CUT_ALIASES.get(raw.strip().upper(), raw.strip())
    if normalized in GIA_CUT_GRADES:
        return _make(normalized, FieldConfidence.HIGH, raw=raw)
    return FieldResult(
        value=normalized, confidence=FieldConfidence.MEDIUM, raw=raw,
        note=f"{field_name} value {raw!r} not in standard scale",
    )


def _parse_fluorescence(raw: str | None) -> FieldResult:
    if not raw:
        return _missing("fluorescence")
    normalized = _FLUOR_ALIASES.get(raw.strip().upper(), raw.strip())
    if normalized in FLUORESCENCE_VALUES:
        return _make(normalized, FieldConfidence.HIGH, raw=raw)
    # Accept if it contains a known value as a substring
    for known in FLUORESCENCE_VALUES:
        if known.upper() in raw.upper():
            return _make(known, FieldConfidence.MEDIUM, raw=raw,
                         note=f"Inferred from partial match in {raw!r}")
    return FieldResult(
        value=normalized, confidence=FieldConfidence.LOW, raw=raw,
        note=f"Fluorescence value {raw!r} not recognized",
    )


def _parse_shape(raw: str | None) -> FieldResult:
    if not raw:
        return _missing("shape")
    normalized = _SHAPE_ALIASES.get(raw.strip().upper(), raw.strip())
    if any(normalized.lower() == s.lower() for s in KNOWN_SHAPES):
        return _make(normalized, FieldConfidence.HIGH, raw=raw)
    # Partial match
    for known in KNOWN_SHAPES:
        if known.lower() in raw.lower():
            return _make(known, FieldConfidence.MEDIUM, raw=raw,
                         note=f"Shape inferred from partial match in {raw!r}")
    return FieldResult(
        value=normalized, confidence=FieldConfidence.LOW, raw=raw,
        note=f"Shape {raw!r} not in known shapes list",
    )


def _parse_measurements(raw: str | None) -> FieldResult:
    """
    GIA format: "6.42 - 6.46 x 3.98" (length-width × depth in mm).
    Validate the basic pattern; LOW confidence if it doesn't match.
    """
    if not raw:
        return _missing("measurements_mm")
    pattern = r"[\d.]+\s*[-–x×]\s*[\d.]+\s*[x×]\s*[\d.]+"
    if re.search(pattern, raw, re.IGNORECASE):
        return _make(raw.strip(), FieldConfidence.HIGH, raw=raw)
    # Single dimension — plausible for some cert formats
    if re.match(r"^[\d.]+$", raw.strip()):
        return _make(raw.strip(), FieldConfidence.MEDIUM, raw=raw,
                     note="Single dimension; expected L-W×D format")
    return FieldResult(
        value=raw.strip(), confidence=FieldConfidence.LOW, raw=raw,
        note=f"Measurements format not recognized: {raw!r}",
    )


def _parse_pct(raw: str | None, field_name: str) -> FieldResult:
    if not raw:
        return _missing(field_name)
    cleaned = raw.strip().replace("%", "").strip()
    try:
        value = Decimal(cleaned)
    except InvalidOperation:
        return FieldResult(
            value=None, confidence=FieldConfidence.LOW, raw=raw,
            note=f"Could not parse percentage for {field_name}: {raw!r}",
        )
    if not (Decimal("0") < value <= Decimal("100")):
        return FieldResult(
            value=value, confidence=FieldConfidence.LOW, raw=raw,
            note=f"{field_name} value {value} outside 0–100% range",
        )
    return _make(value, FieldConfidence.HIGH, raw=raw)


def _parse_date(raw: str | None) -> FieldResult:
    if not raw:
        return _missing("issued_date")
    from datetime import date as dt_date
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%d/%m/%Y", "%m/%d/%Y",
                "%Y-%m-%d", "%d %b %Y", "%B %Y", "%b %Y"):
        try:
            import datetime
            parsed = datetime.datetime.strptime(raw.strip(), fmt).date()
            # Month+year only (no day) → MEDIUM: value is technically valid but imprecise
            has_day = any(token in fmt for token in ("%d",))
            confidence = FieldConfidence.HIGH if has_day else FieldConfidence.MEDIUM
            return _make(parsed.isoformat(), confidence, raw=raw)
        except ValueError:
            continue
    # If only a 4-digit year is present, accept with MEDIUM confidence
    year_match = re.fullmatch(r"(20[0-2]\d)", raw.strip())
    if year_match:
        return FieldResult(
            value=raw.strip(), confidence=FieldConfidence.MEDIUM, raw=raw,
            note="Only year extracted from date field",
        )
    return FieldResult(
        value=raw.strip(), confidence=FieldConfidence.LOW, raw=raw,
        note=f"Could not parse date: {raw!r}",
    )


def _detect_lab_grown(text: str) -> LabGrownFlag:
    lower = text.lower()
    if any(marker in lower for marker in _LAB_GROWN_MARKERS):
        return LabGrownFlag.LAB_GROWN
    if "natural" in lower or "mined" in lower:
        return LabGrownFlag.NATURAL
    return LabGrownFlag.UNKNOWN


def _detect_cert_number(raw: str | None, lab: CertLab) -> FieldResult:
    if not raw:
        return _missing("cert_number")
    cleaned = raw.strip().replace(" ", "").replace("-", "")
    # GIA cert numbers are 10 digits
    if lab == CertLab.GIA:
        if re.fullmatch(r"\d{10}", cleaned):
            return _make(cleaned, FieldConfidence.HIGH, raw=raw)
        if re.fullmatch(r"\d{7,12}", cleaned):
            return FieldResult(
                value=cleaned, confidence=FieldConfidence.MEDIUM, raw=raw,
                note=f"GIA cert numbers are 10 digits; got {len(cleaned)}",
            )
    # IGI cert numbers are 9–12 digits or start with IGI prefix
    elif lab == CertLab.IGI:
        cleaned_igi = re.sub(r"^IGI", "", cleaned, flags=re.IGNORECASE)
        if re.fullmatch(r"\d{9,12}", cleaned_igi):
            return _make(cleaned_igi, FieldConfidence.HIGH, raw=raw)
    # Fallback: any non-empty string is accepted with MEDIUM confidence
    if cleaned:
        return FieldResult(
            value=cleaned, confidence=FieldConfidence.MEDIUM, raw=raw,
            note=f"Cert number format not fully validated for {lab.value}",
        )
    return _missing("cert_number")


# ── PDF extraction ─────────────────────────────────────────────────────────────

# GIA Report layout field labels — these appear as text directly above or
# beside the value in the PDF.  The list covers both the current layout and
# common older formats.
_GIA_FIELD_LABELS: dict[str, str] = {
    "Report Number":       "cert_number",
    "GIA Report Number":   "cert_number",
    "Carat Weight":        "carat_weight",
    "Color Grade":         "color_grade",
    "Colour Grade":        "color_grade",
    "Clarity Grade":       "clarity_grade",
    "Cut Grade":           "cut_grade",
    "Polish":              "polish",
    "Symmetry":            "symmetry",
    "Fluorescence":        "fluorescence",
    "Measurements":        "measurements_mm",
    "Depth":               "depth_pct",
    "Table":               "table_pct",
    "Shape and Cutting Style": "shape",
    "Shape":               "shape",
    "Report Date":         "issued_date",
    "Date":                "issued_date",
}

_IGI_FIELD_LABELS: dict[str, str] = {
    "Report No":           "cert_number",
    "Certificate Number":  "cert_number",
    "Carat Weight":        "carat_weight",
    "Color":               "color_grade",
    "Clarity":             "clarity_grade",
    "Cut":                 "cut_grade",
    "Polish":              "polish",
    "Symmetry":            "symmetry",
    "Fluorescence":        "fluorescence",
    "Measurements":        "measurements_mm",
    "Depth %":             "depth_pct",
    "Table %":             "table_pct",
    "Shape":               "shape",
    "Date":                "issued_date",
    "Report Date":         "issued_date",
}


def _extract_fields_from_pdf_text(
    pages_text: list[str], lab: CertLab
) -> dict[str, str]:
    """
    Extract raw field values from PDF text using label proximity heuristic.

    Strategy: scan all text lines; when a known label is found, the next
    non-empty line (or the remainder of the same line after a colon) is
    the value.  Confidence scoring happens downstream in the individual
    field parsers, not here.
    """
    full_text = "\n".join(pages_text)
    field_labels = _GIA_FIELD_LABELS if lab == CertLab.GIA else _IGI_FIELD_LABELS
    extracted: dict[str, str] = {}

    lines = [l.strip() for l in full_text.splitlines() if l.strip()]

    for i, line in enumerate(lines):
        for label, field_name in field_labels.items():
            if field_name in extracted:
                continue
            if label.lower() in line.lower():
                # Value may be on the same line after a colon
                colon_split = re.split(r":\s*", line, maxsplit=1)
                if len(colon_split) == 2 and colon_split[1].strip():
                    extracted[field_name] = colon_split[1].strip()
                elif i + 1 < len(lines):
                    candidate = lines[i + 1]
                    # Skip if the next line is itself a label
                    if not any(lbl.lower() in candidate.lower()
                               for lbl in field_labels):
                        extracted[field_name] = candidate
                break

    return extracted


def _extract_fields_from_pdf(path: Path, lab: CertLab) -> tuple[dict[str, str], str]:
    """
    Open the PDF with pdfplumber and extract field text.
    Returns (extracted_fields_dict, full_text_for_lab_grown_detection).
    """
    if not _PDF_AVAILABLE:
        raise RuntimeError(
            "pdfplumber is required for PDF parsing. "
            "Install it: pip install pdfplumber"
        )

    pages_text: list[str] = []
    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages:
            text = page.extract_text(x_tolerance=2, y_tolerance=2)
            if text:
                pages_text.append(text)

    full_text = "\n".join(pages_text)
    extracted = _extract_fields_from_pdf_text(pages_text, lab)
    return extracted, full_text


# ── Public API ────────────────────────────────────────────────────────────────

def parse_cert_from_dict(
    fields: dict[str, str | None],
    lab: CertLab,
    parser_version: str = "1.0.0",
) -> ParsedCert:
    """
    Parse a cert from a pre-extracted field dict.
    Used for structured IGI JSON exports and in tests.

    Expected keys (all optional except lab and cert_number):
        cert_number, carat_weight, shape, color_grade, clarity_grade,
        cut_grade, polish, symmetry, fluorescence, measurements_mm,
        depth_pct, table_pct, issued_date, full_text (for lab_grown detection)
    """
    full_text = fields.get("full_text", "") or ""

    shape_result = _parse_shape(fields.get("shape"))
    shape_str = (shape_result.value or "") if shape_result.value else ""

    raw_parsed: dict[str, Any] = {
        "source": "structured_dict",
        "lab": lab.value,
        "raw_fields": {k: v for k, v in fields.items() if k != "full_text"},
    }

    parsed = ParsedCert(
        lab=lab,
        cert_number=_detect_cert_number(fields.get("cert_number"), lab),
        carat_weight=_parse_carat(fields.get("carat_weight") or ""),
        shape=shape_result,
        color_grade=_parse_color(fields.get("color_grade") or "", lab),
        clarity_grade=_parse_clarity(fields.get("clarity_grade") or "", lab),
        cut_grade=_parse_cut(fields.get("cut_grade"), shape_str, lab),
        polish=_parse_polish_symmetry(fields.get("polish"), "polish"),
        symmetry=_parse_polish_symmetry(fields.get("symmetry"), "symmetry"),
        fluorescence=_parse_fluorescence(fields.get("fluorescence")),
        measurements_mm=_parse_measurements(fields.get("measurements_mm")),
        depth_pct=_parse_pct(fields.get("depth_pct"), "depth_pct"),
        table_pct=_parse_pct(fields.get("table_pct"), "table_pct"),
        issued_date=_parse_date(fields.get("issued_date")),
        lab_grown=_detect_lab_grown(full_text),
        raw_parsed=raw_parsed,
        parser_version=parser_version,
    )
    return parsed


def parse_cert_from_pdf(
    path: Path | str,
    lab: CertLab,
    parser_version: str = "1.0.0",
) -> ParsedCert:
    """
    Parse a GIA or IGI certificate PDF.
    Extracts text via pdfplumber, then runs the same field parsers as
    parse_cert_from_dict.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Cert PDF not found: {path}")

    extracted, full_text = _extract_fields_from_pdf(path, lab)

    # Inject full_text so lab_grown detection can scan the whole cert
    extracted["full_text"] = full_text

    result = parse_cert_from_dict(extracted, lab, parser_version)

    # Override source in raw_parsed
    result.raw_parsed["source"] = "pdf"
    result.raw_parsed["pdf_path"] = str(path)
    result.raw_parsed["extracted_fields"] = {
        k: v for k, v in extracted.items() if k != "full_text"
    }
    return result
