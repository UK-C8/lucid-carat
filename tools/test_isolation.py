#!/usr/bin/env python3
"""
Phase 2 Step 1 — Tenant Isolation Test (FR-11, BR-8).

Proves that PostgreSQL Row-Level Security blocks cross-tenant data access
at the data layer, not just at the application/query layer.

Test flow:
1. Connect as lucidcarat_app (RLS enforced; no BYPASSRLS).
2. Set tenant context to Shree Diamonds → create a test stone.
3. Switch tenant context to Rival Diamonds.
4. Attempt to read Shree's stone → must return 0 rows.
5. Attempt a direct SELECT without any tenant context → must also return 0 rows
   (RLS denies when app.current_tenant_id is not set).
6. Confirm the stone is visible when context is restored to Shree Diamonds.
"""

import os
import sys
import uuid
import psycopg

DB_OWNER_URL = os.environ.get(
    "LC_DATABASE_URL",
    "postgresql://urvilkargathala@localhost/lucidcarat_dev",
)
DB_APP_URL = os.environ.get(
    "LC_APP_DATABASE_URL",
    "postgresql://lucidcarat_app:lucidcarat_app_dev@localhost/lucidcarat_dev",
)

SHREE_TENANT_ID  = "0244ee3c-de6c-4599-8386-cd81dc240fd6"
RIVAL_TENANT_ID  = "b1000000-0000-0000-0000-000000000002"
SHREE_ADMIN_ID   = None  # looked up at runtime

PASS = "\033[32m✓ PASS\033[0m"
FAIL = "\033[31m✗ FAIL\033[0m"

results: list[dict] = []

def check(name: str, condition: bool, detail: str = ""):
    status = PASS if condition else FAIL
    results.append({"name": name, "passed": condition, "detail": detail})
    print(f"  {status}  {name}" + (f"  [{detail}]" if detail else ""))
    return condition


def set_tenant(conn, tenant_id: str):
    conn.execute(
        "SELECT set_config('app.current_tenant_id', %s, TRUE)",
        (tenant_id,),
    )


def main():
    print("\n=== LucidCarat Tenant Isolation Test ===\n")

    # ── Step 0: look up Shree admin user ID via owner connection ────────────────
    with psycopg.connect(DB_OWNER_URL) as owner:
        row = owner.execute(
            "SELECT id FROM users WHERE email = 'admin@diamonds.local' LIMIT 1"
        ).fetchone()
        if not row:
            print(f"{FAIL}  Cannot find admin@diamonds.local — run V015 seed first.")
            sys.exit(1)
        global SHREE_ADMIN_ID
        SHREE_ADMIN_ID = str(row[0])
        print(f"  Shree admin user id : {SHREE_ADMIN_ID}")
        print(f"  Shree tenant id     : {SHREE_TENANT_ID}")
        print(f"  Rival tenant id     : {RIVAL_TENANT_ID}\n")

    # ── Step 1: create a test stone in Shree Diamonds via OWNER connection ──────
    # (owner bypasses RLS — this simulates what the grading service does)
    test_stone_id = str(uuid.uuid4())
    with psycopg.connect(DB_OWNER_URL) as owner:
        owner.execute(
            """INSERT INTO stones
               (id, tenant_id, internal_ref, status, video_s3_key, cert_s3_key)
               VALUES (%s, %s, 'ISOLATION-TEST', 'uploaded', 'local/test', 'local/test')""",
            (test_stone_id, SHREE_TENANT_ID),
        )
        owner.commit()
        print(f"  Created test stone  : {test_stone_id}")
        cnt = owner.execute(
            "SELECT count(*) FROM stones WHERE id = %s", (test_stone_id,)
        ).fetchone()[0]
        check("Owner can see the stone (sanity check)", cnt == 1, f"count={cnt}")

    print()

    # ── Step 2: connect as lucidcarat_app (RLS enforced) ───────────────────────
    with psycopg.connect(DB_APP_URL, autocommit=False) as app:

        # 2a. Correct tenant context → stone visible
        with app.transaction():
            set_tenant(app, SHREE_TENANT_ID)
            row = app.execute(
                "SELECT id FROM stones WHERE id = %s", (test_stone_id,)
            ).fetchone()
        check(
            "lucidcarat_app with Shree context sees Shree's stone",
            row is not None,
            f"id={row[0] if row else None}",
        )

        # 2b. Wrong tenant context → stone invisible (RLS blocks it)
        with app.transaction():
            set_tenant(app, RIVAL_TENANT_ID)
            row = app.execute(
                "SELECT id FROM stones WHERE id = %s", (test_stone_id,)
            ).fetchone()
        check(
            "lucidcarat_app with Rival context CANNOT see Shree's stone [RLS enforced]",
            row is None,
            f"returned={row}",
        )

        # 2c. No tenant context at all → stone invisible
        with app.transaction():
            app.execute("SELECT set_config('app.current_tenant_id', '', TRUE)")
            row = app.execute(
                "SELECT id FROM stones WHERE id = %s", (test_stone_id,)
            ).fetchone()
        check(
            "lucidcarat_app with NO context CANNOT see Shree's stone [RLS enforced]",
            row is None,
            f"returned={row}",
        )

        # 2d. Rival cannot insert a stone into Shree's tenant (WITH CHECK)
        rival_stone_id = str(uuid.uuid4())
        insert_blocked = False
        with app.transaction():
            set_tenant(app, RIVAL_TENANT_ID)
            try:
                app.execute(
                    """INSERT INTO stones
                       (id, tenant_id, internal_ref, status, video_s3_key, cert_s3_key)
                       VALUES (%s, %s, 'RIVAL-INJECT', 'uploaded', 'local/x', 'local/x')""",
                    (rival_stone_id, SHREE_TENANT_ID),  # wrong tenant in row
                )
            except psycopg.errors.CheckViolation:
                insert_blocked = True
            except Exception as exc:
                # RLS WITH CHECK raises InsufficientPrivilege or similar
                insert_blocked = True
                _ = exc
        check(
            "lucidcarat_app with Rival context CANNOT write into Shree's tenant [RLS WITH CHECK]",
            insert_blocked,
        )

        # 2e. Audit log: Rival cannot read Shree's audit events
        with app.transaction():
            set_tenant(app, RIVAL_TENANT_ID)
            cnt = app.execute(
                "SELECT count(*) FROM audit_log WHERE tenant_id = %s",
                (SHREE_TENANT_ID,),
            ).fetchone()[0]
        check(
            "lucidcarat_app with Rival context sees 0 Shree audit_log rows [RLS enforced]",
            cnt == 0,
            f"count={cnt}",
        )

    # ── Step 3: clean up ────────────────────────────────────────────────────────
    with psycopg.connect(DB_OWNER_URL) as owner:
        owner.execute("DELETE FROM stones WHERE id = %s", (test_stone_id,))
        owner.commit()
    print("\n  (Test stone deleted)\n")

    # ── Summary ─────────────────────────────────────────────────────────────────
    passed = sum(1 for r in results if r["passed"])
    total  = len(results)
    print(f"=== Result: {passed}/{total} checks passed ===\n")
    if passed < total:
        sys.exit(1)


if __name__ == "__main__":
    main()
