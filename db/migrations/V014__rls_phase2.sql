-- Phase 2 Step 1: Row-Level Security + application role
-- Tenant isolation enforced at the data layer (FR-11, BR-8).
--
-- Design:
--   lucidcarat_app  — LOGIN role used by Next.js web app; RLS is enforced.
--   lucidcarat_svc  — NOLOGIN role marker for Python services; they connect as
--                     the DB owner (BYPASSRLS implicit) — no change needed.
--
-- All tenant-scoped tables get a single PERMISSIVE policy keyed on the GUC
-- app.current_tenant_id, which the web app sets per-transaction via
-- set_config('app.current_tenant_id', $tenantId, TRUE).
--
-- Tables NOT given tenant isolation policies:
--   tenants — platform table; lucidcarat_app may only see its own row.
--   (All write paths for tenants go through the owner/migration scripts.)

-- ── 1. Role setup ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lucidcarat_app') THEN
    CREATE ROLE lucidcarat_app LOGIN PASSWORD 'lucidcarat_app_dev';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lucidcarat_svc') THEN
    CREATE ROLE lucidcarat_svc NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO lucidcarat_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  stones, certificates, grading_results, grading_overrides,
  price_forecasts, price_history, audit_log, provenance_events,
  users, tenants
TO lucidcarat_app;

-- Sequences (needed for any serial PKs that remain)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lucidcarat_app;

-- ── 2. Tenant-ID helper ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid;
$$;

-- ── 3. Enable RLS ─────────────────────────────────────────────────────────────

ALTER TABLE stones              ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificates        ENABLE ROW LEVEL SECURITY;
ALTER TABLE grading_results     ENABLE ROW LEVEL SECURITY;
ALTER TABLE grading_overrides   ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_forecasts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE provenance_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants             ENABLE ROW LEVEL SECURITY;

-- ── 4. RLS policies ───────────────────────────────────────────────────────────
-- Each policy is PERMISSIVE (default), FOR ALL operations, TO lucidcarat_app.
-- The DB owner bypasses RLS implicitly (Python services, migrations).

CREATE POLICY tenant_isolation ON stones
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON certificates
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON grading_results
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON grading_overrides
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON price_forecasts
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON price_history
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- audit_log: INSERT is allowed (app writes events); SELECT scoped to own tenant.
-- DELETE/UPDATE are intentionally omitted — append-only.
CREATE POLICY tenant_read ON audit_log
  FOR SELECT TO lucidcarat_app
  USING (tenant_id = current_tenant_id());

CREATE POLICY tenant_write ON audit_log
  FOR INSERT TO lucidcarat_app
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY tenant_isolation ON provenance_events
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- users: read own tenant's users only; admins manage users via owner/service paths.
CREATE POLICY tenant_users ON users
  FOR ALL TO lucidcarat_app
  USING  (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- tenants: each tenant can see only its own row.
CREATE POLICY own_tenant ON tenants
  FOR SELECT TO lucidcarat_app
  USING (id = current_tenant_id());
