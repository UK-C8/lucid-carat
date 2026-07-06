-- FR-12, BR-7: API keys for standalone Grading and Provenance API access.
-- Keys are stored as SHA-256 hashes (raw key is shown once on creation, never stored).
-- key_prefix is the first 8 chars of the raw key, used for display in the UI.

CREATE TABLE IF NOT EXISTS api_keys (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key_hash              TEXT NOT NULL UNIQUE,        -- SHA-256(raw key), hex-encoded
    key_prefix            TEXT NOT NULL,               -- first 8 chars of raw key for display
    name                  TEXT NOT NULL,               -- human-readable label
    scopes                TEXT[] NOT NULL DEFAULT ARRAY['grading','provenance'],
    rate_limit_per_minute INTEGER NOT NULL DEFAULT 60,
    last_used_at          TIMESTAMPTZ,
    revoked_at            TIMESTAMPTZ,
    created_by            UUID REFERENCES users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash   ON api_keys(key_hash);

-- Per-minute sliding window for rate limiting (no Redis required in Phase 3).
-- minute_bucket = FLOOR(unix_epoch / 60).
CREATE TABLE IF NOT EXISTS api_rate_limit (
    key_id        UUID    NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    minute_bucket BIGINT  NOT NULL,
    count         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key_id, minute_bucket)
);

-- Prune old buckets (older than 10 minutes) — called opportunistically in the middleware.
-- A pg cron job can also run this; for Phase 3 the middleware prunes on 1-in-100 requests.
CREATE OR REPLACE FUNCTION prune_api_rate_limit() RETURNS void LANGUAGE sql AS $$
    DELETE FROM api_rate_limit
    WHERE minute_bucket < FLOOR(EXTRACT(EPOCH FROM NOW()) / 60) - 10;
$$;
