-- V004: Stones — core entity, one row per polished loose diamond (FR-1).
-- Status lifecycle (FR-1): uploaded → grading → priced → published → sold | archived
-- A stone may not move backward in the lifecycle except to "archived".
-- Grading overrides are tracked in the audit_log table (V007); the columns
-- here reflect the *current confirmed* grade only.

CREATE TYPE stone_status AS ENUM (
    'uploaded',   -- video + cert received, grading not yet started
    'grading',    -- async CV job running
    'priced',     -- grading confirmed/overridden, price forecast generated; not yet on catalog
    'published',  -- visible in the B2B catalog with at least one price book entry
    'sold',       -- deal closed / soft reservation confirmed
    'archived'    -- removed from active catalog; data retained for compliance
);

CREATE TYPE stone_shape AS ENUM (
    'round_brilliant', 'princess', 'cushion', 'oval', 'emerald',
    'pear', 'radiant', 'asscher', 'heart', 'marquise', 'other'
);

CREATE TYPE lab_grown_flag AS ENUM ('natural', 'lab_grown', 'unknown');

CREATE TABLE stones (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID            NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- Internal reference code the diamond house uses (e.g. "SD-2024-0042")
    internal_ref    TEXT,
    status          stone_status    NOT NULL DEFAULT 'uploaded',
    shape           stone_shape,
    -- Carat comes exclusively from the lab cert (FR-2); never estimated by CV.
    carat_weight    NUMERIC(6, 3)   CHECK (carat_weight > 0),
    lab_grown       lab_grown_flag  NOT NULL DEFAULT 'unknown',

    -- ── Confirmed grades (set after human override/confirm; NULL until then) ──
    -- These are the values used for pricing and catalog display.
    confirmed_color     TEXT,   -- GIA scale: D–Z
    confirmed_clarity   TEXT,   -- GIA scale: FL, IF, VVS1, VVS2, VS1, VS2, SI1, SI2, I1, I2, I3
    confirmed_cut       TEXT,   -- Excellent, Very Good, Good, Fair, Poor (round brilliants only)
    confirmed_by        UUID    REFERENCES users (id),
    confirmed_at        TIMESTAMPTZ,

    -- ── S3 locations ─────────────────────────────────────────────────────────
    -- Full S3 key (not URL). Resolved to a presigned URL at request time.
    -- Convention: tenants/<tenant_id>/<stone_id>/video/
    --             tenants/<tenant_id>/<stone_id>/cert/
    --             tenants/<tenant_id>/<stone_id>/thumbnails/
    --             tenants/<tenant_id>/<stone_id>/passport/  (Phase 2)
    video_s3_key        TEXT,   -- set on upload
    cert_s3_key         TEXT,   -- set on upload

    -- ── Dataset / training metadata (Phase 0/1 specific) ─────────────────────
    -- Marks whether this stone is part of the training or holdout split.
    -- NULL = not yet assigned. Set by the dataset ingestion pipeline.
    dataset_split   TEXT    CHECK (dataset_split IN ('training', 'holdout', 'validation'))
                            DEFAULT NULL,
    dataset_notes   TEXT,   -- free-text notes from the data collector

    -- ── Pricing ──────────────────────────────────────────────────────────────
    -- Current list price after human markup/markdown; NULL until status = priced.
    -- The full forecast (confidence band, drivers) lives in price_forecasts.
    list_price_usd  NUMERIC(12, 2) CHECK (list_price_usd >= 0),

    metadata        JSONB   NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- A published stone must have confirmed grades
    CONSTRAINT published_requires_confirmed_grades CHECK (
        status NOT IN ('published', 'sold') OR (
            confirmed_color IS NOT NULL AND
            confirmed_clarity IS NOT NULL AND
            confirmed_cut IS NOT NULL AND
            confirmed_at IS NOT NULL
        )
    )
);

CREATE INDEX idx_stones_tenant        ON stones (tenant_id);
CREATE INDEX idx_stones_status        ON stones (tenant_id, status);
CREATE INDEX idx_stones_dataset_split ON stones (dataset_split) WHERE dataset_split IS NOT NULL;
CREATE INDEX idx_stones_internal_ref  ON stones (tenant_id, internal_ref) WHERE internal_ref IS NOT NULL;
CREATE INDEX idx_stones_created_at    ON stones (created_at DESC);

COMMENT ON TABLE stones IS
    'One row per loose polished diamond. Status lifecycle: uploaded→grading→priced→published→sold|archived.';
COMMENT ON COLUMN stones.carat_weight IS
    'Always from the lab cert (FR-2). Never estimated by the CV model.';
COMMENT ON COLUMN stones.confirmed_color IS
    'Human-confirmed grade (grader accept or override). NULL until grading phase completes.';
COMMENT ON COLUMN stones.dataset_split IS
    'training | holdout | validation — assigned by the ingestion pipeline for Phase 0/1 model work.';
COMMENT ON COLUMN stones.video_s3_key IS
    'S3 object key for the 360° turntable video. Resolved to presigned URL at request time.';
