-- FR-12, BR-6: Stripe billing state — per-seat subscriptions + per-stone metered usage.
-- The stripe_customer_id column already exists on tenants (V002).
-- This migration adds the subscription tracking table.

CREATE TABLE IF NOT EXISTS stripe_subscriptions (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    stripe_subscription_id      TEXT NOT NULL UNIQUE,
    stripe_customer_id          TEXT NOT NULL,
    status                      TEXT NOT NULL,          -- active | trialing | past_due | canceled | etc.
    plan                        TEXT NOT NULL,          -- starter | growth | enterprise
    seat_subscription_item_id   TEXT,                  -- Stripe subscription item for per-seat price
    metered_subscription_item_id TEXT,                 -- Stripe subscription item for per-stone metered price
    seat_quantity               INTEGER NOT NULL DEFAULT 1,
    current_period_start        TIMESTAMPTZ,
    current_period_end          TIMESTAMPTZ,
    cancel_at_period_end        BOOLEAN NOT NULL DEFAULT FALSE,
    billing_country             TEXT,                  -- ISO-3166-1 alpha-2 (US, GB, AE, IN …)
    billing_manual              BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE for Indian tenants (GST handled separately)
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_tenant
    ON stripe_subscriptions(tenant_id);

-- Track per-stone metering events so we don't double-report.
CREATE TABLE IF NOT EXISTS billed_stones (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    stone_id    UUID NOT NULL,
    billed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stripe_usage_record_id  TEXT,
    UNIQUE (tenant_id, stone_id)  -- idempotency: each stone metered at most once per tenant
);

CREATE INDEX IF NOT EXISTS idx_billed_stones_tenant
    ON billed_stones(tenant_id);
