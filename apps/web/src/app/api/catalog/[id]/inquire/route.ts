// FR-7: Buyer submits an inquiry on a published stone they have catalog access to.
// Emits buyer_inquiry_submitted analytics event (CLAUDE.md §11).
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

  const denied = requirePermission(session, Permission.INQUIRY_SUBMIT);
  if (denied) return denied;

  const { id: stoneId } = await params;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* message is optional */ }

  // Verify this buyer has a price-book entry for this stone (catalog access).
  const access = await queryAsTenant(
    session.tenantId,
    `SELECT entry_id FROM buyer_catalog
     WHERE stone_id = $1 AND buyer_id = $2 AND status = 'published'`,
    [stoneId, session.userId]
  );
  if (!access.length) {
    return NextResponse.json({ error: "Stone not found" }, { status: 404 });
  }

  // Upsert inquiry — re-open if previously closed/declined.
  const rows = await queryAsTenant<{ id: string; status: string }>(
    session.tenantId,
    `INSERT INTO inquiries (tenant_id, buyer_id, stone_id, message)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, buyer_id, stone_id)
     DO UPDATE SET
       status    = CASE WHEN inquiries.status IN ('closed','declined') THEN 'open' ELSE inquiries.status END,
       message   = EXCLUDED.message,
       updated_at = NOW()
     RETURNING id, status`,
    [session.tenantId, session.userId, stoneId, (body.message as string) ?? null]
  );

  const inquiry = rows[0];

  // Append timeline event.
  await queryAsTenant(
    session.tenantId,
    `INSERT INTO inquiry_events (inquiry_id, tenant_id, actor_id, event_type, payload)
     VALUES ($1, $2, $3, 'inquiry_submitted', $4)`,
    [
      inquiry.id,
      session.tenantId,
      session.userId,
      JSON.stringify({ message: body.message ?? null }),
    ]
  );

  // Analytics event (CLAUDE.md §11).
  await queryAsTenant(
    session.tenantId,
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'buyer_inquiry_submitted', 'inquiry', $3, $4)`,
    [
      session.tenantId,
      session.userId,
      inquiry.id,
      JSON.stringify({ stone_id: stoneId, buyer_id: session.userId }),
    ]
  );

  return NextResponse.json({ inquiry_id: inquiry.id, status: inquiry.status }, { status: 201 });
}
