// FR-7: Close or decline an inquiry.
// When resolution = 'closed' (won deal), emits stone_sold analytics event (CLAUDE.md §11)
// and transitions the stone to status 'sold'.
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
  try { body = await req.json(); } catch { /* optional */ }

  const resolution = body.resolution === "declined" ? "declined" : "closed";

  const rows = await queryAsTenant<{
    id: string;
    status: string;
    stone_id: string;
    buyer_id: string;
    quoted_price_usd: number | null;
  }>(
    session.tenantId,
    "SELECT id, status, stone_id, buyer_id, quoted_price_usd FROM inquiries WHERE id = $1",
    [inquiryId]
  );
  if (!rows.length) {
    return NextResponse.json({ error: "Inquiry not found" }, { status: 404 });
  }
  if (["closed", "declined"].includes(rows[0].status)) {
    return NextResponse.json(
      { error: `Inquiry is already ${rows[0].status}` },
      { status: 409 }
    );
  }

  const inq = rows[0];

  await queryAsTenant(
    session.tenantId,
    "UPDATE inquiries SET status = $2, updated_at = NOW() WHERE id = $1",
    [inquiryId, resolution]
  );

  await queryAsTenant(
    session.tenantId,
    `INSERT INTO inquiry_events (inquiry_id, tenant_id, actor_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      inquiryId,
      session.tenantId,
      session.userId,
      resolution as "closed" | "declined",
      JSON.stringify({ note: body.note ?? null }),
    ]
  );

  if (resolution === "closed") {
    // Mark stone as sold.
    await queryAsTenant(
      session.tenantId,
      "UPDATE stones SET status = 'sold', updated_at = NOW() WHERE id = $1",
      [inq.stone_id]
    );

    // stone_sold analytics event (CLAUDE.md §11).
    await queryAsTenant(
      session.tenantId,
      `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
       VALUES ($1, $2, 'stone_sold', 'stone', $3, $4)`,
      [
        session.tenantId,
        session.userId,
        inq.stone_id,
        JSON.stringify({
          inquiry_id: inquiryId,
          buyer_id: inq.buyer_id,
          sale_price_usd: inq.quoted_price_usd,
          closed_by: session.email,
        }),
      ]
    );

    // Append sold event to Diamond Passport chain.
    appendPassportEvent({
      tenantId: session.tenantId,
      stoneId: inq.stone_id,
      eventType: "sold",
      payload: {
        inquiry_id: inquiryId,
        buyer_id: inq.buyer_id,
        sale_price_usd: inq.quoted_price_usd,
        closed_by: session.email,
      },
      actorId: session.userId,
    }).catch((err) => console.error("[passport] sold event failed:", err));
  }

  return NextResponse.json({ inquiry_id: inquiryId, status: resolution });
}
