// FR-7: Sales/admin inquiry queue — lists all inquiries for this tenant.
import { NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";

export async function GET() {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.INQUIRY_MANAGE);
  if (denied) return denied;

  const inquiries = await queryAsTenant(
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
       u.email  AS buyer_email,
       u.full_name AS buyer_name,
       i.message,
       i.quoted_price_usd,
       i.quote_message,
       i.order_note,
       i.created_at,
       i.updated_at
     FROM inquiries i
     JOIN stones s ON s.id = i.stone_id
     JOIN users  u ON u.id = i.buyer_id
     ORDER BY i.updated_at DESC`
  );

  return NextResponse.json(inquiries);
}
