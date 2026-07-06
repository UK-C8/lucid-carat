import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { requirePermission, Permission } from "@/lib/rbac";
import { randomUUID } from "crypto";

const PRICING_URL = process.env.PRICING_SERVICE_URL ?? "http://localhost:8002";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.PRICE_ADJUST);
  if (denied) return denied;

  const { id: stoneId } = await params;
  const body = await req.json();

  const resp = await fetch(`${PRICING_URL}/forecast/adjust`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stone_id: stoneId,
      tenant_id: session.tenantId,
      actor_id: session.userId,
      markup_pct: body.markup_pct,
      adjustment_note: body.adjustment_note ?? null,
      request_id: randomUUID(),
    }),
  });

  const data = await resp.json();
  return NextResponse.json(data, { status: resp.status });
}
