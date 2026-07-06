import { NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { sessionOptions, SessionData } from "./session";

export async function getSession(): Promise<SessionData | null> {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.userId) return null;
  return session;
}

export async function requireSession(): Promise<SessionData> {
  const session = await getSession();
  if (!session) throw new Error("UNAUTHORIZED");
  return session;
}

export function unauthorized() {
  return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
}
