import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { queryAsTenant } from "@/lib/db";
import { requirePermission, Permission } from "@/lib/rbac";
import { randomUUID } from "crypto";

const PRICING_URL = process.env.PRICING_SERVICE_URL ?? "http://localhost:8002";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.PRICE_VIEW);
  if (denied) return denied;

  const { id: stoneId } = await params;

  const rows = await queryAsTenant<{
    confirmed_color: string | null;
    confirmed_clarity: string | null;
    confirmed_cut: string | null;
    carat_weight: string | null;
    shape: string | null;
    fluorescence: string | null;
    depth_pct: string | null;
    table_pct: string | null;
    measurements_mm: string | null;
  }>(
    session.tenantId,
    `SELECT s.confirmed_color, s.confirmed_clarity, s.confirmed_cut,
            c.carat_weight, c.shape, c.fluorescence, c.depth_pct, c.table_pct, c.measurements_mm
     FROM stones s
     LEFT JOIN certificates c ON c.stone_id = s.id
     WHERE s.id = $1`,
    [stoneId]
  );

  if (!rows.length) return NextResponse.json({ error: "Stone not found" }, { status: 404 });
  const stone = rows[0];

  if (!stone.confirmed_color || !stone.confirmed_clarity) {
    return NextResponse.json({ error: "Stone not fully graded yet" }, { status: 409 });
  }

  const resp = await fetch(`${PRICING_URL}/forecast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stone_id: stoneId,
      tenant_id: session.tenantId,
      actor_id: session.userId,
      color_grade: stone.confirmed_color,
      clarity_grade: stone.confirmed_clarity,
      cut_grade: stone.confirmed_cut ?? null,
      carat_weight: stone.carat_weight ? parseFloat(stone.carat_weight) : 1.0,
      shape: stone.shape ?? "round_brilliant",
      fluorescence: stone.fluorescence ?? null,
      depth_pct: stone.depth_pct ? parseFloat(stone.depth_pct) : null,
      table_pct: stone.table_pct ? parseFloat(stone.table_pct) : null,
      measurements_mm: stone.measurements_mm ?? null,
      request_id: randomUUID(),
    }),
  });

  const data = await resp.json();

  if (resp.ok) {
    await queryAsTenant(
      session.tenantId,
      `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
       VALUES ($1, $2, 'per_stone_usage_metered', 'stone', $3, $4)`,
      [
        session.tenantId,
        session.userId,
        stoneId,
        JSON.stringify({ event: "price_forecast_generated", model_version: data.model_version }),
      ]
    );
  }

  return NextResponse.json(data, { status: resp.status });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.PRICE_VIEW);
  if (denied) return denied;

  const { id: stoneId } = await params;

  const resp = await fetch(
    `${PRICING_URL}/forecast/${stoneId}?tenant_id=${session.tenantId}`
  );
  const data = await resp.json();
  return NextResponse.json(data, { status: resp.status });
}
