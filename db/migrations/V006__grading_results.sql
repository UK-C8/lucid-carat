-- V006: Grading results — output of each CV model run (FR-3, FR-4).
-- Multiple rows per stone are possible (retry, regrade after override).
-- The row with is_current = TRUE is the one used for pricing and display.
-- When a grader overrides a prediction, a new row is inserted with
-- source = 'human_override' and the old row gets is_current = FALSE.
-- This preserves the full history for model retraining (FR-4 audit trail).

CREATE TYPE grading_source AS ENUM (
    'cv_model',         -- predicted by the PyTorch CV pipeline
    'human_override',   -- grader manually set or corrected
    'human_confirm'     -- grader confirmed the CV prediction without change
);

CREATE TABLE grading_results (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    stone_id        UUID            NOT NULL REFERENCES stones (id) ON DELETE CASCADE,
    tenant_id       UUID            NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

    source          grading_source  NOT NULL,
    -- NULL for human_override/confirm rows (no model run involved)
    model_version   TEXT,

    -- ── Predicted / set grades ────────────────────────────────────────────────
    color_grade     TEXT,
    clarity_grade   TEXT,
    cut_grade       TEXT,

    -- ── Confidence scores (0.0–1.0, NULL for human rows) ─────────────────────
    color_confidence    NUMERIC(4, 3) CHECK (color_confidence BETWEEN 0 AND 1),
    clarity_confidence  NUMERIC(4, 3) CHECK (clarity_confidence BETWEEN 0 AND 1),
    cut_confidence      NUMERIC(4, 3) CHECK (cut_confidence BETWEEN 0 AND 1),

    -- ── Cert-disagreement flags ───────────────────────────────────────────────
    -- TRUE when the CV prediction differs from the parsed cert grade by > 1 step.
    color_disagrees_with_cert    BOOLEAN NOT NULL DEFAULT FALSE,
    clarity_disagrees_with_cert  BOOLEAN NOT NULL DEFAULT FALSE,
    cut_disagrees_with_cert      BOOLEAN NOT NULL DEFAULT FALSE,

    -- ── Override tracking (FR-4) ──────────────────────────────────────────────
    -- Populated when source = human_override
    previous_grading_result_id  UUID REFERENCES grading_results (id),
    overridden_by               UUID REFERENCES users (id),
    override_reason             TEXT,

    -- Only one row per stone should be is_current = TRUE at any time.
    -- Enforced via partial unique index below.
    is_current      BOOLEAN NOT NULL DEFAULT TRUE,

    -- Full model output blob for debugging / retraining
    raw_output      JSONB   NOT NULL DEFAULT '{}',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one current grading result per stone
CREATE UNIQUE INDEX idx_grading_current ON grading_results (stone_id)
    WHERE is_current = TRUE;

CREATE INDEX idx_grading_stone     ON grading_results (stone_id);
CREATE INDEX idx_grading_tenant    ON grading_results (tenant_id);
CREATE INDEX idx_grading_source    ON grading_results (source);
CREATE INDEX idx_grading_model_ver ON grading_results (model_version) WHERE model_version IS NOT NULL;

COMMENT ON TABLE grading_results IS
    'CV model predictions and human overrides for 4Cs grading. Full history kept for model retraining.';
COMMENT ON COLUMN grading_results.is_current IS
    'TRUE = this row is the active grade used for pricing/display. Enforced unique per stone.';
COMMENT ON COLUMN grading_results.color_disagrees_with_cert IS
    'Flagged when CV prediction differs from cert grade by more than 1 GIA scale step.';
COMMENT ON COLUMN grading_results.raw_output IS
    'Full model output JSON — frame-level scores, attention maps, etc. Used for retraining.';
