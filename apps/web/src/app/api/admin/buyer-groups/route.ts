// Buyer group management — create groups and add members.
// GET  — list groups for tenant
// POST — create a group
import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";

export async function GET() {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.CATALOG_MANAGE);
  if (denied) return denied;

  const groups = await queryAsTenant(
    session.tenantId,
    `SELECT bg.id, bg.name, bg.created_at,
            COUNT(bgm.user_id)::int AS member_count
     FROM buyer_groups bg
     LEFT JOIN buyer_group_members bgm ON bgm.buyer_group_id = bg.id
     GROUP BY bg.id
     ORDER BY bg.created_at DESC`
  );

  return NextResponse.json(groups);
}

export async function POST(req: NextRequest) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.CATALOG_MANAGE);
  if (denied) return denied;

  const body = await req.json();
  if (!body.name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const rows = await queryAsTenant<{ id: string }>(
    session.tenantId,
    `INSERT INTO buyer_groups (tenant_id, name, created_by)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [session.tenantId, body.name, session.userId]
  );

  return NextResponse.json({ group_id: rows[0].id }, { status: 201 });
}
