// FR-12, BR-7: Standalone Provenance API — append a provenance event.
//
// POST /api/v1/provenance/{stone_id}/events
// Auth: Bearer lc_<key>  (scope: provenance)
//
// Appends a tamper-evident event to the stone's Diamond Passport chain.
// Common use-cases for certification labs: recording origin certification,
// transfer-of-custody events, and re-grading results.
import { NextRequest, NextResponse } from "next/server";
import { requireApiKey, isApiKeyError } from "@/lib/withApiKey";
import { query } from "@/lib/db";
import { appendPassportEvent } from "@/lib/passport";

// Allowed event types for the external API. Internal-only types (stone_published,
// grading_completed) are reserved and cannot be written via API keys.
const ALLOWED_EVENT_TYPES = new Set([
  "origin_certified",
  "transfer_of_custody",
  "re_graded",
  "export_cleared",
  "import_cleared",
  "lab_verified",
  "retailer_received",
  "sold",
  "note",
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ stone_id: string }> }
) {
  const auth = await requireApiKey(req, "provenance");
  if (isApiKeyError(auth)) return auth;

  const { stone_id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const { event_type, payload = {}, location } = body as {
    event_type?: string;
    payload?: Record<string, unknown>;
    location?: string;
  };

  if (!event_type) {
    return NextResponse.json({ error: "event_type is required" }, { status: 400 });
  }
  if (!ALLOWED_EVENT_TYPES.has(event_type)) {
    return NextResponse.json(
      {
        error: `event_type '${event_type}' is not allowed via the API`,
        allowed_event_types: Array.from(ALLOWED_EVENT_TYPES),
      },
      { status: 400 }
    );
  }

  // Verify stone belongs to tenant.
  const stones = await query<{ id: string }>(
    `SELECT id FROM stones WHERE id = $1 AND tenant_id = $2`,
    [stone_id, auth.tenantId]
  );
  if (!stones.length) {
    return NextResponse.json(
      { error: "Stone not found or does not belong to your account" },
      { status: 404 }
    );
  }

  const event = await appendPassportEvent({
    tenantId: auth.tenantId,
    stoneId: stone_id,
    eventType: event_type,
    payload: { ...payload, _source: "api_v1", _api_key_id: auth.keyId },
    actorId: null,
    location: location ?? null,
  });

  return NextResponse.json(
    {
      id: event.id,
      seq: event.seq,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      event_hash: event.event_hash,
      prev_event_hash: event.prev_event_hash,
    },
    { status: 201 }
  );
}
