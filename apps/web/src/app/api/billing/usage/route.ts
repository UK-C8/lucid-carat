// FR-12, BR-6: Usage summary endpoint for the billing dashboard.
import { NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { requirePermission, Permission } from "@/lib/rbac";
import { getUsageSummary } from "@/lib/billing";

export async function GET() {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.BILLING_VIEW);
  if (denied) return denied;

  const summary = await getUsageSummary(session.tenantId);
  return NextResponse.json(summary);
}
