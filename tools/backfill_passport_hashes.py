#!/usr/bin/env python3
"""
One-time backfill: compute and store event_hash + prev_event_hash
for all provenance_events that currently have NULL hashes.

Runs as owner (BYPASSRLS), so it can UPDATE. The immutability trigger
must be temporarily disabled since these events genuinely have no hashes yet.
"""

import hashlib
import json
import os
import sys
import psycopg
from psycopg.rows import dict_row

DB_URL = os.environ.get(
    "LC_DATABASE_URL",
    "postgresql://urvilkargathala@localhost/lucidcarat_dev",
)

GENESIS = "GENESIS"

def sorted_json(obj) -> str:
    """Must match apps/web/src/lib/passport.ts sortedJson exactly.
    TS uses JSON.stringify (compact, no spaces) with top-level key sort only."""
    if obj is None:
        return "null"
    if isinstance(obj, dict):
        return json.dumps(dict(sorted(obj.items())), separators=(',', ':'))
    return json.dumps(obj, separators=(',', ':'))

def compute_hash(prev_hash, stone_id, event_type, payload, occurred_at) -> str:
    from datetime import timezone, datetime
    dt = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
    iso = dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
          f"{dt.microsecond // 1000:03d}Z"
    data = "\x00".join([prev_hash, stone_id, event_type, sorted_json(payload), iso])
    return hashlib.sha256(data.encode("utf-8")).hexdigest()

def main():
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        # Temporarily disable immutability triggers for this backfill.
        conn.execute("DROP TRIGGER IF EXISTS no_update_provenance ON provenance_events")
        try:
            # Fetch all events with NULL hashes, grouped by stone, in seq order.
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    "SELECT id, stone_id, seq, event_type, payload, occurred_at "
                    "FROM provenance_events "
                    "WHERE event_hash IS NULL "
                    "ORDER BY stone_id, seq"
                )
                rows = cur.fetchall()

            print(f"Backfilling {len(rows)} events…")

            # Group by stone_id.
            from collections import defaultdict
            by_stone: dict[str, list] = defaultdict(list)
            for r in rows:
                by_stone[str(r["stone_id"])].append(r)

            total = 0
            for stone_id, events in by_stone.items():
                # Determine what hash the first event's prev should be.
                # If seq > 1 there may be prior events with hashes already.
                first_seq = events[0]["seq"]
                if first_seq == 1:
                    prev = GENESIS
                else:
                    with conn.cursor() as cur:
                        cur.execute(
                            "SELECT event_hash FROM provenance_events "
                            "WHERE stone_id = %s AND seq = %s",
                            (stone_id, first_seq - 1),
                        )
                        row = cur.fetchone()
                        prev = row[0] if row and row[0] else GENESIS

                for ev in events:
                    payload = ev["payload"] if isinstance(ev["payload"], dict) else json.loads(ev["payload"])
                    h = compute_hash(
                        prev, stone_id, ev["event_type"], payload, ev["occurred_at"].isoformat()
                    )
                    conn.execute(
                        "UPDATE provenance_events SET prev_event_hash = %s, event_hash = %s WHERE id = %s",
                        (prev, h, ev["id"]),
                    )
                    prev = h
                    total += 1

            print(f"Done — backfilled {total} events.")
        finally:
            # Always re-create the trigger.
            conn.execute(
                "CREATE TRIGGER no_update_provenance BEFORE UPDATE ON provenance_events "
                "FOR EACH ROW EXECUTE FUNCTION prevent_passport_modification()"
            )

if __name__ == "__main__":
    main()
