-- V003: Users — tenant staff and B2B buyers (FR-11, BR-8).
-- Role semantics:
--   admin   — full tenant management, user invite, billing
--   grader  — can upload stones, run/confirm grading
--   sales   — can set prices, publish to catalog, manage CRM
--   viewer  — read-only access to tenant's stones/prices
--   buyer   — external B2B buyer; scoped to catalog + 3D viewer + inquiries

CREATE TYPE user_role AS ENUM ('admin', 'grader', 'sales', 'viewer', 'buyer');

CREATE TABLE users (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    email           TEXT        NOT NULL,
    -- Password hash stored via pgcrypto crypt(); never plaintext.
    -- NULL for OAuth/SSO-only accounts.
    password_hash   TEXT,
    full_name       TEXT        NOT NULL,
    role            user_role   NOT NULL,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    -- Per-DPDP/GDPR: track when user gave consent and their data-region preference.
    consent_given_at    TIMESTAMPTZ,
    data_region         TEXT    NOT NULL DEFAULT 'ap-south-1',
    last_login_at       TIMESTAMPTZ,
    metadata            JSONB   NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Email unique within a tenant; a buyer may exist in multiple tenants
    -- with the same email (different accounts).
    UNIQUE (tenant_id, email)
);

CREATE INDEX idx_users_tenant      ON users (tenant_id);
CREATE INDEX idx_users_role        ON users (tenant_id, role);
CREATE INDEX idx_users_email       ON users (email);  -- cross-tenant lookup for login

COMMENT ON TABLE  users             IS 'Tenant staff and B2B buyers. Role drives all RBAC checks.';
COMMENT ON COLUMN users.role        IS 'admin|grader|sales|viewer|buyer — enforced at application layer.';
COMMENT ON COLUMN users.consent_given_at IS
    'DPDP/GDPR consent timestamp. NULL means consent not yet collected.';
