// FR-12, BR-7: Standalone Grading API — submit a grading job.
//
// POST /api/v1/grading/jobs
// Auth: Bearer lc_<key>  (scope: grading)
// Rate: per-key, configurable (default 60 req/min)
//
// The stone must already exist in the tenant's account (created via the web app
// or a prior API call). Grading is async; poll GET /api/v1/grading/jobs/{job_id}
// for status and results.
import { NextRequest, NextResponse } from "next/server";
import { requireApiKey, isApiKeyError } from "@/lib/withApiKey";
import { query } from "@/lib/db";
import { randomUUID } from "crypto";

const GRADING_URL = process.env.GRADING_SERVICE_URL ?? "http://localhost:8001";

export async function POST(req: NextRequest) {
  const auth = await requireApiKey(req, "grading");
  if (isApiKeyError(auth)) return auth;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const stoneId = body.stone_id as string | undefined;
  if (!stoneId) {
    return NextResponse.json({ error: "stone_id is required" }, { status: 400 });
  }

  // Verify the stone belongs to this tenant and is in a gradeable state.
  const stones = await query<{
    id: string;
    status: string;
    shape: string | null;
    video_s3_key: string | null;
    color_grade: string | null;
    cut_grade: string | null;
    clarity_grade: string | null;
  }>(
    `SELECT s.id, s.status, s.shape, s.video_s3_key,
            c.color_grade, c.cut_grade, c.clarity_grade
     FROM stones s
     LEFT JOIN certificates c ON c.stone_id = s.id
     WHERE s.id = $1 AND s.tenant_id = $2`,
    [stoneId, auth.tenantId]
  );

  if (!stones.length) {
    return NextResponse.json(
      { error: "Stone not found or does not belong to your account" },
      { status: 404 }
    );
  }

  const stone = stones[0];

  if (!["uploaded", "grading"].includes(stone.status)) {
    return NextResponse.json(
      {
        error: `Stone must be in 'uploaded' status to start grading (current: ${stone.status})`,
        hint: "Stones in 'priced' or 'published' status have already been graded.",
      },
      { status: 409 }
    );
  }

  const videoPath = stone.video_s3_key?.startsWith("local/")
    ? `/tmp/lucidcarat-uploads/${stone.video_s3_key.replace("local/", "")}`
    : (stone.video_s3_key ?? body.video_path as string ?? null);

  const requestId = randomUUID();

  const resp = await fetch(`${GRADING_URL}/grading/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stone_id: stoneId,
      tenant_id: auth.tenantId,
      video_path: videoPath,
      shape: stone.shape ?? body.shape ?? null,
      cert_color: stone.color_grade ?? null,
      cert_cut: stone.cut_grade ?? null,
      cert_clarity: stone.clarity_grade ?? null,
      actor_id: null,          // API key caller — no user actor
      request_id: requestId,
      source: "api_v1",
    }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    return NextResponse.json(
      { error: "Grading service error", detail: data },
      { status: 502 }
    );
  }

  // Analytics event.
  query(
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, NULL, 'api_grading_submitted', 'stone', $2, $3)`,
    [
      auth.tenantId,
      stoneId,
      JSON.stringify({ job_id: data.job_id, api_key_id: auth.keyId, request_id: requestId }),
    ]
  ).catch(() => {});

  return NextResponse.json(
    {
      job_id: data.job_id,
      stone_id: stoneId,
      status: data.status ?? "queued",
      estimated_seconds: 30,
      poll_url: `/api/v1/grading/jobs/${data.job_id}`,
    },
    { status: 202 }
  );
}
