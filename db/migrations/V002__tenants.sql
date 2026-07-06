-- V002: Tenants — one row per diamond house.
-- Every downstream table carries a tenant_id FK to enforce logical isolation.
-- Physical row-level isolation is enforced at the application layer; a future
-- Phase 2/3 hardening pass can add RLS policies on top.

CREATE TABLE tenants (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT        NOT NULL,
    slug                TEXT        NOT NULL UNIQUE,   -- URL-safe identifier, e.g. "shree-diamonds"
    plan                TEXT        NOT NULL DEFAULT 'trial'
                            CHECK (plan IN ('trial', 'starter', 'growth', 'enterprise')),
    is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
    -- S3 prefix root: tenants/<id>/  — matches the convention documented in the
    -- storage Terraform module. Stored here so the app never recomputes it.
    s3_prefix           TEXT        NOT NULL GENERATED ALWAYS AS ('tenants/' || id::text || '/') STORED,
    stripe_customer_id  TEXT        UNIQUE,            -- set when Stripe billing is wired (Phase 3)
    metadata            JSONB       NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenants_slug     ON tenants (slug);
CREATE INDEX idx_tenants_active   ON tenants (is_active) WHERE is_active;

COMMENT ON TABLE tenants IS
    'One row per diamond-house customer. All user/stone data is scoped to a tenant_id.';
COMMENT ON COLUMN tenants.s3_prefix IS
    'Computed root S3 prefix for this tenant. All object keys start with this value.';
