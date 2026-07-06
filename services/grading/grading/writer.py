"""
Persist a GradingResult to the grading_results table and emit analytics.

Responsibilities
----------------
1. Retire the previous current grading result for this stone (is_current = false).
2. INSERT the new grading_result row with source='cv_model'.
3. UPDATE stones.status from 'uploaded' → 'grading'.
4. INSERT a provenance_event of type 'grading_completed'.
5. INSERT an audit_log event of type 'grading_completed' (CLAUDE.md §11).

The is_current UNIQUE index (stone_id WHERE is_current=true) ensures only one
live result per stone at any time.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

import psycopg

from .pipeline import GradingResult

logger = logging.getLogger(__name__)


def write_grading_result(
    conn: psycopg.Connection,
    *,
    result: GradingResult,
    tenant_id: str,
    actor_id: Optional[str] = None,
    request_id: Optional[str] = None,
) -> str:
    """
    Persist grading result to DB and emit analytics.  Returns the new row id.

    Must be called inside an open transaction (caller manages commit/rollback).
    """
    stone_id = result.stone_id

    # ── 1. Retire any existing current result ────────────────────────────────
    conn.execute(
        "UPDATE grading_results SET is_current = false WHERE stone_id = %s AND is_current = true",
        (stone_id,),
    )

    # ── 2. Insert new result ──────────────────────────────────────────────────
    row = conn.execute(
        """
        INSERT INTO grading_results (
            stone_id, tenant_id, source, model_version,
            color_grade, clarity_grade, cut_grade,
            color_confidence, clarity_confidence, cut_confidence,
            color_disagrees_with_cert, clarity_disagrees_with_cert, cut_disagrees_with_cert,
            is_current, raw_output
        ) VALUES (
            %(stone_id)s, %(tenant_id)s, 'cv_model', %(model_version)s,
            %(color_grade)s, %(clarity_grade)s, %(cut_grade)s,
            %(color_conf)s, %(clarity_conf)s, %(cut_conf)s,
            %(color_disagrees)s, %(clarity_disagrees)s, %(cut_disagrees)s,
            true, %(raw_output)s
        )
        RETURNING id
        """,
        {
            "stone_id": stone_id,
            "tenant_id": tenant_id,
            "model_version": result.model_version,
            "color_grade": result.color.grade,
            "clarity_grade": result.clarity.grade,
            "cut_grade": result.cut.grade,
            "color_conf": result.color.confidence,
            "clarity_conf": result.clarity.confidence,
            "cut_conf": result.cut.confidence if not result.cut.not_applicable else None,
            "color_disagrees": result.color.disagrees_with_cert,
            "clarity_disagrees": result.clarity.disagrees_with_cert,
            "cut_disagrees": result.cut.disagrees_with_cert,
            "raw_output": json.dumps(result.raw_output),
        },
    ).fetchone()
    grading_id = str(row["id"])

    # ── 3. Advance stone status to 'grading' ─────────────────────────────────
    conn.execute(
        """
        UPDATE stones SET status = 'grading'
        WHERE id = %s AND status = 'uploaded'
        """,
        (stone_id,),
    )

    # ── 4. Provenance event ───────────────────────────────────────────────────
    conn.execute(
        """
        INSERT INTO provenance_events
            (occurred_at, stone_id, tenant_id, event_type, actor_id, payload)
        VALUES (NOW(), %s, %s, 'grading_completed', %s, %s)
        """,
        (
            stone_id, tenant_id, actor_id,
            json.dumps({
                "grading_result_id": grading_id,
                "model_version": result.model_version,
                "color_grade": result.color.grade,
                "color_confidence": result.color.confidence,
                "cut_grade": result.cut.grade,
                "cut_confidence": result.cut.confidence,
                "clarity_grade": result.clarity.grade,
                "clarity_confidence": result.clarity.confidence,
                "color_disagrees_with_cert": result.color.disagrees_with_cert,
                "cut_disagrees_with_cert": result.cut.disagrees_with_cert,
                "clarity_disagrees_with_cert": result.clarity.disagrees_with_cert,
                "n_frames_used": result.n_frames_used,
            }),
        ),
    )

    # ── 5. Analytics event (CLAUDE.md §11) ────────────────────────────────────
    conn.execute(
        """
        INSERT INTO audit_log
            (tenant_id, actor_id, event_type, entity_type, entity_id, payload, request_id)
        VALUES (%s, %s, 'grading_completed', 'stone', %s, %s, %s)
        """,
        (
            tenant_id, actor_id, stone_id,
            json.dumps({
                "grading_result_id": grading_id,
                "model_version": result.model_version,
                "n_frames": result.n_frames_used,
                "color_grade": result.color.grade,
                "color_confidence": result.color.confidence,
                "cut_grade": result.cut.grade,
                "cut_confidence": result.cut.confidence,
                "clarity_grade": result.clarity.grade,
                "clarity_confidence": result.clarity.confidence,
                "any_cert_disagreement": any([
                    result.color.disagrees_with_cert,
                    result.cut.disagrees_with_cert,
                    result.clarity.disagrees_with_cert,
                ]),
            }),
            request_id,
        ),
    )

    logger.info(
        "grading_completed  stone=%s  color=%s(%.2f)  cut=%s(%.2f)  clarity=%s(%.2f capped)",
        stone_id,
        result.color.grade, result.color.confidence,
        result.cut.grade, result.cut.confidence,
        result.clarity.grade, result.clarity.confidence,
    )

    return grading_id
