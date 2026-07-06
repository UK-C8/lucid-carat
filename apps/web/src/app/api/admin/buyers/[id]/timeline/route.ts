// FR-7: Unified activity/negotiation timeline for a buyer.
// Shows every inquiry, every quote/order/close event, and price-book views
// in chronological order — single pane of glass for sales staff.
import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.INQUIRY_MANAGE);
  if (denied) return denied;

  const { id: buyerId } = await params;

  // Verify buyer belongs to this tenant.
  const buyers = await queryAsTenant<{ email: string; full_name: string; role: string }>(
    session.tenantId,
    "SELECT email, full_name, role FROM users WHERE id = $1",
    [buyerId]
  );
  if (!buyers.length) {
    return NextResponse.json({ error: "Buyer not found" }, { status: 404 });
  }

  // Inquiry events — covers the full negotiation thread.
  const inquiryEvents = await queryAsTenant(
    session.tenantId,
    `SELECT
       'inquiry_event'           AS source,
       ie.occurred_at            AS ts,
       ie.event_type,
       ie.payload,
       i.id                      AS inquiry_id,
       i.status                  AS inquiry_status,
       i.stone_id,
       s.internal_ref,
       actor.email               AS actor_email,
       actor.role                AS actor_role
     FROM inquiry_events ie
     JOIN inquiries i   ON i.id      = ie.inquiry_id
     JOIN stones    s   ON s.id      = i.stone_id
     LEFT JOIN users actor ON actor.id = ie.actor_id
     WHERE i.buyer_id = $1`,
    [buyerId]
  );

  // Price-book view events from audit_log.
  const viewEvents = await queryAsTenant(
    session.tenantId,
    `SELECT
       'price_view'              AS source,
       al.occurred_at            AS ts,
       'price_book_viewed'       AS event_type,
       al.payload,
       NULL::uuid                AS inquiry_id,
       NULL::text                AS inquiry_status,
       al.entity_id              AS stone_id,
       s.internal_ref,
       NULL::text                AS actor_email,
       NULL::text                AS actor_role
     FROM audit_log al
     LEFT JOIN stones s ON s.id = al.entity_id
     WHERE al.event_type = 'price_book_viewed'
       AND al.actor_id   = $1`,
    [buyerId]
  );

  // Merge and sort chronologically.
  const timeline = [...inquiryEvents, ...viewEvents].sort(
    (a, b) => new Date((a as Record<string, unknown>).ts as string).getTime()
            - new Date((b as Record<string, unknown>).ts as string).getTime()
  );

  return NextResponse.json({
    buyer: { id: buyerId, ...buyers[0] },
    event_count: timeline.length,
    timeline,
  });
}
