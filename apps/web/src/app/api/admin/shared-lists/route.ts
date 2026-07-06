// FR-7: Shared lists — named collections of stones for a buyer or segment.
import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";

export async function GET() {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.LIST_MANAGE);
  if (denied) return denied;

  const lists = await queryAsTenant(
    session.tenantId,
    `SELECT
       sl.id,
       sl.name,
       sl.buyer_id,
       ub.email         AS buyer_email,
       sl.buyer_group_id,
       bg.name          AS buyer_group_name,
       sl.created_at,
       COUNT(sls.stone_id)::int AS stone_count
     FROM shared_lists sl
     LEFT JOIN users        ub  ON ub.id  = sl.buyer_id
     LEFT JOIN buyer_groups bg  ON bg.id  = sl.buyer_group_id
     LEFT JOIN shared_list_stones sls ON sls.shared_list_id = sl.id
     GROUP BY sl.id, ub.email, bg.name
     ORDER BY sl.created_at DESC`
  );

  return NextResponse.json(lists);
}

export async function POST(req: NextRequest) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.LIST_MANAGE);
  if (denied) return denied;

  const body = await req.json();
  if (!body.name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const rows = await queryAsTenant<{ id: string }>(
    session.tenantId,
    `INSERT INTO shared_lists (tenant_id, name, buyer_id, buyer_group_id, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      session.tenantId,
      body.name,
      body.buyer_id ?? null,
      body.buyer_group_id ?? null,
      session.userId,
    ]
  );

  return NextResponse.json({ list_id: rows[0].id }, { status: 201 });
}
