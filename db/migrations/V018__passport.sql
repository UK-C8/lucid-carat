-- Phase 2 Step 4: Diamond Passport — hash-chained provenance (FR-8, BR-4).
--
-- Design:
--   Each event's hash = SHA-256(prev_hash || \x00 || stone_id || \x00 ||
--                               event_type || \x00 || canonical_payload_json ||
--                               \x00 || occurred_at_iso)
--   The first event in a chain uses prev_hash = 'GENESIS'.
--   seq is a per-stone integer (1, 2, 3, …) giving deterministic chain order.
--
-- Immutability is enforced at the DB layer by triggers that reject any
-- UPDATE or DELETE on this table.  The chain therefore cannot be silently
-- rewritten; only a full table drop (which requires superuser and would be
-- visible in audit logs) could destroy evidence.

-- ── 1. Add id (PRIMARY KEY) and seq to provenance_events ─────────────────────

ALTER TABLE provenance_events
  ADD COLUMN id  uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN seq integer;

-- Back-fill seq for existing rows using insertion order (ctid).
UPDATE provenance_events pe
SET seq = sub.rn
FROM (
  SELECT ctid,
         ROW_NUMBER() OVER (PARTITION BY stone_id ORDER BY occurred_at, ctid) AS rn
  FROM provenance_events
) sub
WHERE pe.ctid = sub.ctid;

ALTER TABLE provenance_events
  ALTER COLUMN seq SET NOT NULL,
  ADD PRIMARY KEY (id);

-- Unique chain position per stone.
ALTER TABLE provenance_events
  ADD CONSTRAINT provenance_seq_unique UNIQUE (stone_id, seq);

CREATE INDEX idx_provenance_id  ON provenance_events(id);
CREATE INDEX idx_provenance_seq ON provenance_events(stone_id, seq);

-- ── 2. Immutability triggers ──────────────────────────────────────────────────
-- Modifying a past event would break hash-chain validation.  These triggers
-- enforce the append-only guarantee at the DB layer regardless of which
-- PostgreSQL role connects.

CREATE OR REPLACE FUNCTION prevent_passport_modification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Provenance events are immutable — the Diamond Passport append-only guarantee '
    'prohibits modifications to existing events.';
END;
$$;

CREATE TRIGGER no_update_provenance
  BEFORE UPDATE ON provenance_events
  FOR EACH ROW EXECUTE FUNCTION prevent_passport_modification();

CREATE TRIGGER no_delete_provenance
  BEFORE DELETE ON provenance_events
  FOR EACH ROW EXECUTE FUNCTION prevent_passport_modification();

-- ── 3. Sequence function for append ──────────────────────────────────────────
-- Returns the next seq value for a stone (max + 1, or 1 for first event).
CREATE OR REPLACE FUNCTION next_passport_seq(p_stone_id uuid)
RETURNS integer
LANGUAGE sql
AS $$
  SELECT COALESCE(MAX(seq), 0) + 1
  FROM provenance_events
  WHERE stone_id = p_stone_id;
$$;
