-- V009: Time-series tables backed by TimescaleDB hypertables.
-- Two concerns:
--   1. price_history   — tracks how the list price of a stone changes over time
--   2. provenance_events — append-only log of mine-to-market events per stone
--
-- NOTE — Diamond Passport hash-chain logic (FR-8):
--   The provenance_events table here defines the SCHEMA SHAPE only.
--   The hash-chain linking logic (each event stores the SHA-256 of the
--   previous event's hash + its own payload, forming a tamper-evident chain)
--   is a Phase 2 deliverable (FR-8 / BR-4).
--   Fields prev_event_hash and event_hash are present but left NULL in Phase 0/1.
--   The Polygon anchor column (anchor_tx_hash) is also present but unused until
--   the optional Phase 2 anchor feature is enabled (FR-9).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Price history ──────────────────────────────────────────────────────────

CREATE TABLE price_history (
    occurred_at     TIMESTAMPTZ NOT NULL,
    stone_id        UUID        NOT NULL REFERENCES stones (id) ON DELETE CASCADE,
    tenant_id       UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    event           TEXT        NOT NULL,   -- 'forecast_generated' | 'markup_applied' | 'published' | 'sold'
    old_price_usd   NUMERIC(12, 2),
    new_price_usd   NUMERIC(12, 2),
    changed_by      UUID        REFERENCES users (id),
    notes           TEXT,
    metadata        JSONB       NOT NULL DEFAULT '{}'
);

-- ── 2. Provenance events ───────────────────────────────────────────────────────

CREATE TYPE provenance_event_type AS ENUM (
    -- Phase 0/1 events (data pipeline + grading)
    'stone_registered',
    'video_uploaded',
    'cert_ingested',
    'grading_completed',
    'grading_overridden',
    'price_set',
    -- Phase 2 events (catalog + CRM)
    'stone_published',
    'buyer_inquiry',
    'order_reserved',
    'ownership_transferred',
    'export_recorded',
    -- Phase 3 / future
    'customs_filed',
    'retail_sale',
    'insurance_recorded'
);

CREATE TABLE provenance_events (
    occurred_at         TIMESTAMPTZ             NOT NULL,
    stone_id            UUID                    NOT NULL REFERENCES stones (id) ON DELETE CASCADE,
    tenant_id           UUID                    NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    event_type          provenance_event_type   NOT NULL,
    actor_id            UUID                    REFERENCES users (id),
    location            TEXT,
    payload             JSONB   NOT NULL DEFAULT '{}',

    -- ── Phase 2 placeholders: Diamond Passport hash-chain (FR-8) ─────────────
    -- TODO (Phase 2 / FR-8): populate these fields to form the tamper-evident chain.
    -- Algorithm: event_hash = SHA256(prev_event_hash || canonical_json(payload))
    prev_event_hash     TEXT,
    event_hash          TEXT,
    -- ── Phase 2 placeholder: optional Polygon anchor (FR-9) ──────────────────
    -- TODO (Phase 2 / FR-9, optional): set when chain root Merkle hash is anchored.
    anchor_tx_hash      TEXT,

    metadata            JSONB   NOT NULL DEFAULT '{}'
);

-- ── TimescaleDB hypertable conversion (runs only when extension is installed) ─

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
    ) THEN
        PERFORM create_hypertable(
            'price_history', 'occurred_at',
            chunk_time_interval => INTERVAL '1 month',
            if_not_exists => TRUE
        );
        PERFORM create_hypertable(
            'provenance_events', 'occurred_at',
            chunk_time_interval => INTERVAL '1 month',
            if_not_exists => TRUE
        );
        RAISE NOTICE 'TimescaleDB: price_history and provenance_events converted to hypertables.';
    ELSE
        RAISE NOTICE 'TimescaleDB not installed — price_history and provenance_events are plain tables. Apply hypertable conversion in AWS/production.';
    END IF;
END;
$$;

-- Indexes work regardless of hypertable status
CREATE INDEX idx_price_history_stone    ON price_history (stone_id, occurred_at DESC);
CREATE INDEX idx_price_history_tenant   ON price_history (tenant_id, occurred_at DESC);

CREATE INDEX idx_provenance_stone       ON provenance_events (stone_id, occurred_at ASC);
CREATE INDEX idx_provenance_tenant      ON provenance_events (tenant_id, occurred_at DESC);
CREATE INDEX idx_provenance_type        ON provenance_events (event_type);

COMMENT ON TABLE price_history IS
    'TimescaleDB hypertable (when available). Append-only log of every price change per stone.';

COMMENT ON TABLE provenance_events IS
    'TimescaleDB hypertable (when available). Append-only mine-to-market provenance log per stone. '
    'Hash-chain fields (prev_event_hash, event_hash) and Polygon anchor (anchor_tx_hash) '
    'are present but NULL until Phase 2 Diamond Passport logic is implemented (FR-8/FR-9).';
COMMENT ON COLUMN provenance_events.event_hash IS
    'Phase 2 TODO (FR-8): SHA-256(prev_event_hash || canonical_json(payload)). NULL in Phase 0/1.';
COMMENT ON COLUMN provenance_events.anchor_tx_hash IS
    'Phase 2 TODO (FR-9, optional): Polygon tx hash for chain-root Merkle anchor. NULL until enabled.';
