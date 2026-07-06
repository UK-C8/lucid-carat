"""
Human-in-the-loop override workflow (FR-4).

A grader can either confirm a CV-predicted grade (accept as-is) or override it
with a corrected value.  Every action is permanently recorded in grading_overrides
and reflected on the stones row.

Status transition contract
--------------------------
The stone cannot advance from 'grading' → 'priced' until all three dimensions
have been actioned (confirmed or overridden).  This is enforced at two layers:

  1. DB CHECK constraint  priced_requires_confirmed_grades  (V013 migration):
     attempting UPDATE stones SET status='priced' while any confirmed_* column
     is NULL will raise a CheckViolation — the DB itself rejects it.

  2. Application gate in advance_to_priced() below:
     we check the confirmed columns and raise OverrideIncompleteError before
     even issuing the UPDATE, giving callers a clear structured error rather
     than letting them hit the raw DB constraint.

The double layer means: even if application code has a bug and calls the raw
UPDATE directly, the DB will still refuse it.

Override log immutability
-------------------------
grading_overrides has UPDATE and DELETE triggers that raise an exception.
The application never issues UPDATE/DELETE on that table — this module only
ever INSERTs.  Immutability is verifiable: attempt psql DELETE/UPDATE and
observe the exception.

Terminology
-----------
  confirm  — grader agrees with the CV prediction; new_grade == CV grade.
  override — grader corrects the CV prediction; new_grade != CV grade,
             override_reason is mandatory.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Optional

import psycopg
import psycopg.rows

from .models import (
    COLOR_GRADES,
    CUT_GRADES,
    CLARITY_GRADES,
)

logger = logging.getLogger(__name__)

# Valid grades per dimension.  Used to reject nonsense override values.
_VALID_GRADES: dict[str, list[str]] = {
    "color":   COLOR_GRADES,
    "clarity": CLARITY_GRADES,
    "cut":     CUT_GRADES,
}

# The three dimensions that must all be actioned before advancing to 'priced'.
ALL_DIMENSIONS = frozenset({"color", "clarity", "cut"})


# ── Errors ────────────────────────────────────────────────────────────────────

class OverrideError(Exception):
    """Base class for override business-rule violations."""


class InvalidGradeError(OverrideError):
    """Supplied grade is not a valid value for its dimension."""


class StoneNotGradingError(OverrideError):
    """Stone is not in 'grading' status — override not permitted."""


class OverrideIncompleteError(OverrideError):
    """Not all dimensions have been confirmed/overridden yet."""
    def __init__(self, missing: set[str]):
        self.missing = missing
        super().__init__(
            f"Cannot advance to 'priced': missing confirmations for {sorted(missing)}"
        )


class NoCurrentGradingResultError(OverrideError):
    """Stone has no current CV grading result to act on."""


# ── Public result type ────────────────────────────────────────────────────────

@dataclass
class OverrideRecord:
    override_id: int
    stone_id: str
    dimension: str
    action: str          # 'confirm' | 'override'
    old_grade: Optional[str]
    new_grade: str
    cv_confidence: Optional[float]
    grading_result_id: Optional[str]
    actor_id: str


@dataclass
class ReviewState:
    """Current grading state of a stone as seen by the grader UI."""
    stone_id: str
    stone_status: str
    grading_result_id: Optional[str]
    model_version: Optional[str]
    # CV predictions
    cv_color: Optional[str]
    cv_cut: Optional[str]
    cv_clarity: Optional[str]
    color_confidence: Optional[float]
    cut_confidence: Optional[float]
    clarity_confidence: Optional[float]
    color_disagrees_with_cert: bool
    cut_disagrees_with_cert: bool
    clarity_disagrees_with_cert: bool
    # Confirmed / overridden values (None = not yet actioned)
    confirmed_color: Optional[str]
    confirmed_cut: Optional[str]
    confirmed_clarity: Optional[str]
    confirmed_at: Optional[str]
    # Cert values for comparison
    cert_color: Optional[str]
    cert_cut: Optional[str]
    cert_clarity: Optional[str]
    # Readiness
    ready_to_advance: bool
    unactioned_dimensions: list[str]


# ── Read: review state ────────────────────────────────────────────────────────

def get_review_state(
    conn: psycopg.Connection,
    *,
    stone_id: str,
    tenant_id: str,
) -> ReviewState:
    """
    Return the current grading state for a stone: CV predictions + confirmed values.
    Raises KeyError if the stone does not belong to this tenant.
    """
    stone = conn.execute(
        """
        SELECT s.status, s.confirmed_color, s.confirmed_clarity, s.confirmed_cut,
               s.confirmed_at,
               gr.id           AS grading_result_id,
               gr.model_version,
               gr.color_grade  AS cv_color,
               gr.cut_grade    AS cv_cut,
               gr.clarity_grade AS cv_clarity,
               gr.color_confidence, gr.cut_confidence, gr.clarity_confidence,
               gr.color_disagrees_with_cert,
               gr.cut_disagrees_with_cert,
               gr.clarity_disagrees_with_cert,
               c.color_grade   AS cert_color,
               c.cut_grade     AS cert_cut,
               c.clarity_grade AS cert_clarity
        FROM   stones s
        LEFT JOIN grading_results gr
               ON gr.stone_id = s.id AND gr.is_current = true
        LEFT JOIN certificates c ON c.stone_id = s.id
        WHERE  s.id = %s AND s.tenant_id = %s
        """,
        (stone_id, tenant_id),
    ).fetchone()

    if stone is None:
        raise KeyError(f"Stone {stone_id} not found for tenant {tenant_id}")

    unactioned = []
    for dim in ("color", "clarity", "cut"):
        if stone[f"confirmed_{dim}"] is None:
            unactioned.append(dim)

    return ReviewState(
        stone_id=stone_id,
        stone_status=stone["status"],
        grading_result_id=str(stone["grading_result_id"]) if stone["grading_result_id"] else None,
        model_version=stone["model_version"],
        cv_color=stone["cv_color"],
        cv_cut=stone["cv_cut"],
        cv_clarity=stone["cv_clarity"],
        color_confidence=float(stone["color_confidence"]) if stone["color_confidence"] is not None else None,
        cut_confidence=float(stone["cut_confidence"]) if stone["cut_confidence"] is not None else None,
        clarity_confidence=float(stone["clarity_confidence"]) if stone["clarity_confidence"] is not None else None,
        color_disagrees_with_cert=bool(stone["color_disagrees_with_cert"]),
        cut_disagrees_with_cert=bool(stone["cut_disagrees_with_cert"]),
        clarity_disagrees_with_cert=bool(stone["clarity_disagrees_with_cert"]),
        confirmed_color=stone["confirmed_color"],
        confirmed_cut=stone["confirmed_cut"],
        confirmed_clarity=stone["confirmed_clarity"],
        confirmed_at=stone["confirmed_at"].isoformat() if stone["confirmed_at"] else None,
        cert_color=stone["cert_color"],
        cert_cut=stone["cert_cut"],
        cert_clarity=stone["cert_clarity"],
        ready_to_advance=len(unactioned) == 0,
        unactioned_dimensions=unactioned,
    )


# ── Write: confirm or override one dimension ─────────────────────────────────

def apply_grade_action(
    conn: psycopg.Connection,
    *,
    stone_id: str,
    tenant_id: str,
    actor_id: str,
    dimension: str,
    action: str,
    new_grade: str,
    override_reason: Optional[str] = None,
    request_id: Optional[str] = None,
) -> OverrideRecord:
    """
    Confirm or override a single graded dimension.

    Parameters
    ----------
    dimension     : 'color' | 'clarity' | 'cut'
    action        : 'confirm' | 'override'
    new_grade     : the accepted/corrected grade value
    override_reason : required when action='override'

    Returns the newly created OverrideRecord.

    Raises
    ------
    StoneNotGradingError        if stone is not in 'grading' status
    NoCurrentGradingResultError if no CV result exists to act on
    InvalidGradeError           if new_grade is not valid for the dimension
    OverrideError               if action='override' but no reason supplied
    """
    if dimension not in _VALID_GRADES:
        raise InvalidGradeError(f"Unknown dimension '{dimension}' — must be one of {sorted(_VALID_GRADES)}")

    valid = _VALID_GRADES[dimension]
    if new_grade not in valid:
        raise InvalidGradeError(
            f"'{new_grade}' is not a valid {dimension} grade. Valid: {valid}"
        )

    if action == "override" and not override_reason:
        raise OverrideError("override_reason is required when action='override'")

    if action not in ("confirm", "override"):
        raise OverrideError(f"action must be 'confirm' or 'override', got '{action}'")

    # ── Load current state ────────────────────────────────────────────────────
    stone = conn.execute(
        """
        SELECT s.status,
               gr.id             AS grading_result_id,
               gr.color_grade    AS cv_color,
               gr.cut_grade      AS cv_cut,
               gr.clarity_grade  AS cv_clarity,
               gr.color_confidence,
               gr.cut_confidence,
               gr.clarity_confidence
        FROM   stones s
        LEFT JOIN grading_results gr ON gr.stone_id = s.id AND gr.is_current = true
        WHERE  s.id = %s AND s.tenant_id = %s
        """,
        (stone_id, tenant_id),
    ).fetchone()

    if stone is None:
        raise KeyError(f"Stone {stone_id} not found for tenant {tenant_id}")

    if stone["status"] != "grading":
        raise StoneNotGradingError(
            f"Stone {stone_id} is in '{stone['status']}' status — "
            f"grade actions are only permitted in 'grading' status."
        )

    grading_result_id = str(stone["grading_result_id"]) if stone["grading_result_id"] else None
    if grading_result_id is None:
        raise NoCurrentGradingResultError(
            f"Stone {stone_id} has no current CV grading result. "
            f"Submit a grading job first."
        )

    cv_grade_col = f"cv_{dimension}"
    conf_col = f"{dimension}_confidence"
    old_grade: Optional[str] = stone[cv_grade_col]
    cv_confidence: Optional[float] = float(stone[conf_col]) if stone[conf_col] is not None else None

    # ── 1. Insert override log row ────────────────────────────────────────────
    row = conn.execute(
        """
        INSERT INTO grading_overrides (
            stone_id, tenant_id, actor_id, grading_result_id,
            dimension, action, old_grade, new_grade,
            cv_confidence, override_reason
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            stone_id, tenant_id, actor_id, grading_result_id,
            dimension, action, old_grade, new_grade,
            cv_confidence, override_reason,
        ),
    ).fetchone()
    override_id = int(row["id"])

    # ── 2. Create a new grading_results row (for lineage chain) ──────────────
    source = "human_confirm" if action == "confirm" else "human_override"

    # Retire the current result.
    conn.execute(
        "UPDATE grading_results SET is_current = false WHERE stone_id = %s AND is_current = true",
        (stone_id,),
    )

    # Inherit grades from the old current row; overwrite the actioned dimension.
    new_grades = {
        "color":   stone["cv_color"],
        "cut":     stone["cv_cut"],
        "clarity": stone["cv_clarity"],
    }
    new_grades[dimension] = new_grade

    conn.execute(
        """
        INSERT INTO grading_results (
            stone_id, tenant_id, source, model_version,
            color_grade, clarity_grade, cut_grade,
            previous_grading_result_id,
            overridden_by, override_reason, is_current,
            raw_output
        ) VALUES (
            %(stone_id)s, %(tenant_id)s, %(source)s, 'human',
            %(color)s, %(clarity)s, %(cut)s,
            %(prev_id)s,
            %(actor_id)s, %(reason)s, true,
            '{}'::jsonb
        )
        """,
        {
            "stone_id":  stone_id,
            "tenant_id": tenant_id,
            "source":    source,
            "color":     new_grades["color"],
            "clarity":   new_grades["clarity"],
            "cut":       new_grades["cut"],
            "prev_id":   grading_result_id,
            "actor_id":  actor_id,
            "reason":    override_reason,
        },
    )

    # ── 3. Update stones confirmed columns ────────────────────────────────────
    confirmed_col = f"confirmed_{dimension}"
    conn.execute(
        f"""
        UPDATE stones
        SET    {confirmed_col} = %s,
               confirmed_by    = %s,
               confirmed_at    = NOW()
        WHERE  id = %s
        """,
        (new_grade, actor_id, stone_id),
    )

    # ── 4. Analytics event ────────────────────────────────────────────────────
    event_type = "grading_overridden" if action == "override" else "grading_confirmed"
    conn.execute(
        """
        INSERT INTO audit_log
            (tenant_id, actor_id, event_type, entity_type, entity_id, payload, request_id)
        VALUES (%s, %s, %s, 'stone', %s, %s, %s)
        """,
        (
            tenant_id, actor_id, event_type, stone_id,
            json.dumps({
                "dimension":     dimension,
                "action":        action,
                "old_grade":     old_grade,
                "new_grade":     new_grade,
                "cv_confidence": cv_confidence,
                "override_reason": override_reason,
                "grading_result_id": grading_result_id,
            }),
            request_id,
        ),
    )

    logger.info(
        "%s  stone=%s  dim=%s  old=%s  new=%s  actor=%s",
        event_type, stone_id, dimension, old_grade, new_grade, actor_id,
    )

    return OverrideRecord(
        override_id=override_id,
        stone_id=stone_id,
        dimension=dimension,
        action=action,
        old_grade=old_grade,
        new_grade=new_grade,
        cv_confidence=cv_confidence,
        grading_result_id=grading_result_id,
        actor_id=actor_id,
    )


# ── Status transition: grading → priced ──────────────────────────────────────

def advance_to_priced(
    conn: psycopg.Connection,
    *,
    stone_id: str,
    tenant_id: str,
    actor_id: str,
    request_id: Optional[str] = None,
) -> None:
    """
    Transition stone status from 'grading' → 'priced'.

    Raises OverrideIncompleteError if any dimension is unconfirmed — this is the
    application-layer gate.  The DB constraint priced_requires_confirmed_grades
    provides a second layer of enforcement.

    Raises StoneNotGradingError if the stone is not currently in 'grading' status.
    """
    stone = conn.execute(
        """
        SELECT status, confirmed_color, confirmed_clarity, confirmed_cut, confirmed_at
        FROM   stones
        WHERE  id = %s AND tenant_id = %s
        """,
        (stone_id, tenant_id),
    ).fetchone()

    if stone is None:
        raise KeyError(f"Stone {stone_id} not found for tenant {tenant_id}")

    if stone["status"] != "grading":
        raise StoneNotGradingError(
            f"Stone {stone_id} is in '{stone['status']}' status — "
            f"can only advance from 'grading'."
        )

    missing: set[str] = set()
    for dim in ("color", "clarity", "cut"):
        if stone[f"confirmed_{dim}"] is None:
            missing.add(dim)

    if missing:
        raise OverrideIncompleteError(missing)

    # Both the app check above AND the DB constraint below must pass.
    conn.execute(
        "UPDATE stones SET status = 'priced' WHERE id = %s",
        (stone_id,),
    )

    conn.execute(
        """
        INSERT INTO audit_log
            (tenant_id, actor_id, event_type, entity_type, entity_id, payload, request_id)
        VALUES (%s, %s, 'stone_status_changed', 'stone', %s, %s, %s)
        """,
        (
            tenant_id, actor_id, stone_id,
            json.dumps({"from": "grading", "to": "priced"}),
            request_id,
        ),
    )

    logger.info("Stone advanced grading→priced  stone=%s  actor=%s", stone_id, actor_id)
