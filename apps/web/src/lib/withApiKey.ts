// FR-12, BR-7: API key authentication + scope enforcement + rate limiting.
//
// Usage:
//   const auth = await requireApiKey(req, "grading");
//   if ("error" in auth) return auth; // already a NextResponse
//   // auth.tenantId, auth.keyId, auth.scopes
//
// Keys are formatted as `lc_` + 40 hex chars.
// Stored as SHA-256(rawKey) — raw key is shown once on creation, never logged.
// Rate limiting uses a per-minute pg sliding window (V020 migration).
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { query } from "./db";

export interface ApiKeyContext {
  tenantId: string;
  keyId: string;
  scopes: string[];
}

type AuthResult = ApiKeyContext | NextResponse;

export async function requireApiKey(
  req: NextRequest,
  requiredScope: string
): Promise<AuthResult> {
  const auth = req.headers.get("authorization") ?? "";
  const rawKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!rawKey.startsWith("lc_")) {
    return NextResponse.json(
      { error: "Missing or invalid Authorization header. Expected: Bearer lc_<key>" },
      { status: 401 }
    );
  }

  const keyHash = createHash("sha256").update(rawKey, "utf8").digest("hex");

  const rows = await query<{
    id: string;
    tenant_id: string;
    scopes: string[];
    rate_limit_per_minute: number;
    revoked_at: Date | null;
  }>(
    `SELECT id, tenant_id, scopes, rate_limit_per_minute, revoked_at
     FROM api_keys WHERE key_hash = $1`,
    [keyHash]
  );

  if (!rows.length) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }

  const key = rows[0];

  if (key.revoked_at) {
    return NextResponse.json({ error: "API key has been revoked" }, { status: 401 });
  }

  if (!key.scopes.includes(requiredScope)) {
    return NextResponse.json(
      { error: `API key does not have required scope: '${requiredScope}'` },
      { status: 403 }
    );
  }

  // ── Rate limiting (pg sliding window per minute) ──────────────────────────
  const minuteBucket = Math.floor(Date.now() / 1000 / 60);

  const rateRows = await query<{ count: number }>(
    `INSERT INTO api_rate_limit (key_id, minute_bucket, count)
     VALUES ($1, $2, 1)
     ON CONFLICT (key_id, minute_bucket)
     DO UPDATE SET count = api_rate_limit.count + 1
     RETURNING count`,
    [key.id, minuteBucket]
  );

  const callCount = rateRows[0]?.count ?? 1;

  // Touch last_used_at and opportunistically prune old rate limit rows (1-in-50).
  const shouldPrune = Math.random() < 0.02;
  if (shouldPrune) {
    query(`SELECT prune_api_rate_limit()`).catch(() => {});
  }
  query(
    `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
    [key.id]
  ).catch(() => {});

  if (callCount > key.rate_limit_per_minute) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded",
        limit: key.rate_limit_per_minute,
        window: "1 minute",
      },
      {
        status: 429,
        headers: {
          "Retry-After": "60",
          "X-RateLimit-Limit": String(key.rate_limit_per_minute),
          "X-RateLimit-Remaining": "0",
        },
      }
    );
  }

  return {
    tenantId: key.tenant_id,
    keyId: key.id,
    scopes: key.scopes,
  };
}

export function isApiKeyError(result: AuthResult): result is NextResponse {
  return result instanceof NextResponse;
}
