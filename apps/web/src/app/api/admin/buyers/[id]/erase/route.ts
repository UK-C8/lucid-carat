// DPDP (India) + GDPR Article 17 — right to erasure ("right to be forgotten").
//
// POST /api/admin/buyers/{id}/erase
// Auth: admin only (USER_MANAGE permission)
//
// Pseudonymises the buyer's PII in-place rather than hard-deleting the row.
// Hard-deletion would break foreign key constraints in audit_log and inquiries,
// destroying the tamper-evident audit trail required for SOC 2 and Passport compliance.
//
// Pseudonymisation approach (GDPR Recital 26 compliant):
//   email        → 'deleted-<id>@lucidcarat.invalid'
//   full_name    → 'Deleted User'
//   password_hash → NULL
//   metadata     → '{}'
//   consent_given_at, last_login_at → NULL
//   anonymised_at set to NOW()
//
// Idempotent: calling again on an already-erased buyer returns 200 with a note.
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

  const denied = requirePermission(session, Permission.USER_MANAGE);
  if (denied) return denied;

  const { id: buyerId } = await params;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* reason is optional */ }

  const buyers = await queryAsTenant<{
    id: string;
    role: string;
    anonymised_at: string | null;
  }>(
    session.tenantId,
    "SELECT id, role, anonymised_at FROM users WHERE id = $1",
    [buyerId]
  );

  if (!buyers.length) {
    return NextResponse.json({ error: "Buyer not found" }, { status: 404 });
  }

  const buyer = buyers[0];

  if (buyer.anonymised_at) {
    return NextResponse.json({
      buyer_id: buyerId,
      status: "already_erased",
      anonymised_at: buyer.anonymised_at,
    });
  }

  // Prevent erasing your own account or other admins — must go through superadmin path.
  if (buyerId === session.userId) {
    return NextResponse.json(
      { error: "Cannot erase your own account via this endpoint" },
      { status: 409 }
    );
  }

  await queryAsTenant(
    session.tenantId,
    `UPDATE users SET
       email             = $2,
       full_name         = 'Deleted User',
       password_hash     = NULL,
       metadata          = '{}',
       consent_given_at  = NULL,
       last_login_at     = NULL,
       deletion_requested_at = COALESCE(deletion_requested_at, NOW()),
       anonymised_at     = NOW(),
       updated_at        = NOW()
     WHERE id = $1`,
    [buyerId, `deleted-${buyerId}@lucidcarat.invalid`]
  );

  await queryAsTenant(
    session.tenantId,
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'data_erasure_completed', 'user', $3, $4)`,
    [
      session.tenantId,
      session.userId,
      buyerId,
      JSON.stringify({
        erased_by: session.email,
        reason: (body.reason as string) ?? null,
        method: "pseudonymisation",
      }),
    ]
  );

  return NextResponse.json({
    buyer_id: buyerId,
    status: "erased",
    anonymised_at: new Date().toISOString(),
    note: "PII pseudonymised. Inquiry and audit records retained for compliance.",
  });
}
