// FR-7: Full inquiry detail with complete event timeline.
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

  const { id: inquiryId } = await params;

  const rows = await queryAsTenant(
    session.tenantId,
    `SELECT
       i.id,
       i.status,
       i.stone_id,
       s.internal_ref,
       s.confirmed_color,
       s.confirmed_clarity,
       s.confirmed_cut,
       i.buyer_id,
       u.email      AS buyer_email,
       u.full_name  AS buyer_name,
       i.message,
       i.quoted_price_usd,
       i.quote_message,
       i.order_note,
       i.created_at,
       i.updated_at
     FROM inquiries i
     JOIN stones s ON s.id = i.stone_id
     JOIN users  u ON u.id = i.buyer_id
     WHERE i.id = $1`,
    [inquiryId]
  );

  if (!rows.length) {
    return NextResponse.json({ error: "Inquiry not found" }, { status: 404 });
  }

  const events = await queryAsTenant(
    session.tenantId,
    `SELECT
       ie.id,
       ie.event_type,
       ie.payload,
       ie.occurred_at,
       u.email     AS actor_email,
       u.full_name AS actor_name,
       u.role      AS actor_role
     FROM inquiry_events ie
     LEFT JOIN users u ON u.id = ie.actor_id
     WHERE ie.inquiry_id = $1
     ORDER BY ie.occurred_at ASC`,
    [inquiryId]
  );

  return NextResponse.json({ ...rows[0] as object, events });
}
