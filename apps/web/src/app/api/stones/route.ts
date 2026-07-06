import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { query, queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";
import { writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";

const UPLOAD_DIR = "/tmp/lucidcarat-uploads";
const GRADING_URL = process.env.GRADING_SERVICE_URL ?? "http://localhost:8001";

export async function GET() {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.STONE_VIEW);
  if (denied) return denied;

  const stones = await queryAsTenant(
    session.tenantId,
    `SELECT s.id, s.internal_ref, s.status, s.shape, s.carat_weight,
            s.lab_grown, s.confirmed_color, s.confirmed_clarity, s.confirmed_cut,
            s.created_at, s.updated_at,
            c.cert_number, c.lab, c.color_grade, c.clarity_grade, c.cut_grade
     FROM stones s
     LEFT JOIN certificates c ON c.stone_id = s.id
     ORDER BY s.created_at DESC
     LIMIT 100`
  );

  return NextResponse.json(stones);
}

export async function POST(req: NextRequest) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.STONE_CREATE);
  if (denied) return denied;

  const formData = await req.formData();
  const videoFile = formData.get("video") as File | null;
  const certJson = formData.get("cert_data") as string | null;
  const internalRef = (formData.get("internal_ref") as string) || null;

  if (!certJson) {
    return NextResponse.json({ error: "cert_data required" }, { status: 400 });
  }

  const certData = JSON.parse(certJson);
  const stoneId = randomUUID();

  // Save video to local temp (Phase 1 — no S3 yet)
  let videoPath: string | null = null;
  let videoS3Key = "local/no-video";

  if (videoFile) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const ext = videoFile.name.split(".").pop() ?? "mp4";
    const filename = `${stoneId}.${ext}`;
    videoPath = path.join(UPLOAD_DIR, filename);
    const buffer = Buffer.from(await videoFile.arrayBuffer());
    await writeFile(videoPath, buffer);
    videoS3Key = `local/${filename}`;
  }

  // 1. Create stone record (owner-level: no tenant context set yet for new record)
  await query(
    `INSERT INTO stones (id, tenant_id, internal_ref, status, video_s3_key, cert_s3_key)
     VALUES ($1, $2, $3, 'uploaded', $4, $5)`,
    [stoneId, session.tenantId, internalRef, videoS3Key, `local/cert-${stoneId}.json`]
  );

  // Emit stone_uploaded analytics event
  await query(
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'stone_uploaded', 'stone', $3, $4)`,
    [
      session.tenantId,
      session.userId,
      stoneId,
      JSON.stringify({ internal_ref: internalRef, has_video: !!videoFile }),
    ]
  );

  // 2. Ingest cert via grading service (best-effort — stone is saved regardless)
  let certResult: unknown = null;
  let certWarning: string | null = null;

  try {
    const certResp = await fetch(`${GRADING_URL}/certs/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stone_id: stoneId,
        tenant_id: session.tenantId,
        lab: certData.lab ?? "GIA",
        cert_s3_key: `local/cert-${stoneId}.json`,
        fields: Object.fromEntries(
          Object.entries(certData.fields ?? certData).map(([k, v]) => [k, v != null ? String(v) : null])
        ),
        actor_id: session.userId,
        request_id: randomUUID(),
      }),
    });

    if (!certResp.ok) {
      certWarning = "Certificate data was saved but the grading service could not process it right now. You can retry grading from the stone detail page.";
    } else {
      certResult = await certResp.json();
    }
  } catch {
    certWarning = "Stone saved successfully. The grading service is currently unreachable — certificate processing will be available once the service is back online. You can start grading manually from the stone detail page.";
  }

  return NextResponse.json(
    {
      stone_id: stoneId,
      video_path: videoPath,
      cert: certResult,
      warning: certWarning,
    },
    { status: 201 }
  );
}
