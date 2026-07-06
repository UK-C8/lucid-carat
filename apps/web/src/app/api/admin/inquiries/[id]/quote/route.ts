// FR-7: Sales sends a quote on an open inquiry.
import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";

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
  const body = await req.json();

  if (!body.quoted_price_usd) {
    return NextResponse.json({ error: "quoted_price_usd is required" }, { status: 400 });
  }

  const rows = await queryAsTenant<{ id: string; status: string }>(
    session.tenantId,
    "SELECT id, status FROM inquiries WHERE id = $1",
    [inquiryId]
  );
  if (!rows.length) {
    return NextResponse.json({ error: "Inquiry not found" }, { status: 404 });
  }
  if (!["open", "quoted"].includes(rows[0].status)) {
    return NextResponse.json(
      { error: `Cannot quote an inquiry with status '${rows[0].status}'` },
      { status: 409 }
    );
  }

  await queryAsTenant(
    session.tenantId,
    `UPDATE inquiries
     SET status           = 'quoted',
         quoted_price_usd = $2,
         quote_message    = $3,
         updated_at       = NOW()
     WHERE id = $1`,
    [inquiryId, body.quoted_price_usd, body.message ?? null]
  );

  await queryAsTenant(
    session.tenantId,
    `INSERT INTO inquiry_events (inquiry_id, tenant_id, actor_id, event_type, payload)
     VALUES ($1, $2, $3, 'quote_sent', $4)`,
    [
      inquiryId,
      session.tenantId,
      session.userId,
      JSON.stringify({
        quoted_price_usd: body.quoted_price_usd,
        message: body.message ?? null,
      }),
    ]
  );

  return NextResponse.json({ inquiry_id: inquiryId, status: "quoted" });
}
