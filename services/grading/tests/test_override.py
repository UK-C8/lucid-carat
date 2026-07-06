"""
Tests for the human-in-the-loop override workflow (FR-4).

Coverage
--------
TestReviewState          — get_review_state returns correct CV/confirmed/cert data
TestConfirmGrade         — accept CV prediction; log row, stones update, audit event
TestOverrideGrade        — correct CV prediction; validates reason required, log row
TestValidation           — invalid grade, unknown dimension, missing reason rejected
TestStatusGate           — advance_to_priced blocked until all 3 dims confirmed
TestDBConstraint         — DB-layer priced_requires_confirmed_grades blocks bypass
TestImmutability         — UPDATE/DELETE on grading_overrides raises exception
TestOverrideLog          — override log is queryable, structured correctly
TestFullWorkflow         — confirm 2 dims + override 1 dim → advance succeeds
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path

import psycopg
import psycopg.rows
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from grading.override import (
    apply_grade_action,
    advance_to_priced,
    get_review_state,
    InvalidGradeError,
    OverrideError,
    OverrideIncompleteError,
    StoneNotGradingError,
    NoCurrentGradingResultError,
)

DB_URL = os.environ.get("LC_DATABASE_URL", "postgresql://urvilkargathala@localhost/lucidcarat_dev")


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _conn() -> psycopg.Connection:
    return psycopg.connect(DB_URL, row_factory=psycopg.rows.dict_row)


def _seed(conn, *, status: str = "grading") -> tuple[str, str, str, str]:
    """Create tenant + user + stone + CV grading_result. Returns (tenant, user, stone, grading_result)."""
    tenant_id = str(uuid.uuid4())
    user_id = str(uuid.uuid4())
    stone_id = str(uuid.uuid4())

    conn.execute(
        "INSERT INTO tenants (id, name, slug) VALUES (%s, %s, %s)",
        (tenant_id, f"House {tenant_id[:6]}", f"house-{tenant_id[:6]}"),
    )
    conn.execute(
        """
        INSERT INTO users (id, tenant_id, email, full_name, role)
        VALUES (%s, %s, %s, 'Test Grader', 'grader')
        """,
        (user_id, tenant_id, f"grader-{user_id[:6]}@test.com"),
    )
    conn.execute(
        """
        INSERT INTO stones (id, tenant_id, status, video_s3_key, cert_s3_key)
        VALUES (%s, %s, %s, 'tenants/x/v.mp4', 'tenants/x/c.pdf')
        """,
        (stone_id, tenant_id, status),
    )
    # Cert (needed for review state JOIN) — unique cert_number per test run
    cert_number = str(uuid.uuid4().int)[:10]
    conn.execute(
        """
        INSERT INTO certificates (stone_id, tenant_id, lab, cert_number, cert_s3_key,
            color_grade, cut_grade, clarity_grade)
        VALUES (%s, %s, 'GIA', %s, 'tenants/x/c.pdf', 'G', 'Excellent', 'VS1')
        """,
        (stone_id, tenant_id, cert_number),
    )
    # CV grading result
    gr = conn.execute(
        """
        INSERT INTO grading_results (
            stone_id, tenant_id, source, model_version,
            color_grade, cut_grade, clarity_grade,
            color_confidence, cut_confidence, clarity_confidence,
            is_current, raw_output
        ) VALUES (%s, %s, 'cv_model', 'test-1.0', 'H', 'Excellent', 'VS2',
                  0.82, 0.91, 0.45, true, '{}')
        RETURNING id
        """,
        (stone_id, tenant_id),
    ).fetchone()
    grading_result_id = str(gr["id"])
    conn.commit()
    return tenant_id, user_id, stone_id, grading_result_id


# ── TestReviewState ───────────────────────────────────────────────────────────

class TestReviewState:
    def setup_method(self):
        self.conn = _conn()

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def test_review_state_returns_cv_grades(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        state = get_review_state(self.conn, stone_id=stone_id, tenant_id=tenant_id)
        assert state.cv_color == "H"
        assert state.cv_cut == "Excellent"
        assert state.cv_clarity == "VS2"

    def test_review_state_cert_grades_visible(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        state = get_review_state(self.conn, stone_id=stone_id, tenant_id=tenant_id)
        assert state.cert_color == "G"
        assert state.cert_cut == "Excellent"
        assert state.cert_clarity == "VS1"

    def test_review_state_nothing_confirmed_initially(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        state = get_review_state(self.conn, stone_id=stone_id, tenant_id=tenant_id)
        assert state.confirmed_color is None
        assert state.confirmed_cut is None
        assert state.confirmed_clarity is None
        assert not state.ready_to_advance
        assert set(state.unactioned_dimensions) == {"color", "cut", "clarity"}

    def test_review_state_confidence_returned(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        state = get_review_state(self.conn, stone_id=stone_id, tenant_id=tenant_id)
        assert state.color_confidence == pytest.approx(0.82, abs=0.01)
        assert state.cut_confidence == pytest.approx(0.91, abs=0.01)
        assert state.clarity_confidence == pytest.approx(0.45, abs=0.01)

    def test_review_state_wrong_tenant_raises(self):
        _, _, stone_id, _ = _seed(self.conn)
        with pytest.raises(KeyError):
            get_review_state(self.conn, stone_id=stone_id, tenant_id=str(uuid.uuid4()))


# ── TestConfirmGrade ──────────────────────────────────────────────────────────

class TestConfirmGrade:
    def setup_method(self):
        self.conn = _conn()

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def _confirm(self, stone_id, tenant_id, user_id, dim, grade):
        return apply_grade_action(
            self.conn,
            stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            dimension=dim, action="confirm", new_grade=grade,
        )

    def test_confirm_returns_override_record(self):
        tenant_id, user_id, stone_id, gr_id = _seed(self.conn)
        rec = self._confirm(stone_id, tenant_id, user_id, "color", "H")
        assert rec.action == "confirm"
        assert rec.dimension == "color"
        assert rec.new_grade == "H"
        assert rec.old_grade == "H"   # CV predicted H; grader confirms H
        assert rec.grading_result_id == gr_id

    def test_confirm_writes_override_log_row(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        rec = self._confirm(stone_id, tenant_id, user_id, "cut", "Excellent")
        self.conn.commit()
        row = self.conn.execute(
            "SELECT * FROM grading_overrides WHERE id = %s", (rec.override_id,)
        ).fetchone()
        assert row["action"] == "confirm"
        assert row["dimension"] == "cut"
        assert row["new_grade"] == "Excellent"
        assert row["actor_id"] == uuid.UUID(user_id)

    def test_confirm_updates_stones_confirmed_column(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        self._confirm(stone_id, tenant_id, user_id, "color", "H")
        self.conn.commit()
        row = self.conn.execute(
            "SELECT confirmed_color, confirmed_by, confirmed_at FROM stones WHERE id = %s",
            (stone_id,),
        ).fetchone()
        assert row["confirmed_color"] == "H"
        assert str(row["confirmed_by"]) == user_id
        assert row["confirmed_at"] is not None

    def test_confirm_emits_audit_event(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        self._confirm(stone_id, tenant_id, user_id, "clarity", "VS2")
        self.conn.commit()
        event = self.conn.execute(
            "SELECT * FROM audit_log WHERE event_type = 'grading_confirmed' AND entity_id = %s",
            (stone_id,),
        ).fetchone()
        assert event is not None
        assert event["payload"]["dimension"] == "clarity"
        assert event["payload"]["new_grade"] == "VS2"
        assert event["payload"]["old_grade"] == "VS2"


# ── TestOverrideGrade ─────────────────────────────────────────────────────────

class TestOverrideGrade:
    def setup_method(self):
        self.conn = _conn()

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def _override(self, stone_id, tenant_id, user_id, dim, new_grade, reason="loupe inspection"):
        return apply_grade_action(
            self.conn,
            stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            dimension=dim, action="override", new_grade=new_grade,
            override_reason=reason,
        )

    def test_override_writes_log_with_old_and_new(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        rec = self._override(stone_id, tenant_id, user_id, "color", "G", "cert says G")
        self.conn.commit()
        row = self.conn.execute(
            "SELECT * FROM grading_overrides WHERE id = %s", (rec.override_id,)
        ).fetchone()
        assert row["action"] == "override"
        assert row["old_grade"] == "H"    # CV predicted H
        assert row["new_grade"] == "G"    # grader corrects to G
        assert row["override_reason"] == "cert says G"

    def test_override_updates_confirmed_column(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        self._override(stone_id, tenant_id, user_id, "color", "G")
        self.conn.commit()
        row = self.conn.execute(
            "SELECT confirmed_color FROM stones WHERE id = %s", (stone_id,)
        ).fetchone()
        assert row["confirmed_color"] == "G"

    def test_override_emits_grading_overridden_event(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        self._override(stone_id, tenant_id, user_id, "cut", "Very Good", "scope confirms VG")
        self.conn.commit()
        event = self.conn.execute(
            "SELECT * FROM audit_log WHERE event_type = 'grading_overridden' AND entity_id = %s",
            (stone_id,),
        ).fetchone()
        assert event is not None
        payload = event["payload"]
        assert payload["dimension"] == "cut"
        assert payload["old_grade"] == "Excellent"
        assert payload["new_grade"] == "Very Good"
        assert payload["action"] == "override"

    def test_override_cv_confidence_recorded(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        rec = self._override(stone_id, tenant_id, user_id, "cut", "Very Good")
        assert rec.cv_confidence == pytest.approx(0.91, abs=0.01)

    def test_override_creates_new_grading_result_with_human_source(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        self._override(stone_id, tenant_id, user_id, "color", "G")
        self.conn.commit()
        row = self.conn.execute(
            "SELECT source FROM grading_results WHERE stone_id = %s AND is_current = true",
            (stone_id,),
        ).fetchone()
        assert row["source"] == "human_override"

    def test_is_current_unique_after_override(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        self._override(stone_id, tenant_id, user_id, "color", "G")
        self.conn.commit()
        rows = self.conn.execute(
            "SELECT is_current FROM grading_results WHERE stone_id = %s",
            (stone_id,),
        ).fetchall()
        assert sum(1 for r in rows if r["is_current"]) == 1


# ── TestValidation ────────────────────────────────────────────────────────────

class TestValidation:
    def setup_method(self):
        self.conn = _conn()

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def test_invalid_color_grade_rejected(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        with pytest.raises(InvalidGradeError):
            apply_grade_action(
                self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
                dimension="color", action="confirm", new_grade="ZZ",
            )

    def test_invalid_cut_grade_rejected(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        with pytest.raises(InvalidGradeError):
            apply_grade_action(
                self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
                dimension="cut", action="confirm", new_grade="Super Ideal",
            )

    def test_invalid_clarity_grade_rejected(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        with pytest.raises(InvalidGradeError):
            apply_grade_action(
                self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
                dimension="clarity", action="confirm", new_grade="I4",
            )

    def test_unknown_dimension_rejected(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        with pytest.raises(InvalidGradeError):
            apply_grade_action(
                self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
                dimension="carat", action="confirm", new_grade="1.01",
            )

    def test_override_without_reason_rejected(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        with pytest.raises(OverrideError, match="override_reason"):
            apply_grade_action(
                self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
                dimension="color", action="override", new_grade="G",
            )

    def test_invalid_action_rejected(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        with pytest.raises(OverrideError):
            apply_grade_action(
                self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
                dimension="color", action="approve", new_grade="G",
            )

    def test_action_on_non_grading_stone_rejected(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn, status="uploaded")
        with pytest.raises(StoneNotGradingError):
            apply_grade_action(
                self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
                dimension="color", action="confirm", new_grade="H",
            )


# ── TestStatusGate ────────────────────────────────────────────────────────────

class TestStatusGate:
    def setup_method(self):
        self.conn = _conn()

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def _action(self, stone_id, tenant_id, user_id, dim, grade, action="confirm", reason=None):
        apply_grade_action(
            self.conn,
            stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            dimension=dim, action=action, new_grade=grade, override_reason=reason,
        )
        self.conn.commit()

    def test_advance_blocked_with_nothing_confirmed(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        with pytest.raises(OverrideIncompleteError) as exc_info:
            advance_to_priced(
                self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            )
        assert {"color", "clarity", "cut"} == exc_info.value.missing

    def test_advance_blocked_with_one_missing(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        self._action(stone_id, tenant_id, user_id, "color", "H")
        self._action(stone_id, tenant_id, user_id, "cut", "Excellent")
        with pytest.raises(OverrideIncompleteError) as exc_info:
            advance_to_priced(
                self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            )
        assert exc_info.value.missing == {"clarity"}

    def test_advance_blocked_with_two_missing(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        self._action(stone_id, tenant_id, user_id, "color", "H")
        with pytest.raises(OverrideIncompleteError) as exc_info:
            advance_to_priced(
                self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            )
        assert {"cut", "clarity"} == exc_info.value.missing

    def test_advance_succeeds_when_all_confirmed(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        self._action(stone_id, tenant_id, user_id, "color", "H")
        self._action(stone_id, tenant_id, user_id, "cut", "Excellent")
        self._action(stone_id, tenant_id, user_id, "clarity", "VS2")
        advance_to_priced(
            self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
        )
        self.conn.commit()
        row = self.conn.execute("SELECT status FROM stones WHERE id = %s", (stone_id,)).fetchone()
        assert row["status"] == "priced"

    def test_advance_emits_status_changed_event(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        self._action(stone_id, tenant_id, user_id, "color", "H")
        self._action(stone_id, tenant_id, user_id, "cut", "Excellent")
        self._action(stone_id, tenant_id, user_id, "clarity", "VS2")
        advance_to_priced(
            self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
        )
        self.conn.commit()
        event = self.conn.execute(
            "SELECT * FROM audit_log WHERE event_type = 'stone_status_changed' AND entity_id = %s",
            (stone_id,),
        ).fetchone()
        assert event is not None
        assert event["payload"]["from"] == "grading"
        assert event["payload"]["to"] == "priced"

    def test_advance_from_wrong_status_rejected(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn, status="uploaded")
        with pytest.raises(StoneNotGradingError):
            advance_to_priced(
                self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            )


# ── TestDBConstraint ──────────────────────────────────────────────────────────

class TestDBConstraint:
    """Verify the DB-layer priced_requires_confirmed_grades constraint is active."""

    def setup_method(self):
        self.conn = _conn()

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def test_db_rejects_priced_without_confirmed_grades(self):
        """
        Attempt to set status='priced' directly via SQL without confirming grades.
        The DB CHECK constraint must raise a violation.
        """
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        with pytest.raises(psycopg.errors.CheckViolation):
            self.conn.execute(
                "UPDATE stones SET status = 'priced' WHERE id = %s",
                (stone_id,),
            )

    def test_db_accepts_priced_with_all_confirmed(self):
        """After filling all confirmed columns, the UPDATE must succeed."""
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        self.conn.execute(
            """
            UPDATE stones
            SET confirmed_color = 'H', confirmed_cut = 'Excellent', confirmed_clarity = 'VS2',
                confirmed_by = %s, confirmed_at = NOW()
            WHERE id = %s
            """,
            (user_id, stone_id),
        )
        # This must not raise.
        self.conn.execute("UPDATE stones SET status = 'priced' WHERE id = %s", (stone_id,))


# ── TestImmutability ──────────────────────────────────────────────────────────

class TestImmutability:
    def setup_method(self):
        self.conn = _conn()

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def _write_one_action(self) -> tuple[str, str, str, int]:
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        rec = apply_grade_action(
            self.conn,
            stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            dimension="color", action="confirm", new_grade="H",
        )
        self.conn.commit()
        return tenant_id, user_id, stone_id, rec.override_id

    def test_update_override_row_raises(self):
        _, _, _, override_id = self._write_one_action()
        with pytest.raises(psycopg.errors.RaiseException, match="immutable"):
            self.conn.execute(
                "UPDATE grading_overrides SET new_grade = 'D' WHERE id = %s",
                (override_id,),
            )

    def test_delete_override_row_raises(self):
        _, _, _, override_id = self._write_one_action()
        with pytest.raises(psycopg.errors.RaiseException, match="immutable"):
            self.conn.execute(
                "DELETE FROM grading_overrides WHERE id = %s",
                (override_id,),
            )

    def test_truncate_override_table_raises(self):
        self._write_one_action()
        with pytest.raises(psycopg.errors.RaiseException, match="truncated"):
            self.conn.execute("TRUNCATE grading_overrides")


# ── TestOverrideLog ───────────────────────────────────────────────────────────

class TestOverrideLog:
    def setup_method(self):
        self.conn = _conn()

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def test_override_log_queryable_by_stone(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        apply_grade_action(
            self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            dimension="color", action="confirm", new_grade="H",
        )
        apply_grade_action(
            self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            dimension="cut", action="override", new_grade="Very Good",
            override_reason="scope review",
        )
        self.conn.commit()

        rows = self.conn.execute(
            "SELECT * FROM grading_overrides WHERE stone_id = %s ORDER BY id",
            (stone_id,),
        ).fetchall()
        assert len(rows) == 2
        assert rows[0]["dimension"] == "color"
        assert rows[0]["action"] == "confirm"
        assert rows[1]["dimension"] == "cut"
        assert rows[1]["action"] == "override"
        assert rows[1]["override_reason"] == "scope review"

    def test_override_log_has_cv_confidence(self):
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        rec = apply_grade_action(
            self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            dimension="color", action="confirm", new_grade="H",
        )
        self.conn.commit()
        row = self.conn.execute(
            "SELECT cv_confidence FROM grading_overrides WHERE id = %s", (rec.override_id,)
        ).fetchone()
        assert float(row["cv_confidence"]) == pytest.approx(0.82, abs=0.01)

    def test_override_rate_query(self):
        """The override-rate metric query must work on the structured log."""
        tenant_id, user_id, stone_id, _ = _seed(self.conn)
        apply_grade_action(
            self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            dimension="color", action="confirm", new_grade="H",
        )
        apply_grade_action(
            self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            dimension="cut", action="override", new_grade="Very Good",
            override_reason="corrected",
        )
        self.conn.commit()

        rate = self.conn.execute(
            """
            SELECT
                dimension,
                COUNT(*) FILTER (WHERE action = 'override') AS overrides,
                COUNT(*) FILTER (WHERE action = 'confirm')  AS confirms,
                ROUND(
                    COUNT(*) FILTER (WHERE action = 'override')::numeric /
                    NULLIF(COUNT(*), 0), 4
                ) AS override_rate
            FROM grading_overrides
            WHERE tenant_id = %s
            GROUP BY dimension
            ORDER BY dimension
            """,
            (tenant_id,),
        ).fetchall()

        by_dim = {r["dimension"]: r for r in rate}
        assert by_dim["color"]["override_rate"] == 0
        assert by_dim["cut"]["override_rate"] == 1


# ── TestFullWorkflow ──────────────────────────────────────────────────────────

class TestFullWorkflow:
    def setup_method(self):
        self.conn = _conn()

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def test_confirm_two_override_one_then_advance(self):
        """
        Realistic grader workflow:
          1. Confirm color (agree with CV)
          2. Override cut (CV said Excellent, grader says Very Good)
          3. Confirm clarity
          4. Advance → priced
        """
        tenant_id, user_id, stone_id, _ = _seed(self.conn)

        apply_grade_action(
            self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            dimension="color", action="confirm", new_grade="H",
        )
        self.conn.commit()

        apply_grade_action(
            self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            dimension="cut", action="override", new_grade="Very Good",
            override_reason="Loupe shows minor bearding on lower girdle facets",
        )
        self.conn.commit()

        apply_grade_action(
            self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
            dimension="clarity", action="confirm", new_grade="VS2",
        )
        self.conn.commit()

        # State should now be ready
        state = get_review_state(self.conn, stone_id=stone_id, tenant_id=tenant_id)
        assert state.ready_to_advance
        assert state.unactioned_dimensions == []
        assert state.confirmed_color == "H"
        assert state.confirmed_cut == "Very Good"
        assert state.confirmed_clarity == "VS2"

        advance_to_priced(
            self.conn, stone_id=stone_id, tenant_id=tenant_id, actor_id=user_id,
        )
        self.conn.commit()

        row = self.conn.execute("SELECT status FROM stones WHERE id = %s", (stone_id,)).fetchone()
        assert row["status"] == "priced"

        # Override log has 3 rows: 2 confirms + 1 override
        log = self.conn.execute(
            "SELECT dimension, action FROM grading_overrides WHERE stone_id = %s ORDER BY id",
            (stone_id,),
        ).fetchall()
        assert len(log) == 3
        actions = [(r["dimension"], r["action"]) for r in log]
        assert ("color", "confirm") in actions
        assert ("cut", "override") in actions
        assert ("clarity", "confirm") in actions
