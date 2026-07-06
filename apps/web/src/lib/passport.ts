// Diamond Passport hash-chain engine (FR-8, BR-4).
//
// Hash function: SHA-256 over NULL-byte-separated canonical fields.
// Canonical form uses sorted-key JSON to prevent key-order manipulation.
//
//   event_hash = SHA256(
//     prev_hash + "\x00" + stone_id + "\x00" + event_type + "\x00" +
//     sorted_json(payload) + "\x00" + occurred_at_iso
//   )
//
// The GENESIS sentinel is used as prev_hash for the first event in a chain.
// Polygon anchoring is omitted per scope (FR-9 "Could" priority — separate step).

import { createHash } from "crypto";
import { query, queryAsTenant } from "./db";

export const GENESIS = "GENESIS";

export interface PassportEvent {
  id: string;
  seq: number;
  stone_id: string;
  tenant_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  location: string | null;
  actor_id: string | null;
  occurred_at: string;
  prev_event_hash: string;
  event_hash: string;
}

// ── Hash computation ──────────────────────────────────────────────────────────

function sortedJson(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj !== "object" || Array.isArray(obj)) return JSON.stringify(obj);
  const sorted = Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  );
  return JSON.stringify(sorted);
}

export function computeEventHash(fields: {
  prev_event_hash: string;
  stone_id: string;
  event_type: string;
  payload: unknown;
  occurred_at: string;
}): string {
  const data = [
    fields.prev_event_hash,
    fields.stone_id,
    fields.event_type,
    sortedJson(fields.payload),
    new Date(fields.occurred_at).toISOString(),
  ].join("\x00");
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// ── Chain validation ──────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  event_count: number;
  tampered_at_seq?: number;
  tampered_event_id?: string;
  detail: string;
}

export function validateChain(events: PassportEvent[]): ValidationResult {
  if (!events.length) {
    return { valid: true, event_count: 0, detail: "Empty chain" };
  }

  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  for (let i = 0; i < sorted.length; i++) {
    const evt = sorted[i];
    const expectedPrev = i === 0 ? GENESIS : sorted[i - 1].event_hash;

    // Verify prev_hash linkage.
    if (evt.prev_event_hash !== expectedPrev) {
      return {
        valid: false,
        event_count: events.length,
        tampered_at_seq: evt.seq,
        tampered_event_id: evt.id,
        detail: `Chain break at seq ${evt.seq}: prev_hash mismatch. ` +
                `Expected ${expectedPrev.slice(0, 16)}… got ${evt.prev_event_hash?.slice(0, 16) ?? "null"}…`,
      };
    }

    // Recompute and verify event hash.
    const recomputed = computeEventHash({
      prev_event_hash: evt.prev_event_hash,
      stone_id: evt.stone_id,
      event_type: evt.event_type,
      payload: evt.payload,
      occurred_at: evt.occurred_at,
    });

    if (recomputed !== evt.event_hash) {
      return {
        valid: false,
        event_count: events.length,
        tampered_at_seq: evt.seq,
        tampered_event_id: evt.id,
        detail: `Tampered event at seq ${evt.seq} (id ${evt.id}): ` +
                `stored hash ${evt.event_hash.slice(0, 16)}… ≠ recomputed ${recomputed.slice(0, 16)}…`,
      };
    }
  }

  return {
    valid: true,
    event_count: events.length,
    detail: `Chain of ${events.length} events verified. Head hash: ${sorted[sorted.length - 1].event_hash.slice(0, 16)}…`,
  };
}

// ── Append an event ───────────────────────────────────────────────────────────
// Must run serialised per stone (caller holds DB advisory lock or accepts
// potential race; for Phase 2 single-writer risk is low).

export async function appendPassportEvent(opts: {
  tenantId: string;
  stoneId: string;
  eventType: string;
  payload: Record<string, unknown>;
  actorId?: string | null;
  location?: string | null;
}): Promise<PassportEvent> {
  // Owner-level query to get the current chain tip (bypasses RLS — needed
  // because Python services and internal triggers also call this path).
  const tip = await query<{ event_hash: string; seq: number }>(
    `SELECT event_hash, seq
     FROM provenance_events
     WHERE stone_id = $1
     ORDER BY seq DESC
     LIMIT 1`,
    [opts.stoneId]
  );

  const prevHash = tip.length ? tip[0].event_hash : GENESIS;
  const seq = tip.length ? tip[0].seq + 1 : 1;
  const occurredAt = new Date().toISOString();

  const eventHash = computeEventHash({
    prev_event_hash: prevHash,
    stone_id: opts.stoneId,
    event_type: opts.eventType,
    payload: opts.payload,
    occurred_at: occurredAt,
  });

  const rows = await query<PassportEvent>(
    `INSERT INTO provenance_events
       (stone_id, tenant_id, event_type, payload, actor_id, location,
        occurred_at, prev_event_hash, event_hash, seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      opts.stoneId,
      opts.tenantId,
      opts.eventType,
      JSON.stringify(opts.payload),
      opts.actorId ?? null,
      opts.location ?? null,
      occurredAt,
      prevHash,
      eventHash,
      seq,
    ]
  );

  // Audit log (CLAUDE.md §11: passport_event_appended).
  await query(
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'passport_event_appended', 'provenance_event', $3, $4)`,
    [
      opts.tenantId,
      opts.actorId ?? null,
      rows[0].id,
      JSON.stringify({ event_type: opts.eventType, seq, stone_id: opts.stoneId }),
    ]
  );

  return rows[0];
}

// ── Fetch full chain ──────────────────────────────────────────────────────────

export async function getPassportChain(tenantId: string, stoneId: string): Promise<PassportEvent[]> {
  return queryAsTenant<PassportEvent>(
    tenantId,
    `SELECT pe.*, u.email AS actor_email
     FROM provenance_events pe
     LEFT JOIN users u ON u.id = pe.actor_id
     WHERE pe.stone_id = $1
     ORDER BY pe.seq ASC`,
    [stoneId]
  );
}
