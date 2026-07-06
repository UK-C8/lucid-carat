// FR-8, BR-4: Diamond Passport — chain view, validation, and manual event append.
//
// GET  — fetch full event chain + run validation (reports tampered events).
// POST — append a provenance event (admin/sales — manual origin, transfer, etc.).
import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { requirePermission, Permission } from "@/lib/rbac";
import { appendPassportEvent, getPassportChain, validateChain } from "@/lib/passport";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.STONE_VIEW);
  if (denied) return denied;

  const { id: stoneId } = await params;

  const events = await getPassportChain(session.tenantId, stoneId);
  const validation = validateChain(events);

  return NextResponse.json({ stone_id: stoneId, validation, events });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  // Requires CATALOG_MANAGE (sales/admin) to manually append passport events.
  const denied = requirePermission(session, Permission.CATALOG_MANAGE);
  if (denied) return denied;

  const { id: stoneId } = await params;
  const body = await req.json();

  if (!body.event_type) {
    return NextResponse.json({ error: "event_type is required" }, { status: 400 });
  }

  const event = await appendPassportEvent({
    tenantId: session.tenantId,
    stoneId,
    eventType: body.event_type,
    payload: body.payload ?? {},
    actorId: session.userId,
    location: body.location ?? null,
  });

  return NextResponse.json(
    { id: event.id, seq: event.seq, event_hash: event.event_hash },
    { status: 201 }
  );
}
