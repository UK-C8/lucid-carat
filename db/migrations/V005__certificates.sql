-- V005: Certificates — parsed fields from a GIA or IGI lab cert (FR-2).
-- One cert per stone. The cert is the authoritative source for carat weight
-- and serves as cross-check for CV grading (disagreements are flagged).
-- Raw cert (PDF/JSON) is stored in S3; this table holds the parsed fields.

CREATE TYPE cert_lab AS ENUM ('GIA', 'IGI', 'HRD', 'AGS', 'other');

CREATE TABLE certificates (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    stone_id        UUID        NOT NULL UNIQUE REFERENCES stones (id) ON DELETE CASCADE,
    tenant_id       UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

    lab             cert_lab    NOT NULL,
    cert_number     TEXT        NOT NULL,
    -- Verified = we confirmed the cert number against the lab's online lookup.
    -- NULL = lookup not yet attempted.
    verified_at     TIMESTAMPTZ,
    verification_notes TEXT,

    -- ── Parsed cert fields ────────────────────────────────────────────────────
    -- These come from the cert document; populated by the cert ingestion service.
    carat_weight    NUMERIC(6, 3)   NOT NULL CHECK (carat_weight > 0),
    shape           TEXT,
    color_grade     TEXT,           -- GIA: D–Z; IGI may differ slightly
    clarity_grade   TEXT,
    cut_grade       TEXT,           -- present for round brilliants
    polish          TEXT,
    symmetry        TEXT,
    fluorescence    TEXT,
    measurements_mm TEXT,           -- e.g. "6.42-6.46 x 3.98"
    depth_pct       NUMERIC(5, 2),
    table_pct       NUMERIC(5, 2),
    -- Lab-grown flag from cert text
    lab_grown       lab_grown_flag  NOT NULL DEFAULT 'unknown',

    -- Low-confidence fields get flagged so the grader knows to double-check.
    low_confidence_fields   TEXT[],   -- e.g. ARRAY['color_grade', 'cut_grade']

    -- Raw parsed JSON — full cert content as returned by the parsing service.
    raw_parsed      JSONB   NOT NULL DEFAULT '{}',

    -- S3 key for the original cert PDF/JSON.
    cert_s3_key     TEXT    NOT NULL,

    issued_date     DATE,
    metadata        JSONB   NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (lab, cert_number)  -- a cert number is globally unique per lab
);

CREATE INDEX idx_certs_stone    ON certificates (stone_id);
CREATE INDEX idx_certs_tenant   ON certificates (tenant_id);
CREATE INDEX idx_certs_number   ON certificates (lab, cert_number);

COMMENT ON TABLE certificates IS
    'Parsed fields from a GIA/IGI/HRD lab certificate. One per stone. Authoritative source for carat weight.';
COMMENT ON COLUMN certificates.low_confidence_fields IS
    'Fields where the cert parser had low confidence; grader should verify manually.';
COMMENT ON COLUMN certificates.verified_at IS
    'Timestamp of lab online-lookup verification. NULL = not yet attempted.';
