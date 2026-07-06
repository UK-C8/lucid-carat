// FR-7: Buyer views their own inquiries with current status.
import { NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";

export async function GET() {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.INQUIRY_SUBMIT);
  if (denied) return denied;

  const inquiries = await queryAsTenant(
    session.tenantId,
    `SELECT
       i.id,
       i.stone_id,
       s.internal_ref,
       s.confirmed_color,
       s.confirmed_clarity,
       s.confirmed_cut,
       i.status,
       i.message,
       i.quoted_price_usd,
       i.quote_message,
       i.order_note,
       i.created_at,
       i.updated_at
     FROM inquiries i
     JOIN stones s ON s.id = i.stone_id
     WHERE i.buyer_id = $1
     ORDER BY i.updated_at DESC`,
    [session.userId]
  );

  return NextResponse.json(inquiries);
}
