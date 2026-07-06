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

  const denied = requirePermission(session, Permission.PRICE_MARK_PRICED);
  if (denied) return denied;

  const { id: stoneId } = await params;
  const body = await req.json();
  const listPriceUsd: number | null = body.list_price_usd ?? null;

  const stones = await queryAsTenant<{ status: string }>(
    session.tenantId,
    "SELECT status FROM stones WHERE id = $1",
    [stoneId]
  );
  if (!stones.length) return NextResponse.json({ error: "Stone not found" }, { status: 404 });
  if (stones[0].status !== "priced") {
    return NextResponse.json(
      { error: `Stone is not in priced status (current: ${stones[0].status})` },
      { status: 409 }
    );
  }

  if (listPriceUsd !== null) {
    await queryAsTenant(
      session.tenantId,
      "UPDATE stones SET list_price_usd = $1, updated_at = NOW() WHERE id = $2",
      [listPriceUsd, stoneId]
    );
  }

  await queryAsTenant(
    session.tenantId,
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'per_stone_usage_metered', 'stone', $3, $4)`,
    [
      session.tenantId,
      session.userId,
      stoneId,
      JSON.stringify({ event: "stone_priced", list_price_usd: listPriceUsd }),
    ]
  );

  return NextResponse.json({ stone_id: stoneId, status: "priced", list_price_usd: listPriceUsd });
}
