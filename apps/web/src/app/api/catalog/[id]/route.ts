// FR-6, BR-3: Single stone detail for a buyer.
// Emits price_book_viewed audit event (CLAUDE.md §11, BR-3 access logging requirement).
// Hard-blocked entries: returns stone specs but withholds price (null effective_price_usd).
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

  const denied = requirePermission(session, Permission.CATALOG_VIEW);
  if (denied) return denied;

  const { id: stoneId } = await params;

  // Query through buyer_catalog view — automatically scopes to published + assigned + this tenant.
  // WHERE buyer_id = session.userId ensures this buyer cannot read another buyer's entry.
  const rows = await queryAsTenant(
    session.tenantId,
    `SELECT
       bc.entry_id,
       bc.stone_id,
       bc.internal_ref,
       bc.shape,
       bc.carat_weight,
       bc.confirmed_color,
       bc.confirmed_clarity,
       bc.confirmed_cut,
       bc.is_stale,
       bc.is_hard_blocked,
       bc.last_refreshed_at,
       CASE WHEN bc.is_hard_blocked THEN NULL
            ELSE bc.effective_price_usd
       END AS effective_price_usd,
       -- Stone cert details for buyer display
       c.cert_number,
       c.lab,
       c.fluorescence,
       c.measurements_mm,
       c.polish,
       c.symmetry
     FROM buyer_catalog bc
     JOIN certificates c ON c.stone_id = bc.stone_id
     WHERE bc.stone_id = $1
       AND bc.buyer_id  = $2
       AND bc.status    = 'published'`,
    [stoneId, session.userId]
  );

  if (!rows.length) {
    // Return 404 — not 403 — to avoid leaking that the stone exists at all for other buyers.
    return NextResponse.json({ error: "Stone not found" }, { status: 404 });
  }

  const stone = rows[0] as Record<string, unknown>;

  // Emit price_book_viewed (BR-3, CLAUDE.md §11).
  // Fire-and-forget; do not block the response on audit write.
  queryAsTenant(
    session.tenantId,
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'price_book_viewed', 'stone', $3, $4)`,
    [
      session.tenantId,
      session.userId,
      stoneId,
      JSON.stringify({
        entry_id: stone.entry_id,
        buyer_id: session.userId,
        is_stale: stone.is_stale,
        is_hard_blocked: stone.is_hard_blocked,
        price_shown: stone.effective_price_usd != null,
      }),
    ]
  ).catch(() => { /* audit write failure must not break buyer experience */ });

  return NextResponse.json(stone);
}
