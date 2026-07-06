import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { requirePermission, Permission } from "@/lib/rbac";
import { randomUUID } from "crypto";

const GRADING_URL = process.env.GRADING_SERVICE_URL ?? "http://localhost:8001";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.STONE_ADVANCE);
  if (denied) return denied;

  const { id: stoneId } = await params;

  const resp = await fetch(`${GRADING_URL}/grading/stones/${stoneId}/advance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenant_id: session.tenantId,
      actor_id: session.userId,
      request_id: randomUUID(),
    }),
  });

  const data = await resp.json();
  return NextResponse.json(data, { status: resp.status });
}
