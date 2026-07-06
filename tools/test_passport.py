#!/usr/bin/env python3
"""
Phase 2 Step 4 — Diamond Passport tamper test (FR-8, BR-4).

Tests:
1. Append three events to a fresh test stone and confirm chain validates.
2. Directly modify a past event's payload in the DB — verify chain validation
   catches the tampering and correctly identifies the tampered seq.
3. Directly modify a past event's prev_hash — verify broken linkage is caught.
4. Confirm the immutability trigger prevents UPDATE via psycopg (DB layer).
5. Confirm DELETE is also rejected by the DB trigger.
"""

import hashlib
import json
import os
import sys
import uuid
import psycopg
from psycopg.rows import dict_row

DB_URL = os.environ.get(
    "LC_DATABASE_URL",
    "postgresql://urvilkargathala@localhost/lucidcarat_dev",
)

SHREE_TENANT_ID = "0244ee3c-de6c-4599-8386-cd81dc240fd6"
SHREE_ADMIN_ID  = "00000000-0000-0000-0000-000000000001"
GENESIS         = "GENESIS"

PASS = "\033[32m✓ PASS\033[0m"
FAIL = "\033[31m✗ FAIL\033[0m"
results: list[dict] = []

# ── Hash function (must match apps/web/src/lib/passport.ts) ───────────────────

def sorted_json(obj) -> str:
    """Must match apps/web/src/lib/passport.ts sortedJson exactly.
    TS uses JSON.stringify (compact, no spaces) with top-level key sort only."""
    if obj is None:
        return "null"
    if isinstance(obj, dict):
        return json.dumps(dict(sorted(obj.items())), separators=(',', ':'))
    return json.dumps(obj, separators=(',', ':'))

def compute_hash(prev_hash: str, stone_id: str, event_type: str, payload: dict, occurred_at: str) -> str:
    from datetime import timezone, datetime
    # Normalise to ISO 8601 with Z suffix, matching JS Date.toISOString()
    dt = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
    iso = dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
          f"{dt.microsecond // 1000:03d}Z"
    data = "\x00".join([prev_hash, stone_id, event_type, sorted_json(payload), iso])
    return hashlib.sha256(data.encode("utf-8")).hexdigest()

# ── Chain helpers ─────────────────────────────────────────────────────────────

def fetch_chain(conn, stone_id: str) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            "SELECT id, seq, event_type, payload, occurred_at, prev_event_hash, event_hash "
            "FROM provenance_events WHERE stone_id = %s ORDER BY seq",
            (stone_id,),
        )
        return cur.fetchall()

def validate_chain(events: list[dict]) -> dict:
    if not events:
        return {"valid": True, "detail": "Empty chain"}
    for i, ev in enumerate(events):
        expected_prev = GENESIS if i == 0 else events[i - 1]["event_hash"]
        if ev["prev_event_hash"] != expected_prev:
            return {
                "valid": False,
                "tampered_seq": ev["seq"],
                "detail": f"prev_hash mismatch at seq {ev['seq']}",
            }
        recomputed = compute_hash(
            ev["prev_event_hash"],
            str(ev.get("stone_id", "")),
            ev["event_type"],
            ev["payload"] if isinstance(ev["payload"], dict) else json.loads(ev["payload"]),
            ev["occurred_at"].isoformat() if hasattr(ev["occurred_at"], "isoformat") else ev["occurred_at"],
        )
        if recomputed != ev["event_hash"]:
            return {
                "valid": False,
                "tampered_seq": ev["seq"],
                "detail": f"hash mismatch at seq {ev['seq']}: stored={ev['event_hash'][:16]}… recomputed={recomputed[:16]}…",
            }
    return {"valid": True, "detail": f"Chain of {len(events)} events valid"}

def append_event(conn, stone_id: str, event_type: str, payload: dict, seq: int, prev_hash: str):
    occurred_at = conn.execute("SELECT NOW()").fetchone()[0]
    event_hash = compute_hash(
        prev_hash,
        stone_id,
        event_type,
        payload,
        occurred_at.isoformat(),
    )
    row = conn.execute(
        """INSERT INTO provenance_events
           (stone_id, tenant_id, event_type, payload, actor_id, occurred_at,
            prev_event_hash, event_hash, seq)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
           RETURNING id, event_hash""",
        (stone_id, SHREE_TENANT_ID, event_type, json.dumps(payload),
         SHREE_ADMIN_ID, occurred_at, prev_hash, event_hash, seq),
    ).fetchone()
    conn.commit()
    return str(row[0]), event_hash

def check(name: str, condition: bool, detail: str = ""):
    status = PASS if condition else FAIL
    results.append({"name": name, "passed": condition})
    print(f"  {status}  {name}" + (f"  [{detail}]" if detail else ""))

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("\n=== Diamond Passport Tamper Test ===\n")

    # Create a fresh test stone owned by Shree Diamonds.
    stone_id = str(uuid.uuid4())
    with psycopg.connect(DB_URL, autocommit=True) as owner:
        owner.execute(
            """INSERT INTO stones
               (id, tenant_id, internal_ref, status, video_s3_key, cert_s3_key,
                confirmed_color, confirmed_clarity, confirmed_cut, confirmed_at)
               VALUES (%s,%s,'PASSPORT-TEST','priced','local/x','local/x','D','IF','Excellent',NOW())""",
            (stone_id, SHREE_TENANT_ID),
        )
        print(f"  Test stone: {stone_id}\n")

        # ── Test 1: Build a valid 3-event chain ──────────────────────────────
        print("--- Test 1: Build valid 3-event chain ---")
        events = [
            ("stone_registered",      {"source": "Botswana rough", "mine": "Jwaneng"}),
            ("grading_completed",     {"color": "D", "clarity": "IF", "cut": "Excellent", "model": "0.1.0"}),
            ("stone_published",       {"published_by": "admin@diamonds.local"}),
        ]
        prev = GENESIS
        for i, (etype, payload) in enumerate(events, start=1):
            eid, ehash = append_event(owner, stone_id, etype, payload, i, prev)
            prev = ehash
            print(f"    seq {i}: {etype}  hash={ehash[:16]}…")

        chain = fetch_chain(owner, stone_id)
        # Need stone_id in each row for validate_chain
        for ev in chain:
            ev["stone_id"] = stone_id
        result = validate_chain(chain)
        check("Valid 3-event chain passes validation", result["valid"], result["detail"])
        print()

        # ── Test 2: Tamper with seq 1 payload ────────────────────────────────
        print("--- Test 2: Tamper payload of seq 1 event ---")
        # Bypass immutability trigger by using owner + direct SQL
        # (This simulates a DBA-level attack — the chain must still catch it)
        # We must drop the trigger temporarily to simulate the tamper.
        owner.execute("DROP TRIGGER IF EXISTS no_update_provenance ON provenance_events")
        owner.execute(
            "UPDATE provenance_events SET payload = %s WHERE stone_id = %s AND seq = 1",
            (json.dumps({"source": "TAMPERED DATA", "mine": "HACKED"}), stone_id),
        )
        owner.execute(
            "CREATE TRIGGER no_update_provenance BEFORE UPDATE ON provenance_events "
            "FOR EACH ROW EXECUTE FUNCTION prevent_passport_modification()"
        )

        chain = fetch_chain(owner, stone_id)
        for ev in chain:
            ev["stone_id"] = stone_id
        result = validate_chain(chain)
        check("Tampered payload detected by chain validation", not result["valid"],
              result.get("detail", ""))
        check("Tampered event correctly identified at seq 1",
              result.get("tampered_seq") == 1,
              f"tampered_seq={result.get('tampered_seq')}")
        print()

        # ── Restore: rebuild chain with correct hashes ───────────────────────
        owner.execute("DROP TRIGGER IF EXISTS no_update_provenance ON provenance_events")
        owner.execute(
            "UPDATE provenance_events SET payload = %s WHERE stone_id = %s AND seq = 1",
            (json.dumps({"source": "Botswana rough", "mine": "Jwaneng"}), stone_id),
        )
        # Re-compute all event hashes after restoring seq 1
        owner.execute("CREATE TRIGGER no_update_provenance BEFORE UPDATE ON provenance_events "
                      "FOR EACH ROW EXECUTE FUNCTION prevent_passport_modification()")

        # ── Test 3: Tamper prev_hash on seq 2 ────────────────────────────────
        print("--- Test 3: Tamper prev_hash of seq 2 (chain linkage break) ---")
        owner.execute("DROP TRIGGER IF EXISTS no_update_provenance ON provenance_events")
        owner.execute(
            "UPDATE provenance_events SET prev_event_hash = %s WHERE stone_id = %s AND seq = 2",
            ("deadbeef" * 8, stone_id),
        )
        owner.execute("CREATE TRIGGER no_update_provenance BEFORE UPDATE ON provenance_events "
                      "FOR EACH ROW EXECUTE FUNCTION prevent_passport_modification()")

        chain = fetch_chain(owner, stone_id)
        for ev in chain:
            ev["stone_id"] = stone_id
        result = validate_chain(chain)
        check("Broken prev_hash linkage detected at seq 2", not result["valid"],
              result.get("detail", ""))
        check("Break correctly identified at seq 2",
              result.get("tampered_seq") == 2,
              f"tampered_seq={result.get('tampered_seq')}")
        print()

        # ── Test 4: Immutability trigger blocks UPDATE (as non-owner) ────────
        print("--- Test 4: Immutability trigger rejects UPDATE via app role ---")
        # Restore seq 2 prev_hash first (drop trigger, fix, re-create)
        owner.execute("DROP TRIGGER IF EXISTS no_update_provenance ON provenance_events")
        correct_seq1_hash = owner.execute(
            "SELECT event_hash FROM provenance_events WHERE stone_id = %s AND seq = 1",
            (stone_id,)
        ).fetchone()[0]
        owner.execute(
            "UPDATE provenance_events SET prev_event_hash = %s WHERE stone_id = %s AND seq = 2",
            (correct_seq1_hash, stone_id),
        )
        owner.execute("CREATE TRIGGER no_update_provenance BEFORE UPDATE ON provenance_events "
                      "FOR EACH ROW EXECUTE FUNCTION prevent_passport_modification()")

    # Now try UPDATE as lucidcarat_app — trigger must fire.
    app_url = os.environ.get(
        "LC_APP_DATABASE_URL",
        "postgresql://lucidcarat_app:lucidcarat_app_dev@localhost/lucidcarat_dev",
    )
    with psycopg.connect(app_url, autocommit=False) as app:
        blocked = False
        try:
            with app.transaction():
                app.execute("SELECT set_config('app.current_tenant_id',%s,TRUE)", (SHREE_TENANT_ID,))
                app.execute(
                    "UPDATE provenance_events SET payload = %s WHERE stone_id = %s AND seq = 1",
                    ('{"tamper":"attempt"}', stone_id),
                )
        except Exception as exc:
            blocked = "immutable" in str(exc).lower() or "append-only" in str(exc).lower() \
                      or "prohibit" in str(exc).lower()
        check("Immutability trigger blocks UPDATE via lucidcarat_app", blocked)

    # ── Test 5: Immutability trigger blocks DELETE ────────────────────────────
    print()
    print("--- Test 5: Immutability trigger rejects DELETE ---")
    with psycopg.connect(app_url, autocommit=False) as app:
        blocked = False
        try:
            with app.transaction():
                app.execute("SELECT set_config('app.current_tenant_id',%s,TRUE)", (SHREE_TENANT_ID,))
                app.execute(
                    "DELETE FROM provenance_events WHERE stone_id = %s AND seq = 1",
                    (stone_id,),
                )
        except Exception:
            blocked = True
        check("Immutability trigger blocks DELETE via lucidcarat_app", blocked)

    # ── Cleanup ───────────────────────────────────────────────────────────────
    with psycopg.connect(DB_URL, autocommit=True) as owner:
        owner.execute("DROP TRIGGER IF EXISTS no_update_provenance ON provenance_events")
        owner.execute("DROP TRIGGER IF EXISTS no_delete_provenance  ON provenance_events")
        owner.execute("DELETE FROM provenance_events WHERE stone_id = %s", (stone_id,))
        owner.execute("DELETE FROM stones WHERE id = %s", (stone_id,))
        # Re-create triggers
        owner.execute("CREATE TRIGGER no_update_provenance BEFORE UPDATE ON provenance_events "
                      "FOR EACH ROW EXECUTE FUNCTION prevent_passport_modification()")
        owner.execute("CREATE TRIGGER no_delete_provenance BEFORE DELETE ON provenance_events "
                      "FOR EACH ROW EXECUTE FUNCTION prevent_passport_modification()")

    print("\n  (Test stone and events deleted)\n")
    passed = sum(1 for r in results if r["passed"])
    total  = len(results)
    print(f"=== Result: {passed}/{total} checks passed ===\n")
    if passed < total:
        sys.exit(1)

if __name__ == "__main__":
    main()
