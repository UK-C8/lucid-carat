// FR-12, BR-7: API key management — revoke a key.
// DELETE /api/api-keys/{id}
// Session-authenticated; requires BILLING_MANAGE (admin only).
// Revocation is soft (revoked_at timestamp); key immediately stops working
// because withApiKey.ts checks revoked_at before accepting requests.
import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { requirePermission, Permission } from "@/lib/rbac";
import { query } from "@/lib/db";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.BILLING_MANAGE);
  if (denied) return denied;

  const { id } = await params;

  const rows = await query<{ id: string; name: string }>(
    `UPDATE api_keys SET revoked_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
     RETURNING id, name`,
    [id, session.tenantId]
  );

  if (!rows.length) {
    return NextResponse.json(
      { error: "API key not found or already revoked" },
      { status: 404 }
    );
  }

  await query(
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'api_key_revoked', 'api_key', $3, $4)`,
    [session.tenantId, session.userId, id, JSON.stringify({ name: rows[0].name })]
  );

  return NextResponse.json({ revoked: true, id, name: rows[0].name });
}
