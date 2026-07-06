"""
Persist a ParsedCert to Postgres and emit the cert_ingested analytics event.

Responsibilities
----------------
1. Validate that carat_weight came from the cert (HARD RULE — FR-2).
2. UPDATE the certificates row created by the ingestion CLI (it already
   exists with lab + cert_number; we fill in the parsed fields).
3. UPDATE stones.status from 'uploaded' → 'uploaded' (no change) but set
   the cert-sourced fields (carat_weight, shape, lab_grown).
4. INSERT a provenance_event of type 'cert_ingested'.
5. INSERT an audit_log event of type 'cert_ingested'.
6. Emit the cert_ingested analytics event (Section 11 of CLAUDE.md).

The update is idempotent: running it twice on the same cert is safe — the
UNIQUE constraint on (lab, cert_number) prevents duplicate cert rows, and
the UPDATE is a no-op if the fields haven't changed.

Carat hard rule
---------------
If ParsedCert.carat_weight.confidence is MISSING, we write NULL and do NOT
advance the stone to 'grading'.  The grader must resolve it manually.
The field is included in low_confidence_fields so the UI can surface it.
Under no circumstances does the CV model supply the carat value.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

import psycopg
import psycopg.rows

from .models import FieldConfidence, ParsedCert
from .lookup import LookupResult

logger = logging.getLogger(__name__)


# ── Analytics event emission ──────────────────────────────────────────────────
# CLAUDE.md Section 11: instrument cert_ingested from day one.
# In Phase 1 this writes directly to the audit_log table.
# In Phase 3 this will also fan out to the analytics pipeline (GA4 server-side,
# warehouse event stream) via a thin adapter without changing this interface.

def _emit_cert_ingested_event(
    conn: psycopg.Connection,
    *,
    tenant_id: str,
    stone_id: str,
    cert_id: str,
    lab: str,
    cert_number: str,
    low_confidence_fields: list[str],
    lookup_matched: bool | None,
    actor_id: str | None,
    request_id: str | None,
) -> None:
    payload = {
        "cert_id": cert_id,
        "lab": lab,
        "cert_number": cert_number,
        "low_confidence_fields": low_confidence_fields,
        "lookup_matched": lookup_matched,
    }
    conn.execute(
        """
        INSERT INTO audit_log
            (tenant_id, actor_id, event_type, entity_type, entity_id, payload, request_id)
        VALUES
            (%s, %s, 'cert_ingested', 'stone', %s, %s, %s)
        """,
        (tenant_id, actor_id, stone_id, json.dumps(payload), request_id),
    )
    logger.info(
        "cert_ingested event emitted  stone=%s cert_number=%s lab=%s low_confidence=%s",
        stone_id, cert_number, lab, low_confidence_fields,
    )


# ── Main writer ───────────────────────────────────────────────────────────────

def write_parsed_cert(
    conn: psycopg.Connection,
    *,
    parsed: ParsedCert,
    stone_id: str,
    tenant_id: str,
    cert_s3_key: str,
    lookup_result: LookupResult | None = None,
    actor_id: str | None = None,
    request_id: str | None = None,
) -> str:
    """
    Persist parsed cert fields and emit analytics.  Returns the cert row id.

    Raises ValueError if the cert_number+lab doesn't match an existing
    certificates row (the ingestion CLI must have run first).

    HARD RULE: carat_weight is only written if it came from the cert
    (confidence != MISSING).  If MISSING, the field is left NULL and
    low_confidence_fields will contain 'carat_weight'.
    """
    # ── 0. Enforce the carat hard rule ────────────────────────────────────────
    carat_value: Decimal | None = None
    if parsed.carat_weight.confidence != FieldConfidence.MISSING:
        raw_val = parsed.carat_weight.value
        carat_value = Decimal(str(raw_val)) if raw_val is not None else None
    else:
        logger.warning(
            "carat_weight MISSING for stone %s cert %s — stone cannot advance to grading",
            stone_id, parsed.cert_number.value,
        )

    # ── 1. Fetch the existing cert row id ─────────────────────────────────────
    row = conn.execute(
        "SELECT id FROM certificates WHERE stone_id = %s AND lab = %s",
        (stone_id, parsed.lab.value),
    ).fetchone()

    if row is None:
        # Cert row may not exist yet if stone was created without one.
        # Insert a fresh row in that case.
        cert_id = _insert_cert_row(
            conn,
            parsed=parsed,
            stone_id=stone_id,
            tenant_id=tenant_id,
            cert_s3_key=cert_s3_key,
            carat_value=carat_value,
            lookup_result=lookup_result,
        )
    else:
        cert_id = str(row["id"])
        _update_cert_row(
            conn,
            cert_id=cert_id,
            parsed=parsed,
            carat_value=carat_value,
            lookup_result=lookup_result,
        )

    # ── 2. Back-fill stones table with cert-sourced fields ────────────────────
    _update_stone_from_cert(conn, stone_id=stone_id, parsed=parsed, carat_value=carat_value)

    # ── 3. Provenance event ───────────────────────────────────────────────────
    conn.execute(
        """
        INSERT INTO provenance_events
            (occurred_at, stone_id, tenant_id, event_type, actor_id, payload)
        VALUES
            (NOW(), %s, %s, 'cert_ingested', %s, %s)
        """,
        (
            stone_id, tenant_id, actor_id,
            json.dumps({
                "cert_id": cert_id,
                "cert_number": parsed.cert_number.value,
                "lab": parsed.lab.value,
                "low_confidence_fields": parsed.low_confidence_fields,
                "parser_version": parsed.parser_version,
                "lookup_matched": lookup_result.matched if lookup_result else None,
            }),
        ),
    )

    # ── 4. Analytics event (CLAUDE.md §11) ────────────────────────────────────
    _emit_cert_ingested_event(
        conn,
        tenant_id=tenant_id,
        stone_id=stone_id,
        cert_id=cert_id,
        lab=parsed.lab.value,
        cert_number=str(parsed.cert_number.value or ""),
        low_confidence_fields=parsed.low_confidence_fields,
        lookup_matched=lookup_result.matched if lookup_result else None,
        actor_id=actor_id,
        request_id=request_id,
    )

    return cert_id


def _coerce_str(field_result) -> str | None:
    """Return string value or None."""
    v = field_result.value if field_result else None
    return str(v) if v is not None else None


def _insert_cert_row(
    conn: psycopg.Connection,
    *,
    parsed: ParsedCert,
    stone_id: str,
    tenant_id: str,
    cert_s3_key: str,
    carat_value: Decimal | None,
    lookup_result: LookupResult | None,
) -> str:
    row = conn.execute(
        """
        INSERT INTO certificates (
            stone_id, tenant_id, lab, cert_number,
            carat_weight, shape, color_grade, clarity_grade, cut_grade,
            polish, symmetry, fluorescence,
            measurements_mm, depth_pct, table_pct,
            issued_date, lab_grown,
            low_confidence_fields, raw_parsed, cert_s3_key,
            verified_at, verification_notes
        ) VALUES (
            %(stone_id)s, %(tenant_id)s, %(lab)s, %(cert_number)s,
            %(carat_weight)s, %(shape)s, %(color_grade)s, %(clarity_grade)s, %(cut_grade)s,
            %(polish)s, %(symmetry)s, %(fluorescence)s,
            %(measurements_mm)s, %(depth_pct)s, %(table_pct)s,
            %(issued_date)s, %(lab_grown)s,
            %(low_confidence_fields)s, %(raw_parsed)s, %(cert_s3_key)s,
            %(verified_at)s, %(verification_notes)s
        )
        ON CONFLICT (stone_id) DO NOTHING
        RETURNING id
        """,
        _build_cert_params(
            parsed, stone_id, tenant_id, cert_s3_key,
            carat_value, lookup_result,
        ),
    ).fetchone()
    if row is None:
        # Already existed — fetch its id
        existing = conn.execute(
            "SELECT id FROM certificates WHERE stone_id = %s",
            (stone_id,),
        ).fetchone()
        return str(existing["id"])
    return str(row["id"])


def _update_cert_row(
    conn: psycopg.Connection,
    *,
    cert_id: str,
    parsed: ParsedCert,
    carat_value: Decimal | None,
    lookup_result: LookupResult | None,
) -> None:
    now = datetime.now(timezone.utc) if (lookup_result and lookup_result.matched) else None
    conn.execute(
        """
        UPDATE certificates SET
            carat_weight            = COALESCE(%(carat_weight)s, carat_weight),
            shape                   = %(shape)s,
            color_grade             = %(color_grade)s,
            clarity_grade           = %(clarity_grade)s,
            cut_grade               = %(cut_grade)s,
            polish                  = %(polish)s,
            symmetry                = %(symmetry)s,
            fluorescence            = %(fluorescence)s,
            measurements_mm         = %(measurements_mm)s,
            depth_pct               = %(depth_pct)s,
            table_pct               = %(table_pct)s,
            issued_date             = %(issued_date)s,
            lab_grown               = %(lab_grown)s,
            low_confidence_fields   = %(low_confidence_fields)s,
            raw_parsed              = %(raw_parsed)s,
            verified_at             = %(verified_at)s,
            verification_notes      = %(verification_notes)s
        WHERE id = %(cert_id)s
        """,
        {
            "cert_id": cert_id,
            "carat_weight": carat_value,
            "shape": _coerce_str(parsed.shape),
            "color_grade": _coerce_str(parsed.color_grade),
            "clarity_grade": _coerce_str(parsed.clarity_grade),
            "cut_grade": _coerce_str(parsed.cut_grade),
            "polish": _coerce_str(parsed.polish),
            "symmetry": _coerce_str(parsed.symmetry),
            "fluorescence": _coerce_str(parsed.fluorescence),
            "measurements_mm": _coerce_str(parsed.measurements_mm),
            "depth_pct": Decimal(str(parsed.depth_pct.value)) if parsed.depth_pct.value else None,
            "table_pct": Decimal(str(parsed.table_pct.value)) if parsed.table_pct.value else None,
            "issued_date": _coerce_str(parsed.issued_date),
            "lab_grown": parsed.lab_grown.value,
            "low_confidence_fields": parsed.low_confidence_fields or [],
            "raw_parsed": json.dumps(parsed.raw_parsed),
            "verified_at": now,
            "verification_notes": lookup_result.notes if lookup_result else None,
        },
    )


def _update_stone_from_cert(
    conn: psycopg.Connection,
    *,
    stone_id: str,
    parsed: ParsedCert,
    carat_value: Decimal | None,
) -> None:
    """
    Write cert-sourced fields back to the stones row.
    carat_weight on the stone comes only from the cert (HARD RULE).
    """
    # Map cert shape string to the stones.shape enum
    shape_str = _coerce_str(parsed.shape)
    shape_enum = _cert_shape_to_stone_enum(shape_str)

    conn.execute(
        """
        UPDATE stones SET
            carat_weight = COALESCE(%(carat_weight)s, carat_weight),
            shape        = COALESCE(%(shape)s::stone_shape, shape),
            lab_grown    = %(lab_grown)s::lab_grown_flag
        WHERE id = %(stone_id)s
        """,
        {
            "stone_id": stone_id,
            "carat_weight": carat_value,
            "shape": shape_enum,
            "lab_grown": parsed.lab_grown.value,
        },
    )


def _cert_shape_to_stone_enum(shape: str | None) -> str | None:
    if not shape:
        return None
    mapping = {
        "Round Brilliant": "round_brilliant",
        "Round": "round_brilliant",
        "Princess": "princess",
        "Cushion": "cushion",
        "Oval": "oval",
        "Emerald": "emerald",
        "Pear": "pear",
        "Radiant": "radiant",
        "Asscher": "asscher",
        "Heart": "heart",
        "Marquise": "marquise",
    }
    return mapping.get(shape, "other")


def _build_cert_params(
    parsed: ParsedCert,
    stone_id: str,
    tenant_id: str,
    cert_s3_key: str,
    carat_value: Decimal | None,
    lookup_result: LookupResult | None,
) -> dict[str, Any]:
    verified_at = None
    if lookup_result and lookup_result.matched:
        verified_at = datetime.now(timezone.utc)
    return {
        "stone_id": stone_id,
        "tenant_id": tenant_id,
        "lab": parsed.lab.value,
        "cert_number": str(parsed.cert_number.value or ""),
        "carat_weight": carat_value,
        "shape": _coerce_str(parsed.shape),
        "color_grade": _coerce_str(parsed.color_grade),
        "clarity_grade": _coerce_str(parsed.clarity_grade),
        "cut_grade": _coerce_str(parsed.cut_grade),
        "polish": _coerce_str(parsed.polish),
        "symmetry": _coerce_str(parsed.symmetry),
        "fluorescence": _coerce_str(parsed.fluorescence),
        "measurements_mm": _coerce_str(parsed.measurements_mm),
        "depth_pct": Decimal(str(parsed.depth_pct.value)) if parsed.depth_pct.value else None,
        "table_pct": Decimal(str(parsed.table_pct.value)) if parsed.table_pct.value else None,
        "issued_date": _coerce_str(parsed.issued_date),
        "lab_grown": parsed.lab_grown.value,
        "low_confidence_fields": parsed.low_confidence_fields or [],
        "raw_parsed": json.dumps(parsed.raw_parsed),
        "cert_s3_key": cert_s3_key,
        "verified_at": verified_at,
        "verification_notes": lookup_result.notes if lookup_result else None,
    }
