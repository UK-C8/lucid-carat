// FR-6, BR-3: Buyer-facing catalog.
// Returns only stones the authenticated buyer has been assigned a price book entry for.
// Price isolation: each buyer sees only their own effective_price_usd.
//   - No cross-buyer pricing is ever returned in the same response.
//   - Hard-blocked entries (>60 days stale) return is_hard_blocked=true; price is withheld.
//   - Stale entries (>30 days) return is_stale=true with the price still shown + warning.
// Does NOT emit price_book_viewed — that fires on the individual stone detail endpoint
// to log intentional price inspections, not list-page renders.
import { NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";

export async function GET() {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.CATALOG_VIEW);
  if (denied) return denied;

  // RLS (via queryAsTenant) scopes to tenant; the WHERE clause scopes to buyer.
  // A buyer can NEVER see another buyer's entries — the buyer_id = session.userId
  // filter is in addition to RLS, providing defense-in-depth.
  const stones = await queryAsTenant(
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
       END AS effective_price_usd
     FROM buyer_catalog bc
     WHERE bc.buyer_id = $1
       AND bc.status = 'published'
     ORDER BY bc.stone_id`,
    [session.userId]
  );

  return NextResponse.json(stones);
}
