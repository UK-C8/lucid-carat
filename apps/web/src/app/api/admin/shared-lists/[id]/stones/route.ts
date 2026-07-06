// FR-7: Add/list stones in a shared list.
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

  const denied = requirePermission(session, Permission.LIST_MANAGE);
  if (denied) return denied;

  const { id: listId } = await params;

  const stones = await queryAsTenant(
    session.tenantId,
    `SELECT
       sls.stone_id,
       s.internal_ref,
       s.status,
       s.confirmed_color,
       s.confirmed_clarity,
       s.confirmed_cut,
       s.carat_weight,
       sls.added_at,
       u.email AS added_by_email
     FROM shared_list_stones sls
     JOIN stones s ON s.id = sls.stone_id
     LEFT JOIN users u ON u.id = sls.added_by
     WHERE sls.shared_list_id = $1
     ORDER BY sls.added_at DESC`,
    [listId]
  );

  return NextResponse.json(stones);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.LIST_MANAGE);
  if (denied) return denied;

  const { id: listId } = await params;
  const body = await req.json();

  if (!body.stone_id) {
    return NextResponse.json({ error: "stone_id is required" }, { status: 400 });
  }

  // Verify list belongs to tenant.
  const lists = await queryAsTenant(
    session.tenantId,
    "SELECT id FROM shared_lists WHERE id = $1",
    [listId]
  );
  if (!lists.length) {
    return NextResponse.json({ error: "List not found" }, { status: 404 });
  }

  await queryAsTenant(
    session.tenantId,
    `INSERT INTO shared_list_stones (shared_list_id, stone_id, tenant_id, added_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [listId, body.stone_id, session.tenantId, session.userId]
  );

  return NextResponse.json({ list_id: listId, stone_id: body.stone_id }, { status: 201 });
}
