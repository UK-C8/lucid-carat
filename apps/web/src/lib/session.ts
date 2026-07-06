import { SessionOptions } from "iron-session";

export interface SessionData {
  userId: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: string;
}

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error(
    "[session] SESSION_SECRET environment variable is not set. " +
    "Set it to a random string of at least 32 characters before starting the application. " +
    "Do not use a hardcoded fallback — this would expose all user sessions to anyone who knows the string."
  );
}
if (sessionSecret.length < 32) {
  throw new Error(
    `[session] SESSION_SECRET must be at least 32 characters long (got ${sessionSecret.length}). ` +
    "Generate one with: openssl rand -hex 32"
  );
}

export const sessionOptions: SessionOptions = {
  password: sessionSecret,
  cookieName: "lc_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  },
};
