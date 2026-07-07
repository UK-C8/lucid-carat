// FR-10, BR-5: Public stone verification API.
// Keyed by stone_id OR cert_number (cert lookup falls back automatically).
// Returns only public fields — no pricing, no buyer data, no tenant internals.
// CORS: Access-Control-Allow-Origin * so third-party sites can embed the widget.
//
// Analytics events written to audit_log:
//   widget_verify_viewed — on every GET
//   (lead_submitted is a separate POST to /api/verify/[id]/lead)
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getPassportChain, validateChain } from "@/lib/passport";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Resolve: accept stone_id (UUID) or cert_number (alphanumeric)
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  const rows = await query<{
    stone_id: string;
    tenant_id: string;
    internal_ref: string;
    shape: string | null;
    carat_weight: string | null;
    confirmed_color: string | null;
    confirmed_clarity: string | null;
    confirmed_cut: string | null;
    lab_grown: boolean | null;
    cert_number: string | null;
    lab: string | null;
    fluorescence: string | null;
    polish: string | null;
    symmetry: string | null;
    tenant_name: string;
    status: string;
  }>(
    `SELECT s.id AS stone_id, s.tenant_id, s.internal_ref, s.shape, s.carat_weight,
            s.confirmed_color, s.confirmed_clarity, s.confirmed_cut, s.lab_grown,
            s.status,
            c.cert_number, c.lab, c.fluorescence, c.polish, c.symmetry,
            t.name AS tenant_name
     FROM stones s
     JOIN tenants t ON t.id = s.tenant_id
     LEFT JOIN certificates c ON c.stone_id = s.id
     WHERE ${isUuid ? "s.id = $1" : "c.cert_number = $1"}
       AND s.status IN ('published', 'sold')
     LIMIT 1`,
    [id]
  );

  if (!rows.length) {
    return NextResponse.json(
      { error: "Stone not found or not yet published" },
      { status: 404, headers: CORS }
    );
  }

  const stone = rows[0];

  // Passport summary (chain validity only — no event payloads exposed publicly)
  const events = await getPassportChain(stone.tenant_id, stone.stone_id);
  const validation = validateChain(events);

  const payload = {
    stone: {
      id: stone.stone_id,
      internal_ref: stone.internal_ref,
      shape: stone.shape,
      carat_weight: stone.carat_weight,
      confirmed_color: stone.confirmed_color,
      confirmed_clarity: stone.confirmed_clarity,
      confirmed_cut: stone.confirmed_cut,
      lab_grown: stone.lab_grown === true || stone.lab_grown === "true",
      fluorescence: stone.fluorescence,
      polish: stone.polish,
      symmetry: stone.symmetry,
      status: stone.status,
    },
    certificate: stone.cert_number
      ? { lab: stone.lab, cert_number: stone.cert_number }
      : null,
    passport: {
      event_count: events.length,
      chain_valid: validation.valid,
      head_hash: events.length
        ? events[events.length - 1].event_hash.slice(0, 16) + "…"
        : null,
    },
    verified_by: {
      tenant_name: stone.tenant_name,
      platform: "LucidCarat by Centr8",
    },
    disclaimer:
      "LucidCarat grades are computer-vision decision aids — not official GIA/IGI certificates. " +
      "Passport chain integrity proves tamper-evidence of this record; it does not constitute proof of real-world origin.",
  };

  // Fire-and-forget analytics: widget_verify_viewed (CLAUDE.md §11)
  query(
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, NULL, 'widget_verify_viewed', 'stone', $2, $3)`,
    [
      stone.tenant_id,
      stone.stone_id,
      JSON.stringify({ referer: req.headers.get("referer") ?? null }),
    ]
  ).catch(() => {/* never block the response */});

  return NextResponse.json(payload, {
    headers: {
      ...CORS,
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
