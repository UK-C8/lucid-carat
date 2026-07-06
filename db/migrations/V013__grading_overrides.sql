-- FR-4: Human-in-the-loop override log.
--
-- grading_overrides is the structured, append-only record of every accept/override
-- action a grader takes on a CV-predicted grade.  It is the source of truth for:
--   • The override-rate trust metric (BR-9)
--   • Model retraining labels (human corrections over CV predictions)
--   • Compliance audit trail
--
-- Immutability is enforced at two layers:
--   1. Application: override.py never issues UPDATE/DELETE on this table.
--   2. Database: triggers below raise an exception on any attempt to UPDATE or DELETE.
--
-- The priced status gate is also strengthened here: the existing
-- published_requires_confirmed_grades constraint covers published/sold but not priced.
-- A stone must have all 3 dimensions confirmed before it can leave "grading".

-- ── 1. Override log table ─────────────────────────────────────────────────────

CREATE TABLE grading_overrides (
    id                  BIGSERIAL PRIMARY KEY,
    stone_id            UUID        NOT NULL REFERENCES stones(id)           ON DELETE RESTRICT,
    tenant_id           UUID        NOT NULL REFERENCES tenants(id)          ON DELETE RESTRICT,
    actor_id            UUID        NOT NULL REFERENCES users(id)            ON DELETE RESTRICT,
    grading_result_id   UUID        REFERENCES grading_results(id)           ON DELETE RESTRICT,
    dimension           TEXT        NOT NULL,
    action              TEXT        NOT NULL,
    old_grade           TEXT,
    new_grade           TEXT        NOT NULL,
    cv_confidence       NUMERIC(4,3),
    override_reason     TEXT,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT grading_overrides_dimension_check
        CHECK (dimension IN ('color', 'clarity', 'cut')),
    CONSTRAINT grading_overrides_action_check
        CHECK (action IN ('confirm', 'override')),
    CONSTRAINT grading_overrides_override_needs_reason
        CHECK (action <> 'override' OR override_reason IS NOT NULL),
    CONSTRAINT grading_overrides_new_grade_nonempty
        CHECK (new_grade <> '')
);

CREATE INDEX idx_go_stone    ON grading_overrides (stone_id);
CREATE INDEX idx_go_tenant   ON grading_overrides (tenant_id);
CREATE INDEX idx_go_actor    ON grading_overrides (actor_id);
CREATE INDEX idx_go_dim      ON grading_overrides (stone_id, dimension);
CREATE INDEX idx_go_occurred ON grading_overrides (occurred_at DESC);

-- ── 2. Immutability triggers ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION grading_overrides_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'grading_overrides rows are immutable — the override log cannot be modified or deleted (row id=%).',
        OLD.id;
END;
$$;

CREATE TRIGGER grading_overrides_no_update
    BEFORE UPDATE ON grading_overrides
    FOR EACH ROW EXECUTE FUNCTION grading_overrides_immutable();

CREATE TRIGGER grading_overrides_no_delete
    BEFORE DELETE ON grading_overrides
    FOR EACH ROW EXECUTE FUNCTION grading_overrides_immutable();

-- Prevent TRUNCATE as well.
CREATE OR REPLACE FUNCTION grading_overrides_no_truncate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'grading_overrides cannot be truncated — it is an immutable audit log.';
END;
$$;

CREATE TRIGGER grading_overrides_no_truncate
    BEFORE TRUNCATE ON grading_overrides
    EXECUTE FUNCTION grading_overrides_no_truncate();

-- ── 3. Strengthen the status gate to cover 'priced' ──────────────────────────
-- The existing published_requires_confirmed_grades constraint covers published/sold.
-- We add a parallel constraint for priced so the gate fires one step earlier.

ALTER TABLE stones ADD CONSTRAINT priced_requires_confirmed_grades
    CHECK (
        status NOT IN ('priced', 'published', 'sold')
        OR (
            confirmed_color   IS NOT NULL
            AND confirmed_clarity IS NOT NULL
            AND confirmed_cut     IS NOT NULL
            AND confirmed_at      IS NOT NULL
        )
    );
