-- V008: Audit log — immutable record of every significant state change (FR-11, BR-8).
-- Append-only; rows are NEVER updated or deleted.
-- Covers: grading overrides, price changes, price-book reads, status transitions,
-- user auth events, and any other event required for SOC 2 audit trail.

CREATE TYPE audit_event_type AS ENUM (
    -- Stone lifecycle
    'stone_uploaded',
    'stone_status_changed',
    -- Grading
    'grading_completed',
    'grading_overridden',
    'grading_confirmed',
    -- Pricing
    'price_forecast_generated',
    'price_adjusted',
    'stone_published',
    -- Catalog / price books
    'price_book_assigned',
    'price_book_viewed',
    -- CRM
    'buyer_inquiry_submitted',
    'order_reserved',
    'stone_sold',
    -- Provenance (Phase 2 — Diamond Passport)
    'passport_event_appended',
    -- Auth / user management
    'user_login',
    'user_login_failed',
    'user_invited',
    'user_role_changed',
    -- Billing (Phase 3)
    'tenant_subscription_active',
    'per_stone_usage_metered',
    -- Analytics passthrough (lead gen)
    'lead_submitted',
    'widget_verify_viewed'
);

CREATE TABLE audit_log (
    id              BIGSERIAL   PRIMARY KEY,  -- monotonic, not UUID — easier to sequence
    tenant_id       UUID        REFERENCES tenants (id),   -- NULL for system events
    actor_id        UUID        REFERENCES users (id),     -- NULL for system/async jobs
    event_type      audit_event_type    NOT NULL,
    -- Target entity (stone, user, etc.)
    entity_type     TEXT,   -- 'stone' | 'user' | 'certificate' | 'price_forecast' | ...
    entity_id       UUID,
    -- Structured diff: {before: {...}, after: {...}} for state-change events
    payload         JSONB   NOT NULL DEFAULT '{}',
    -- Request context for attribution
    ip_address      INET,
    user_agent      TEXT,
    request_id      TEXT,   -- correlation ID from the API gateway / ALB
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No UPDATE or DELETE on this table — enforced by application layer + pg policy.
-- For production: consider a dedicated audit schema with SECURITY DEFINER functions
-- and a RULE/trigger that prevents UPDATE/DELETE.

CREATE INDEX idx_audit_tenant       ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX idx_audit_entity       ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_actor        ON audit_log (actor_id);
CREATE INDEX idx_audit_event_type   ON audit_log (event_type);
CREATE INDEX idx_audit_occurred_at  ON audit_log (occurred_at DESC);

COMMENT ON TABLE audit_log IS
    'Append-only audit log. Never update or delete rows. SOC 2 and FR-11 compliance.';
COMMENT ON COLUMN audit_log.payload IS
    'Structured {before, after} JSON diff for state-change events. Full context for all others.';
