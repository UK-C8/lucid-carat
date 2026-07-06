// FR-12, BR-7: Standalone Grading API — poll job status and retrieve results.
//
// GET /api/v1/grading/jobs/{job_id}
// Auth: Bearer lc_<key>  (scope: grading)
//
// Returns status: queued | running | completed | failed
// When completed, includes the full grading result with per-dimension
// confidence scores and cert-disagreement flags.
//
// Metering: fired once when status first reads "completed" (idempotent via
// audit_log dedup on job_id). Usage is reported to Stripe as an api_grading_call.
import { NextRequest, NextResponse } from "next/server";
import { requireApiKey, isApiKeyError } from "@/lib/withApiKey";
import { query } from "@/lib/db";

const GRADING_URL = process.env.GRADING_SERVICE_URL ?? "http://localhost:8001";
const STRIPE_METER_EVENT_NAME_API_GRADING =
  process.env.STRIPE_METER_EVENT_NAME_API_GRADING ?? "api_grading_call";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ job_id: string }> }
) {
  const auth = await requireApiKey(req, "grading");
  if (isApiKeyError(auth)) return auth;

  const { job_id } = await params;

  const statusResp = await fetch(`${GRADING_URL}/grading/jobs/${job_id}`);
  if (!statusResp.ok) {
    return NextResponse.json(
      { error: "Job not found", job_id },
      { status: statusResp.status === 404 ? 404 : 502 }
    );
  }

  const status = await statusResp.json();

  // Verify the job belongs to this tenant.
  if (status.tenant_id && status.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (status.status !== "completed") {
    return NextResponse.json({
      job_id,
      status: status.status,
      stone_id: status.stone_id ?? null,
      created_at: status.created_at ?? null,
      updated_at: status.updated_at ?? null,
    });
  }

  // Fetch full result.
  const resultResp = await fetch(`${GRADING_URL}/grading/jobs/${job_id}/result`);
  if (!resultResp.ok) {
    return NextResponse.json(
      { job_id, status: "completed", error: "Result not yet available — retry in 2s" },
      { status: 202 }
    );
  }

  const result = await resultResp.json();

  // ── Idempotent usage metering ─────────────────────────────────────────────
  // Only meter once per job_id. Check audit_log for prior api_grading_metered event.
  meterGradingJobOnce(auth.tenantId, auth.keyId, job_id, result.stone_id).catch(() => {});

  return NextResponse.json({
    job_id,
    status: "completed",
    stone_id: result.stone_id ?? status.stone_id ?? null,
    completed_at: result.completed_at ?? status.updated_at ?? null,
    result: {
      color: {
        grade: result.color ?? null,
        confidence: result.color_confidence ?? null,
        cert_disagreement: result.color_cert_disagreement ?? false,
      },
      clarity: {
        grade: result.clarity ?? null,
        confidence: result.clarity_confidence ?? null,
        cert_disagreement: result.clarity_cert_disagreement ?? false,
        note: "Clarity grading is in beta — confidence thresholds are conservative.",
      },
      cut: {
        grade: result.cut ?? null,
        confidence: result.cut_confidence ?? null,
        cert_disagreement: result.cut_cert_disagreement ?? false,
      },
    },
    disclaimer:
      "LucidCarat grades are computer-vision decision aids — not official GIA/IGI certificates. " +
      "Always cross-check against the submitted lab certificate before commercial use.",
  });
}

async function meterGradingJobOnce(
  tenantId: string,
  keyId: string,
  jobId: string,
  stoneId: string | undefined
) {
  // Idempotency: skip if already metered for this job.
  const existing = await query<{ id: string }>(
    `SELECT id FROM audit_log
     WHERE tenant_id = $1 AND event_type = 'api_grading_metered'
       AND payload->>'job_id' = $2
     LIMIT 1`,
    [tenantId, jobId]
  );
  if (existing.length) return;

  // Attempt Stripe metering (best-effort).
  try {
    const { stripe } = await import("@/lib/stripe");
    const tenantRows = await query<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
      [tenantId]
    );
    const customerId = tenantRows[0]?.stripe_customer_id;
    if (customerId) {
      await stripe.v2.billing.meterEvents.create({
        event_name: STRIPE_METER_EVENT_NAME_API_GRADING,
        payload: { stripe_customer_id: customerId, value: "1" },
        identifier: `grading:${tenantId}:${jobId}`,
      });
    }
  } catch {
    // Stripe metering is best-effort; don't fail the API response.
  }

  // Write analytics event regardless of Stripe outcome.
  await query(
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, NULL, 'api_grading_metered', 'stone', $2, $3)`,
    [
      tenantId,
      stoneId ?? null,
      JSON.stringify({ job_id: jobId, api_key_id: keyId }),
    ]
  );
}
