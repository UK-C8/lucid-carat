// FR-12, BR-6: Stripe Customer Portal — self-serve plan/seat management.
// Tenant admin POSTs → receives a redirect URL to Stripe's hosted portal.
import { NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { requirePermission, Permission } from "@/lib/rbac";
import { stripe } from "@/lib/stripe";
import { getOrCreateStripeCustomer } from "@/lib/billing";

export async function POST() {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.BILLING_MANAGE);
  if (denied) return denied;

  const customerId = await getOrCreateStripeCustomer(session.tenantId);
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${base}/billing`,
  });

  return NextResponse.json({ redirect_url: portalSession.url });
}
