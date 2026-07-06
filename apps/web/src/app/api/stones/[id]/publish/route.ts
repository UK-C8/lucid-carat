// FR-1: transitions stone status priced → published.
// FR-6: stone must be priced and fully graded before publish.
// FR-8: appends stone_published provenance event to the Diamond Passport chain.
// Emits stone_published and passport_event_appended analytics events (CLAUDE.md §11).
import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";
import { appendPassportEvent } from "@/lib/passport";
import { reportStoneUsage } from "@/lib/billing";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.STONE_PUBLISH);
  if (denied) return denied;

  const { id: stoneId } = await params;

  const stones = await queryAsTenant<{
    status: string;
    confirmed_color: string | null;
    confirmed_clarity: string | null;
    confirmed_cut: string | null;
    confirmed_at: string | null;
    internal_ref: string;
  }>(
    session.tenantId,
    `SELECT status, confirmed_color, confirmed_clarity, confirmed_cut, confirmed_at, internal_ref
     FROM stones WHERE id = $1`,
    [stoneId]
  );

  if (!stones.length) {
    return NextResponse.json({ error: "Stone not found" }, { status: 404 });
  }

  const stone = stones[0];

  if (stone.status !== "priced") {
    return NextResponse.json(
      { error: `Stone must be in 'priced' status to publish (current: ${stone.status})` },
      { status: 409 }
    );
  }

  if (!stone.confirmed_color || !stone.confirmed_clarity || !stone.confirmed_at) {
    return NextResponse.json(
      { error: "All grades must be confirmed before publishing" },
      { status: 409 }
    );
  }

  await queryAsTenant(
    session.tenantId,
    "UPDATE stones SET status = 'published', updated_at = NOW() WHERE id = $1",
    [stoneId]
  );

  await queryAsTenant(
    session.tenantId,
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'stone_published', 'stone', $3, $4)`,
    [
      session.tenantId,
      session.userId,
      stoneId,
      JSON.stringify({ published_by: session.email }),
    ]
  );

  // FR-8: append grading-result Passport event on publish (per PRD primary flow).
  await appendPassportEvent({
    tenantId: session.tenantId,
    stoneId,
    eventType: "stone_published",
    payload: {
      confirmed_color: stone.confirmed_color,
      confirmed_clarity: stone.confirmed_clarity,
      confirmed_cut: stone.confirmed_cut,
      confirmed_at: stone.confirmed_at,
      published_by: session.email,
      internal_ref: stone.internal_ref,
    },
    actorId: session.userId,
  });

  // FR-12: meter per-stone usage in Stripe (fire-and-forget; skips gracefully if no subscription).
  reportStoneUsage(session.tenantId, stoneId).catch((err) =>
    console.error("[billing] reportStoneUsage failed:", err)
  );

  return NextResponse.json({ stone_id: stoneId, status: "published" });
}
