// FR-6, BR-3: price book entry management.
// POST — assign a published stone to a buyer or buyer group with optional custom price.
// GET  — list all price book entries for the tenant (admin/sales view).
// Emits price_book_assigned analytics event (CLAUDE.md §11).
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

  const entries = await queryAsTenant(
    session.tenantId,
    `SELECT
       pbe.id,
       pbe.stone_id,
       s.internal_ref,
       s.status AS stone_status,
       pbe.buyer_id,
       ub.email  AS buyer_email,
       pbe.buyer_group_id,
       bg.name   AS buyer_group_name,
       pbe.custom_price_usd,
       pbe.last_refreshed_at,
       (now() - pbe.last_refreshed_at) > INTERVAL '30 days' AS is_stale,
       (now() - pbe.last_refreshed_at) > INTERVAL '60 days' AS is_hard_blocked,
       pbe.created_at
     FROM price_book_entries pbe
     JOIN stones s ON s.id = pbe.stone_id
     LEFT JOIN users ub ON ub.id = pbe.buyer_id
     LEFT JOIN buyer_groups bg ON bg.id = pbe.buyer_group_id
     ORDER BY pbe.created_at DESC`
  );

  return NextResponse.json(entries);
}

export async function POST(req: NextRequest) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.CATALOG_MANAGE);
  if (denied) return denied;

  const body = await req.json();
  const { stone_id, buyer_id, buyer_group_id, custom_price_usd } = body;

  if (!stone_id) {
    return NextResponse.json({ error: "stone_id is required" }, { status: 400 });
  }
  if (!buyer_id && !buyer_group_id) {
    return NextResponse.json(
      { error: "Exactly one of buyer_id or buyer_group_id is required" },
      { status: 400 }
    );
  }
  if (buyer_id && buyer_group_id) {
    return NextResponse.json(
      { error: "Provide buyer_id OR buyer_group_id, not both" },
      { status: 400 }
    );
  }

  // Stone must be published
  const stones = await queryAsTenant<{ status: string }>(
    session.tenantId,
    "SELECT status FROM stones WHERE id = $1",
    [stone_id]
  );
  if (!stones.length) {
    return NextResponse.json({ error: "Stone not found" }, { status: 404 });
  }
  if (stones[0].status !== "published") {
    return NextResponse.json(
      { error: `Stone must be published to assign a price book (current: ${stones[0].status})` },
      { status: 409 }
    );
  }

  // Validate buyer belongs to this tenant
  if (buyer_id) {
    const buyers = await queryAsTenant<{ role: string }>(
      session.tenantId,
      "SELECT role FROM users WHERE id = $1",
      [buyer_id]
    );
    if (!buyers.length) {
      return NextResponse.json({ error: "Buyer not found in this tenant" }, { status: 404 });
    }
    if (buyers[0].role !== "buyer") {
      return NextResponse.json({ error: "Target user is not a buyer" }, { status: 400 });
    }
  }

  if (buyer_group_id) {
    const groups = await queryAsTenant(
      session.tenantId,
      "SELECT id FROM buyer_groups WHERE id = $1",
      [buyer_group_id]
    );
    if (!groups.length) {
      return NextResponse.json({ error: "Buyer group not found" }, { status: 404 });
    }
  }

  const rows = await queryAsTenant<{ id: string }>(
    session.tenantId,
    `INSERT INTO price_book_entries
       (tenant_id, stone_id, buyer_id, buyer_group_id, custom_price_usd, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      session.tenantId,
      stone_id,
      buyer_id ?? null,
      buyer_group_id ?? null,
      custom_price_usd ?? null,
      session.userId,
    ]
  );

  if (!rows.length) {
    return NextResponse.json(
      { error: "Price book entry already exists for this stone + target" },
      { status: 409 }
    );
  }

  const entryId = rows[0].id;

  await queryAsTenant(
    session.tenantId,
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'price_book_assigned', 'price_book_entry', $3, $4)`,
    [
      session.tenantId,
      session.userId,
      entryId,
      JSON.stringify({
        stone_id,
        buyer_id: buyer_id ?? null,
        buyer_group_id: buyer_group_id ?? null,
        custom_price_usd: custom_price_usd ?? null,
      }),
    ]
  );

  return NextResponse.json({ entry_id: entryId }, { status: 201 });
}
