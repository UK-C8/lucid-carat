// FR-12, BR-7: API key management — create and list API keys.
// Session-authenticated; requires BILLING_MANAGE permission (admin role).
//
// POST — create a new API key. Returns the raw key ONCE — it is never stored.
// GET  — list all API keys for this tenant (prefix + metadata, never raw key).
import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { requirePermission, Permission } from "@/lib/rbac";
import { query } from "@/lib/db";
import { createHash, randomBytes } from "crypto";

function generateApiKey(): { raw: string; hash: string; prefix: string } {
  // Format: lc_ + 40 hex chars (160 bits of entropy)
  const raw = "lc_" + randomBytes(20).toString("hex");
  const hash = createHash("sha256").update(raw, "utf8").digest("hex");
  const prefix = raw.slice(0, 11); // "lc_" + first 8 hex chars
  return { raw, hash, prefix };
}

export async function POST(req: NextRequest) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.BILLING_MANAGE);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const name = (body.name as string | undefined)?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const scopes: string[] = Array.isArray(body.scopes) ? body.scopes : ["grading", "provenance"];
  const validScopes = ["grading", "provenance"];
  for (const s of scopes) {
    if (!validScopes.includes(s)) {
      return NextResponse.json(
        { error: `Invalid scope '${s}'. Allowed: ${validScopes.join(", ")}` },
        { status: 400 }
      );
    }
  }

  const rateLimitPerMinute = Number(body.rate_limit_per_minute) || 60;

  const { raw, hash, prefix } = generateApiKey();

  const rows = await query<{ id: string; created_at: string }>(
    `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, name, scopes, rate_limit_per_minute, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [session.tenantId, hash, prefix, name, scopes, rateLimitPerMinute, session.userId]
  );

  await query(
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'api_key_created', 'api_key', $3, $4)`,
    [session.tenantId, session.userId, rows[0].id, JSON.stringify({ name, scopes })]
  );

  return NextResponse.json(
    {
      id: rows[0].id,
      name,
      scopes,
      rate_limit_per_minute: rateLimitPerMinute,
      key_prefix: prefix,
      created_at: rows[0].created_at,
      // Raw key shown ONCE — never stored. User must copy it now.
      secret_key: raw,
      warning: "Store this key securely — it will not be shown again.",
    },
    { status: 201 }
  );
}

export async function GET() {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.BILLING_MANAGE);
  if (denied) return denied;

  const keys = await query<{
    id: string;
    name: string;
    scopes: string[];
    key_prefix: string;
    rate_limit_per_minute: number;
    last_used_at: Date | null;
    revoked_at: Date | null;
    created_at: Date;
    created_by_email: string | null;
  }>(
    `SELECT k.id, k.name, k.scopes, k.key_prefix, k.rate_limit_per_minute,
            k.last_used_at, k.revoked_at, k.created_at,
            u.email AS created_by_email
     FROM api_keys k
     LEFT JOIN users u ON u.id = k.created_by
     WHERE k.tenant_id = $1
     ORDER BY k.created_at DESC`,
    [session.tenantId]
  );

  return NextResponse.json(
    keys.map((k) => ({
      id: k.id,
      name: k.name,
      scopes: k.scopes,
      key_prefix: k.key_prefix,
      rate_limit_per_minute: k.rate_limit_per_minute,
      last_used_at: k.last_used_at,
      revoked: !!k.revoked_at,
      revoked_at: k.revoked_at,
      created_at: k.created_at,
      created_by: k.created_by_email,
    }))
  );
}
