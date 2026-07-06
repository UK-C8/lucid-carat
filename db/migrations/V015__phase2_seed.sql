-- Phase 2 seed: Rival Diamonds tenant + full role matrix for isolation testing.
-- Also adds grader/sales/viewer/buyer users to the Shree Diamonds tenant.
-- Password hash is bcrypt of 'lucidcarat' (same as admin).

DO $$
DECLARE
  shree_id  uuid := '0244ee3c-de6c-4599-8386-cd81dc240fd6';
  rival_id  uuid := 'b1000000-0000-0000-0000-000000000002';
  pw_hash   text := '$2b$10$LLWa8XFpG/HYFbMN2EiV.e4.4fQ8Dxk.qBJXOyLl4cRarh4VFcB4i';
BEGIN

  -- ── Rival Diamonds tenant ───────────────────────────────────────────────────
  INSERT INTO tenants (id, name, slug, plan, is_active)
  VALUES (rival_id, 'Rival Diamonds', 'rival-diamonds', 'starter', true)
  ON CONFLICT (id) DO NOTHING;

  -- ── Shree Diamonds — additional role users ──────────────────────────────────
  INSERT INTO users (id, tenant_id, email, password_hash, full_name, role, is_active)
  VALUES
    ('a1000001-0000-0000-0000-000000000001', shree_id,
     'grader@shree-diamonds.local',  pw_hash, 'Grader Shree',   'grader',  true),
    ('a1000002-0000-0000-0000-000000000001', shree_id,
     'sales@shree-diamonds.local',   pw_hash, 'Sales Shree',    'sales',   true),
    ('a1000003-0000-0000-0000-000000000001', shree_id,
     'viewer@shree-diamonds.local',  pw_hash, 'Viewer Shree',   'viewer',  true),
    ('a1000004-0000-0000-0000-000000000001', shree_id,
     'buyer@shree-diamonds.local',   pw_hash, 'Buyer Shree',    'buyer',   true)
  ON CONFLICT (tenant_id, email) DO NOTHING;

  -- ── Rival Diamonds — full role set ──────────────────────────────────────────
  INSERT INTO users (id, tenant_id, email, password_hash, full_name, role, is_active)
  VALUES
    ('b1000001-0000-0000-0000-000000000002', rival_id,
     'admin@rival-diamonds.local',  pw_hash, 'Admin Rival',  'admin',  true),
    ('b1000002-0000-0000-0000-000000000002', rival_id,
     'grader@rival-diamonds.local', pw_hash, 'Grader Rival', 'grader', true),
    ('b1000003-0000-0000-0000-000000000002', rival_id,
     'sales@rival-diamonds.local',  pw_hash, 'Sales Rival',  'sales',  true),
    ('b1000004-0000-0000-0000-000000000002', rival_id,
     'viewer@rival-diamonds.local', pw_hash, 'Viewer Rival', 'viewer', true),
    ('b1000005-0000-0000-0000-000000000002', rival_id,
     'buyer@rival-diamonds.local',  pw_hash, 'Buyer Rival',  'buyer',  true)
  ON CONFLICT (tenant_id, email) DO NOTHING;

END
$$;
