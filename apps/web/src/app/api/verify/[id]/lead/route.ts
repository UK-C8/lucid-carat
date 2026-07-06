// FR-10, BR-5: Record a lead from the embeddable widget CTA.
// Fires lead_submitted (source: lucidcarat) analytics event (CLAUDE.md §11).
// Public — no auth required; rate-limiting is infrastructure-level (TODO: add in Phase 3 hardening).
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: stoneId } = await params;

  let body: { email?: string; name?: string } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  // Resolve stone + tenant (must be published/sold to be verifiable)
  const rows = await query<{ tenant_id: string }>(
    `SELECT tenant_id FROM stones WHERE id = $1 AND status IN ('published', 'sold') LIMIT 1`,
    [stoneId]
  );
  if (!rows.length) {
    return NextResponse.json({ error: "Stone not found" }, { status: 404, headers: CORS });
  }

  const { tenant_id } = rows[0];

  await query(
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, NULL, 'lead_submitted', 'stone', $2, $3)`,
    [
      tenant_id,
      stoneId,
      JSON.stringify({
        source: "lucidcarat",
        email: body.email ?? null,
        name: body.name ?? null,
        referer: req.headers.get("referer") ?? null,
      }),
    ]
  );

  return NextResponse.json({ ok: true }, { headers: CORS });
}
