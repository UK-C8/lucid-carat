// Marketing site lead capture — fires lead_submitted analytics event (CLAUDE.md §11).
// Public endpoint — no auth. Rate limiting is infra-layer (ALB / WAF).
import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function POST(req: NextRequest) {
  let body: { name?: string; email?: string; company?: string; message?: string; source?: string } = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.email || typeof body.email !== "string" || !body.email.includes("@")) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
  }

  await query(
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES (NULL, NULL, 'lead_submitted', 'lead', gen_random_uuid(), $1)`,
    [
      JSON.stringify({
        source: body.source ?? "lucidcarat",
        name: body.name ?? null,
        email: body.email,
        company: body.company ?? null,
        message: body.message ?? null,
        referer: req.headers.get("referer") ?? null,
        user_agent: req.headers.get("user-agent") ?? null,
      }),
    ]
  );

  return NextResponse.json({ ok: true });
}
