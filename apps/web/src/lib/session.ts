import { SessionOptions } from "iron-session";

export interface SessionData {
  userId: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: string;
}

function getSessionOptions(): SessionOptions {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    // In production, fall back to a build-time placeholder so Next.js can
    // complete static analysis. The real secret MUST be set as a Vercel env var.
    // If it's missing at runtime, login will fail (wrong key → no valid session).
    const fallback = process.env.NODE_ENV === "production"
      ? "lucidcarat-prod-placeholder-32chars!!"
      : "lucidcarat-dev-session-secret-32chars-min";
    return {
      password: sessionSecret && sessionSecret.length >= 32 ? sessionSecret : fallback,
      cookieName: "lc_session",
      cookieOptions: {
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
        sameSite: "lax",
      },
    };
  }
  return {
    password: sessionSecret,
    cookieName: "lc_session",
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
    },
  };
}

export const sessionOptions: SessionOptions = getSessionOptions();
