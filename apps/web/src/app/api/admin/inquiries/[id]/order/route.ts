// FR-7: Mark inquiry as a soft order/reservation (no payment capture — out of scope).
// FR-8: Appends order_reserved provenance event to the Diamond Passport chain.
// Emits order_reserved and passport_event_appended analytics events (CLAUDE.md §11).
import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";
import { appendPassportEvent } from "@/lib/passport";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.INQUIRY_MANAGE);
  if (denied) return denied;

  const { id: inquiryId } = await params;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* note is optional */ }

  const rows = await queryAsTenant<{
    id: string;
    status: string;
    stone_id: string;
    buyer_id: string;
  }>(
    session.tenantId,
    "SELECT id, status, stone_id, buyer_id FROM inquiries WHERE id = $1",
    [inquiryId]
  );
  if (!rows.length) {
    return NextResponse.json({ error: "Inquiry not found" }, { status: 404 });
  }

  const inq = rows[0];
  if (!["open", "quoted"].includes(inq.status)) {
    return NextResponse.json(
      { error: `Cannot reserve an inquiry with status '${inq.status}'` },
      { status: 409 }
    );
  }

  await queryAsTenant(
    session.tenantId,
    `UPDATE inquiries
     SET status     = 'ordered',
         order_note = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [inquiryId, (body.note as string) ?? null]
  );

  await queryAsTenant(
    session.tenantId,
    `INSERT INTO inquiry_events (inquiry_id, tenant_id, actor_id, event_type, payload)
     VALUES ($1, $2, $3, 'order_reserved', $4)`,
    [
      inquiryId,
      session.tenantId,
      session.userId,
      JSON.stringify({ note: body.note ?? null, stone_id: inq.stone_id, buyer_id: inq.buyer_id }),
    ]
  );

  // Analytics event (CLAUDE.md §11).
  await queryAsTenant(
    session.tenantId,
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'order_reserved', 'inquiry', $3, $4)`,
    [
      session.tenantId,
      session.userId,
      inquiryId,
      JSON.stringify({ stone_id: inq.stone_id, buyer_id: inq.buyer_id }),
    ]
  );

  // FR-8: append ownership/reservation event to Diamond Passport chain.
  await appendPassportEvent({
    tenantId: session.tenantId,
    stoneId: inq.stone_id,
    eventType: "order_reserved",
    payload: {
      inquiry_id: inquiryId,
      buyer_id: inq.buyer_id,
      note: (body.note as string) ?? null,
    },
    actorId: session.userId,
  });

  return NextResponse.json({ inquiry_id: inquiryId, status: "ordered" });
}
