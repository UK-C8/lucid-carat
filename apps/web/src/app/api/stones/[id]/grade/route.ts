import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";
import { randomUUID } from "crypto";

const GRADING_URL = process.env.GRADING_SERVICE_URL ?? "http://localhost:8001";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.GRADE_RUN);
  if (denied) return denied;

  const { id: stoneId } = await params;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* no body — ok */ }

  const rows = await queryAsTenant<{
    color_grade: string | null;
    cut_grade: string | null;
    clarity_grade: string | null;
    shape: string | null;
    video_s3_key: string | null;
  }>(
    session.tenantId,
    `SELECT c.color_grade, c.cut_grade, c.clarity_grade, c.shape, s.video_s3_key
     FROM stones s LEFT JOIN certificates c ON c.stone_id = s.id
     WHERE s.id = $1`,
    [stoneId]
  );
  const cert = rows[0];

  const videoKey = cert?.video_s3_key ?? "local/no-video";
  const videoPath = videoKey.startsWith("local/")
    ? `/tmp/lucidcarat-uploads/${videoKey.replace("local/", "")}`
    : videoKey;

  const resp = await fetch(`${GRADING_URL}/grading/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stone_id: stoneId,
      tenant_id: session.tenantId,
      video_path: body.video_path ?? videoPath,
      shape: cert?.shape ?? body.shape ?? null,
      cert_color: cert?.color_grade ?? null,
      cert_cut: cert?.cut_grade ?? null,
      cert_clarity: cert?.clarity_grade ?? null,
      actor_id: session.userId,
      request_id: randomUUID(),
    }),
  });

  const data = await resp.json();
  return NextResponse.json(data, { status: resp.status });
}
