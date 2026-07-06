// FR-12, BR-7: Standalone Provenance API — export the full verifiable Passport as JSON.
//
// GET /api/v1/provenance/{stone_id}/export
// Auth: Bearer lc_<key>  (scope: provenance)
//
// Returns a self-contained, verifiable JSON document suitable for submission
// to compliance reviewers or embedding in trade documentation.
// The document contains all chain events plus a validation summary.
// Recipients can re-verify chain integrity offline using the published hash algorithm.
import { NextRequest, NextResponse } from "next/server";
import { requireApiKey, isApiKeyError } from "@/lib/withApiKey";
import { query } from "@/lib/db";
import { getPassportChain, validateChain } from "@/lib/passport";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ stone_id: string }> }
) {
  const auth = await requireApiKey(req, "provenance");
  if (isApiKeyError(auth)) return auth;

  const { stone_id } = await params;

  // Fetch stone + cert data.
  const stoneRows = await query<{
    id: string;
    internal_ref: string;
    status: string;
    shape: string | null;
    carat_weight: string | null;
    confirmed_color: string | null;
    confirmed_clarity: string | null;
    confirmed_cut: string | null;
    lab_grown: boolean;
    cert_number: string | null;
    lab: string | null;
    tenant_name: string;
  }>(
    `SELECT s.id, s.internal_ref, s.status, s.shape, s.lab_grown,
            s.confirmed_color, s.confirmed_clarity, s.confirmed_cut,
            c.carat_weight::text, c.cert_number, c.lab,
            t.name AS tenant_name
     FROM stones s
     JOIN tenants t ON t.id = s.tenant_id
     LEFT JOIN certificates c ON c.stone_id = s.id
     WHERE s.id = $1 AND s.tenant_id = $2`,
    [stone_id, auth.tenantId]
  );

  if (!stoneRows.length) {
    return NextResponse.json(
      { error: "Stone not found or does not belong to your account" },
      { status: 404 }
    );
  }

  const stone = stoneRows[0];
  const events = await getPassportChain(auth.tenantId, stone_id);
  const validation = validateChain(events);

  const exportDoc = {
    schema_version: "1.0",
    exported_at: new Date().toISOString(),
    stone: {
      id: stone.id,
      internal_ref: stone.internal_ref,
      shape: stone.shape,
      carat_weight: stone.carat_weight,
      color: stone.confirmed_color,
      clarity: stone.confirmed_clarity,
      cut: stone.confirmed_cut,
      lab_grown: stone.lab_grown,
      certificate: stone.cert_number
        ? { lab: stone.lab, cert_number: stone.cert_number }
        : null,
    },
    issuer: {
      name: stone.tenant_name,
      platform: "LucidCarat",
      platform_url: "https://lucidcarat.com",
    },
    passport: {
      chain_valid: validation.valid,
      event_count: validation.event_count,
      head_hash: events.length ? events[events.length - 1].event_hash : null,
      validation_detail: validation.detail,
      events: events.map((e) => ({
        seq: e.seq,
        event_type: e.event_type,
        occurred_at: e.occurred_at,
        location: e.location,
        payload: e.payload,
        event_hash: e.event_hash,
        prev_event_hash: e.prev_event_hash,
      })),
    },
    hash_algorithm: {
      name: "SHA-256",
      canonical_form:
        "SHA256(prev_hash + NUL + stone_id + NUL + event_type + NUL + sorted_json(payload) + NUL + occurred_at_iso)",
      verification_note:
        "Any party can independently verify the chain by recomputing each event_hash from the canonical form above.",
    },
    disclaimers: [
      "LucidCarat grades are computer-vision decision aids — not official GIA/IGI certificates.",
      "Passport chain integrity proves tamper-evidence of this digital record only.",
      "It does not constitute proof of real-world diamond origin or compliance with any regulatory framework.",
    ],
  };

  return NextResponse.json(exportDoc);
}
