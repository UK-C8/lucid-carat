// FR-12, BR-7: Standalone Provenance API — fetch and validate the Diamond Passport chain.
//
// GET /api/v1/provenance/{stone_id}
// Auth: Bearer lc_<key>  (scope: provenance)
//
// Returns the full append-only hash chain for the stone with chain validation result.
// Metered per call as api_provenance_read.
import { NextRequest, NextResponse } from "next/server";
import { requireApiKey, isApiKeyError } from "@/lib/withApiKey";
import { query } from "@/lib/db";
import { getPassportChain, validateChain } from "@/lib/passport";

const STRIPE_METER_EVENT_NAME_API_PROVENANCE =
  process.env.STRIPE_METER_EVENT_NAME_API_PROVENANCE ?? "api_provenance_call";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ stone_id: string }> }
) {
  const auth = await requireApiKey(req, "provenance");
  if (isApiKeyError(auth)) return auth;

  const { stone_id } = await params;

  // Verify stone belongs to tenant and is at least published.
  const stones = await query<{ id: string; status: string; internal_ref: string }>(
    `SELECT id, status, internal_ref FROM stones
     WHERE id = $1 AND tenant_id = $2`,
    [stone_id, auth.tenantId]
  );

  if (!stones.length) {
    return NextResponse.json(
      { error: "Stone not found or does not belong to your account" },
      { status: 404 }
    );
  }

  const events = await getPassportChain(auth.tenantId, stone_id);
  const validation = validateChain(events);

  // Meter this call (best-effort).
  meterProvenanceRead(auth.tenantId, auth.keyId, stone_id).catch(() => {});

  return NextResponse.json({
    stone_id,
    internal_ref: stones[0].internal_ref,
    chain_validation: {
      valid: validation.valid,
      event_count: validation.event_count,
      head_hash: events.length
        ? events[events.length - 1].event_hash
        : null,
      detail: validation.detail,
      ...(validation.tampered_at_seq !== undefined
        ? {
            tampered_at_seq: validation.tampered_at_seq,
            tampered_event_id: validation.tampered_event_id,
          }
        : {}),
    },
    events: events.map((e) => ({
      seq: e.seq,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      location: e.location,
      payload: e.payload,
      event_hash: e.event_hash,
      prev_event_hash: e.prev_event_hash,
    })),
    disclaimer:
      "Chain integrity proves tamper-evidence of this digital record. " +
      "It does not constitute proof of real-world origin or compliance with any regulatory framework.",
  });
}

async function meterProvenanceRead(tenantId: string, keyId: string, stoneId: string) {
  try {
    const { stripe } = await import("@/lib/stripe");
    const tenantRows = await query<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const customerId = tenantRows[0]?.stripe_customer_id;
    if (customerId) {
      await stripe.v2.billing.meterEvents.create({
        event_name: STRIPE_METER_EVENT_NAME_API_PROVENANCE,
        payload: { stripe_customer_id: customerId, value: "1" },
        // Not idempotent here — each read is billed. Use timestamp to avoid collision.
        identifier: `provenance_read:${tenantId}:${stoneId}:${Date.now()}`,
      });
    }
  } catch {
    // Best-effort only.
  }

  await query(
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, NULL, 'api_provenance_read', 'stone', $2, $3)`,
    [
      tenantId,
      stoneId,
      JSON.stringify({ api_key_id: keyId }),
    ]
  );
}
