// FR-10, BR-5: Emit viewer_3d_opened analytics event (CLAUDE.md §11).
// Called by DiamondViewer once the R3F canvas has rendered its first frame.
// Only buyers with CATALOG_VIEW access to the stone can fire this event.
import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.CATALOG_VIEW);
  if (denied) return denied;

  const { id: stoneId } = await params;

  // Verify the buyer has access to this stone (price-book scoping still enforced).
  const rows = await queryAsTenant(
    session.tenantId,
    `SELECT stone_id FROM buyer_catalog
     WHERE stone_id = $1 AND buyer_id = $2 AND status = 'published'`,
    [stoneId, session.userId]
  );
  if (!rows.length) {
    return NextResponse.json({ error: "Stone not found" }, { status: 404 });
  }

  // Fire-and-forget audit log write — viewer_3d_opened (CLAUDE.md §11).
  await queryAsTenant(
    session.tenantId,
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'viewer_3d_opened', 'stone', $3, $4)`,
    [
      session.tenantId,
      session.userId,
      stoneId,
      JSON.stringify({ buyer_id: session.userId }),
    ]
  );

  return NextResponse.json({ ok: true });
}
