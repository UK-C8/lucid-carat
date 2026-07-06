import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";

const GRADING_URL = process.env.GRADING_SERVICE_URL ?? "http://localhost:8001";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const { id: stoneId } = await params;

  const resp = await fetch(
    `${GRADING_URL}/grading/stones/${stoneId}/review?tenant_id=${session.tenantId}`
  );
  const data = await resp.json();
  return NextResponse.json(data, { status: resp.status });
}
