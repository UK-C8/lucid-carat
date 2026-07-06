-- Phase 2 Step 3: Lightweight CRM (FR-7).
--
-- Buyer accounts and groups are reused from V016 (no duplication).
-- New tables:
--   shared_lists        — named collections of stones scoped to a buyer or group
--   shared_list_stones  — stones in each list
--   inquiries           — one per (buyer, stone), holds lifecycle status
--   inquiry_events      — append-only timeline of all events on an inquiry

-- ── Enums ─────────────────────────────────────────────────────────────────────

CREATE TYPE inquiry_status AS ENUM (
  'open',       -- buyer submitted, awaiting sales response
  'quoted',     -- sales sent a quote price/message
  'ordered',    -- soft reservation (no payment)
  'closed',     -- completed / won
  'declined'    -- declined by either party
);

CREATE TYPE inquiry_event_type AS ENUM (
  'inquiry_submitted',
  'quote_sent',
  'order_reserved',
  'closed',
  'declined',
  'note_added'    -- internal sales note
);

-- ── Shared lists ──────────────────────────────────────────────────────────────

CREATE TABLE shared_lists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  -- Scoped to a buyer or a group (or neither = internal list)
  buyer_id        uuid REFERENCES users(id)        ON DELETE SET NULL,
  buyer_group_id  uuid REFERENCES buyer_groups(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES users(id)        ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shared_list_stones (
  shared_list_id  uuid NOT NULL REFERENCES shared_lists(id) ON DELETE CASCADE,
  stone_id        uuid NOT NULL REFERENCES stones(id)       ON DELETE CASCADE,
  tenant_id       uuid NOT NULL,
  added_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shared_list_id, stone_id)
);

CREATE INDEX idx_shared_lists_tenant      ON shared_lists(tenant_id);
CREATE INDEX idx_shared_lists_buyer       ON shared_lists(buyer_id)       WHERE buyer_id IS NOT NULL;
CREATE INDEX idx_shared_lists_group       ON shared_lists(buyer_group_id) WHERE buyer_group_id IS NOT NULL;
CREATE INDEX idx_shared_list_stones_stone ON shared_list_stones(stone_id);

CREATE TRIGGER set_updated_at_shared_lists
  BEFORE UPDATE ON shared_lists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Inquiries ─────────────────────────────────────────────────────────────────

CREATE TABLE inquiries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  buyer_id        uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  stone_id        uuid NOT NULL REFERENCES stones(id)  ON DELETE CASCADE,
  status          inquiry_status NOT NULL DEFAULT 'open',
  -- Buyer's initial message
  message         text,
  -- Latest quote from sales (updated in-place; full history is in inquiry_events)
  quoted_price_usd  numeric(12,2),
  quote_message     text,
  -- Soft order / reservation note
  order_note        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- One open inquiry per buyer per stone (re-use for renegotiation)
  UNIQUE (tenant_id, buyer_id, stone_id)
);

CREATE INDEX idx_inquiries_tenant_status ON inquiries(tenant_id, status);
CREATE INDEX idx_inquiries_buyer         ON inquiries(buyer_id);
CREATE INDEX idx_inquiries_stone         ON inquiries(stone_id);

CREATE TRIGGER set_updated_at_inquiries
  BEFORE UPDATE ON inquiries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Inquiry events (append-only timeline) ─────────────────────────────────────

CREATE TABLE inquiry_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id    uuid NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL,
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type    inquiry_event_type NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

-- No UPDATE or DELETE trigger — append-only by convention.
CREATE INDEX idx_inquiry_events_inquiry    ON inquiry_events(inquiry_id, occurred_at DESC);
CREATE INDEX idx_inquiry_events_tenant     ON inquiry_events(tenant_id, occurred_at DESC);
CREATE INDEX idx_inquiry_events_buyer      ON inquiry_events(tenant_id, actor_id, occurred_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE shared_lists       ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_list_stones ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiries          ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_events     ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  shared_lists, shared_list_stones, inquiries, inquiry_events
TO lucidcarat_app;

CREATE POLICY tenant_isolation ON shared_lists
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON shared_list_stones
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON inquiries
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON inquiry_events
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
