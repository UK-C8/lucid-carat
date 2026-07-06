import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
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

  const denied = requirePermission(session, Permission.GRADE_OVERRIDE);
  if (denied) return denied;

  const { id: stoneId } = await params;
  const body = await req.json();

  const resp = await fetch(`${GRADING_URL}/grading/stones/${stoneId}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenant_id: session.tenantId,
      actor_id: session.userId,
      dimension: body.dimension,
      action: body.action,
      new_grade: body.new_grade,
      override_reason: body.override_reason ?? null,
      request_id: randomUUID(),
    }),
  });

  const data = await resp.json();
  return NextResponse.json(data, { status: resp.status });
}
