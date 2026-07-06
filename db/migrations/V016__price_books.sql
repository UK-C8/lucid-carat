-- Phase 2 Step 2: B2B catalog price books (FR-6, BR-3).
--
-- Stale-price policy (agreed):
--   > 30 days since last_refreshed_at → stale (flag + buyer warning)
--   > 60 days since last_refreshed_at → hard blocked (buyer sees "contact us")
--
-- Price resolution for a buyer:
--   1. Use price_book_entries.custom_price_usd when set.
--   2. Else fall back to the stone's current adjusted_price_usd from price_forecasts.
--   Fair_price_usd is NEVER exposed to buyers.
--
-- Scoping: a buyer sees a stone iff:
--   - stone.status = 'published'
--   - a price_book_entries row exists for that buyer (direct user_id match)
--     OR for a buyer_group the buyer belongs to
--   - the entry is not hard-blocked (last_refreshed_at + 60d > now)

-- ── Buyer groups ──────────────────────────────────────────────────────────────

CREATE TABLE buyer_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE buyer_group_members (
  buyer_group_id  uuid NOT NULL REFERENCES buyer_groups(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (buyer_group_id, user_id)
);

CREATE INDEX idx_buyer_group_members_user ON buyer_group_members(user_id);
CREATE INDEX idx_buyer_groups_tenant       ON buyer_groups(tenant_id);

-- ── Price book entries ─────────────────────────────────────────────────────────
-- Exactly one of (buyer_id, buyer_group_id) must be non-null per row.

CREATE TABLE price_book_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stone_id          uuid NOT NULL REFERENCES stones(id)  ON DELETE CASCADE,

  -- Exactly one target: individual buyer or group
  buyer_id          uuid REFERENCES users(id)        ON DELETE CASCADE,
  buyer_group_id    uuid REFERENCES buyer_groups(id) ON DELETE CASCADE,

  -- Optional override price; NULL means fall back to stone adjusted_price_usd
  custom_price_usd  numeric(12,2) CHECK (custom_price_usd > 0),

  -- Stale-price tracking
  last_refreshed_at timestamptz NOT NULL DEFAULT now(),

  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pbe_one_target CHECK (
    (buyer_id IS NOT NULL)::int + (buyer_group_id IS NOT NULL)::int = 1
  ),
  -- Prevent duplicate assignments for same stone+target
  UNIQUE NULLS NOT DISTINCT (tenant_id, stone_id, buyer_id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, stone_id, buyer_group_id)
);

CREATE INDEX idx_pbe_tenant_stone   ON price_book_entries(tenant_id, stone_id);
CREATE INDEX idx_pbe_buyer          ON price_book_entries(buyer_id)       WHERE buyer_id IS NOT NULL;
CREATE INDEX idx_pbe_buyer_group    ON price_book_entries(buyer_group_id) WHERE buyer_group_id IS NOT NULL;
CREATE INDEX idx_pbe_stale_check    ON price_book_entries(tenant_id, last_refreshed_at);

-- ── updated_at triggers ───────────────────────────────────────────────────────

CREATE TRIGGER set_updated_at_buyer_groups
  BEFORE UPDATE ON buyer_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_updated_at_price_book_entries
  BEFORE UPDATE ON price_book_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS for new tables ────────────────────────────────────────────────────────

ALTER TABLE buyer_groups         ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyer_group_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_book_entries   ENABLE ROW LEVEL SECURITY;

-- lucidcarat_app permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON buyer_groups, buyer_group_members, price_book_entries TO lucidcarat_app;

CREATE POLICY tenant_isolation ON buyer_groups
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON buyer_group_members
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON price_book_entries
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ── View: resolved buyer catalog ─────────────────────────────────────────────
-- Returns one row per (stone, buyer) for published stones the buyer may see.
-- Includes stale status. The application joins this to serve the catalog.

CREATE OR REPLACE VIEW buyer_catalog AS
SELECT
  pbe.id             AS entry_id,
  pbe.tenant_id,
  pbe.stone_id,
  -- Resolve the effective buyer_id (direct or via group)
  COALESCE(pbe.buyer_id, bgm.user_id)  AS buyer_id,
  pbe.buyer_group_id,
  pbe.custom_price_usd,
  pbe.last_refreshed_at,
  -- Stale flags
  (now() - pbe.last_refreshed_at) > INTERVAL '30 days'  AS is_stale,
  (now() - pbe.last_refreshed_at) > INTERVAL '60 days'  AS is_hard_blocked,
  s.status,
  s.internal_ref,
  s.shape,
  s.carat_weight,
  s.confirmed_color,
  s.confirmed_clarity,
  s.confirmed_cut,
  s.list_price_usd,
  -- Effective price: custom override or stone adjusted price from forecast
  COALESCE(
    pbe.custom_price_usd,
    (SELECT pf.fair_price_usd * (1 + pf.markup_pct / 100.0)
     FROM price_forecasts pf
     WHERE pf.stone_id = s.id AND pf.is_current = true
     LIMIT 1)
  )                  AS effective_price_usd
FROM price_book_entries pbe
JOIN stones s ON s.id = pbe.stone_id AND s.status = 'published'
-- Expand group entries to individual buyers
LEFT JOIN buyer_group_members bgm
       ON bgm.buyer_group_id = pbe.buyer_group_id
      AND pbe.buyer_id IS NULL;

GRANT SELECT ON buyer_catalog TO lucidcarat_app;
