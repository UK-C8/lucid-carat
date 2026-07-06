// Refresh a stale price book entry — resets last_refreshed_at to now.
// Also allows updating the custom_price_usd at the same time.
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

  const denied = requirePermission(session, Permission.CATALOG_MANAGE);
  if (denied) return denied;

  const { id: entryId } = await params;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* optional body */ }

  const entries = await queryAsTenant<{ id: string }>(
    session.tenantId,
    "SELECT id FROM price_book_entries WHERE id = $1",
    [entryId]
  );
  if (!entries.length) {
    return NextResponse.json({ error: "Price book entry not found" }, { status: 404 });
  }

  const customPrice = body.custom_price_usd != null ? Number(body.custom_price_usd) : undefined;

  await queryAsTenant(
    session.tenantId,
    `UPDATE price_book_entries
     SET last_refreshed_at = NOW(),
         custom_price_usd  = COALESCE($2, custom_price_usd),
         updated_at        = NOW()
     WHERE id = $1`,
    [entryId, customPrice ?? null]
  );

  return NextResponse.json({ entry_id: entryId, refreshed_at: new Date().toISOString() });
}
