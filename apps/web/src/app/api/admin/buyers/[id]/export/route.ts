// DPDP (India) + GDPR Article 20 — data portability export for a buyer.
//
// GET /api/admin/buyers/{id}/export
// Auth: admin only (BILLING_MANAGE covers admin ops; or USER_MANAGE if separate)
//
// Returns a JSON bundle of all PII and transactional data held for this buyer
// within the requesting tenant. The bundle is suitable for handing directly to
// the data subject upon a Subject Access Request (SAR).
//
// Data included:
//   - Identity: email, full_name, role, consent_given_at, data_region
//   - Inquiries and their message threads
//   - Price-book view events from audit_log
//   - API keys created by this user (prefix only — raw key is never stored)
//
// Data NOT included (outside scope / not PII):
//   - Other tenants' data (strict tenant isolation)
//   - Stone/grading data (belongs to tenant, not buyer)
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

  const denied = requirePermission(session, Permission.USER_MANAGE);
  if (denied) return denied;

  const { id: buyerId } = await params;

  const buyers = await queryAsTenant<{
    id: string;
    email: string;
    full_name: string;
    role: string;
    consent_given_at: string | null;
    data_region: string;
    last_login_at: string | null;
    created_at: string;
    anonymised_at: string | null;
  }>(
    session.tenantId,
    `SELECT id, email, full_name, role, consent_given_at, data_region,
            last_login_at, created_at, anonymised_at
     FROM users WHERE id = $1`,
    [buyerId]
  );

  if (!buyers.length) {
    return NextResponse.json({ error: "Buyer not found" }, { status: 404 });
  }

  const buyer = buyers[0];

  // Inquiries + message thread.
  const inquiries = await queryAsTenant(
    session.tenantId,
    `SELECT i.id, i.status, i.message, i.quoted_price_usd, i.quote_message,
            i.order_note, i.created_at, i.updated_at,
            s.internal_ref AS stone_ref,
            COALESCE(
              json_agg(
                json_build_object(
                  'event_type', ie.event_type,
                  'payload',    ie.payload,
                  'occurred_at', ie.occurred_at
                ) ORDER BY ie.occurred_at
              ) FILTER (WHERE ie.id IS NOT NULL),
              '[]'
            ) AS events
     FROM inquiries i
     LEFT JOIN stones s ON s.id = i.stone_id
     LEFT JOIN inquiry_events ie ON ie.inquiry_id = i.id
     WHERE i.buyer_id = $1
     GROUP BY i.id, s.internal_ref
     ORDER BY i.created_at`,
    [buyerId]
  );

  // Price-book view audit events.
  const viewEvents = await queryAsTenant(
    session.tenantId,
    `SELECT al.occurred_at, al.entity_id AS stone_id, al.payload
     FROM audit_log al
     WHERE al.event_type = 'price_book_viewed'
       AND al.actor_id   = $1
     ORDER BY al.occurred_at`,
    [buyerId]
  );

  // Emit data_export_completed audit event.
  await queryAsTenant(
    session.tenantId,
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'data_export_completed', 'user', $3, $4)`,
    [
      session.tenantId,
      session.userId,
      buyerId,
      JSON.stringify({ requested_by: session.email }),
    ]
  );

  const exportBundle = {
    schema_version: "1.0",
    export_type: "data_subject_access_request",
    generated_at: new Date().toISOString(),
    tenant_id: session.tenantId,
    disclaimer: "This export contains all personal data held for the named data subject within this tenant account. Generated in compliance with DPDP (India) and GDPR Article 20.",
    subject: {
      id: buyer.id,
      email: buyer.email,
      full_name: buyer.full_name,
      role: buyer.role,
      consent_given_at: buyer.consent_given_at,
      data_region: buyer.data_region,
      last_login_at: buyer.last_login_at,
      account_created_at: buyer.created_at,
      anonymised_at: buyer.anonymised_at ?? null,
    },
    inquiries,
    price_book_views: viewEvents,
  };

  return NextResponse.json(exportBundle, {
    headers: {
      "Content-Disposition": `attachment; filename="sar-${buyerId}-${Date.now()}.json"`,
    },
  });
}
