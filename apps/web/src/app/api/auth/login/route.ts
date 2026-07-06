import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { query } from "@/lib/db";
import { sessionOptions, SessionData } from "@/lib/session";

// Rate-limit config (BR-8, SOC 2 access-control).
// Window and threshold apply independently to email and IP.
const WINDOW_MINUTES = 15;
const MAX_FAILURES   = 5;

function windowStart(): Date {
  return new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);
}

async function countRecentFailures(field: "email" | "ip", value: string): Promise<number> {
  const col = field === "email" ? "email" : "ip";
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM login_attempts
     WHERE ${col} = $1 AND succeeded = FALSE AND occurred_at >= $2`,
    [value, windowStart()]
  );
  return parseInt(rows[0]?.n ?? "0", 10);
}

async function recordAttempt(email: string, ip: string, succeeded: boolean): Promise<void> {
  await query(
    "INSERT INTO login_attempts (email, ip, succeeded) VALUES ($1, $2, $3)",
    [email, ip, succeeded]
  );
}

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

export async function POST(req: NextRequest) {
  const { email, password } = await req.json();

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password required" }, { status: 400 });
  }

  const ip = getClientIp(req);

  // ── Rate-limit check (before DB user lookup to avoid user enumeration) ──────
  const [emailFailures, ipFailures] = await Promise.all([
    countRecentFailures("email", email),
    countRecentFailures("ip", ip),
  ]);

  if (emailFailures >= MAX_FAILURES || ipFailures >= MAX_FAILURES) {
    const lockedBy = emailFailures >= MAX_FAILURES ? "email" : "ip";

    // Log to audit_log (no tenant/actor — this is pre-auth)
    await query(
      `INSERT INTO audit_log (event_type, entity_type, payload, ip_address)
       VALUES ('login_lockout', 'auth', $1, $2::inet)`,
      [
        JSON.stringify({
          email,
          locked_by: lockedBy,
          email_failures: emailFailures,
          ip_failures: ipFailures,
          window_minutes: WINDOW_MINUTES,
        }),
        ip === "unknown" ? null : ip,
      ]
    ).catch(() => {}); // non-fatal — don't let audit failure block the response

    return NextResponse.json(
      {
        error: `Too many failed login attempts. Please wait ${WINDOW_MINUTES} minutes before trying again.`,
        retry_after_minutes: WINDOW_MINUTES,
      },
      {
        status: 429,
        headers: { "Retry-After": String(WINDOW_MINUTES * 60) },
      }
    );
  }

  // ── Credential check ─────────────────────────────────────────────────────────
  const rows = await query<{
    id: string;
    tenant_id: string;
    email: string;
    password_hash: string | null;
    full_name: string;
    role: string;
    is_active: boolean;
  }>(
    "SELECT id, tenant_id, email, password_hash, full_name, role, is_active FROM users WHERE email = $1 LIMIT 1",
    [email]
  );

  const user = rows[0];

  if (!user || !user.is_active || !user.password_hash) {
    await recordAttempt(email, ip, false);
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    await recordAttempt(email, ip, false);

    // Warn if this failure just hit the threshold
    const newCount = emailFailures + 1;
    const remaining = MAX_FAILURES - newCount;
    const message =
      remaining <= 0
        ? `Too many failed attempts. Please wait ${WINDOW_MINUTES} minutes.`
        : remaining === 1
        ? "Invalid credentials. 1 attempt remaining before lockout."
        : `Invalid credentials. ${remaining} attempts remaining before lockout.`;

    return NextResponse.json({ error: message }, { status: 401 });
  }

  // ── Success ──────────────────────────────────────────────────────────────────
  await recordAttempt(email, ip, true);
  await query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);

  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  session.userId   = user.id;
  session.tenantId = user.tenant_id;
  session.email    = user.email;
  session.fullName = user.full_name;
  session.role     = user.role;
  await session.save();

  return NextResponse.json({ ok: true, role: user.role, name: user.full_name });
}
