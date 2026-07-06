// FR-12, BR-6: Stripe Checkout — creates a hosted checkout session for initial subscription.
// Tenant admin POSTs { plan, seats, billing_country } and gets back a redirect URL.
// Stripe Tax handles US/UK/UAE tax automatically (enabled on Stripe account).
// Indian tenants (IN) get billing_manual = true and are redirected to a manual-billing page.
import { NextRequest, NextResponse } from "next/server";
import { requireSession, unauthorized } from "@/lib/withSession";
import { requirePermission, Permission } from "@/lib/rbac";
import { stripe, STRIPE_PRICE_SEAT, STRIPE_PRICE_STONE, PLAN_SEAT_LIMITS } from "@/lib/stripe";
import { getOrCreateStripeCustomer } from "@/lib/billing";
import { query } from "@/lib/db";

export async function POST(req: NextRequest) {
  let session;
  try { session = await requireSession(); }
  catch { return unauthorized(); }

  const denied = requirePermission(session, Permission.BILLING_MANAGE);
  if (denied) return denied;

  const { plan = "starter", seats = 1, billing_country = "" } = await req.json();

  if (!PLAN_SEAT_LIMITS[plan]) {
    return NextResponse.json({ error: `Unknown plan: ${plan}` }, { status: 400 });
  }

  // Indian tenants: flag and skip Stripe; they're invoiced manually.
  if (billing_country?.toUpperCase() === "IN") {
    await query(
      `INSERT INTO stripe_subscriptions
         (tenant_id, stripe_subscription_id, stripe_customer_id, status, plan,
          seat_quantity, billing_country, billing_manual)
       VALUES ($1, $2, $3, 'manual', $4, $5, 'IN', true)
       ON CONFLICT DO NOTHING`,
      [
        session.tenantId,
        `manual_${session.tenantId}`,
        "manual",
        plan,
        seats,
      ]
    );
    const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
    return NextResponse.json({ redirect_url: `${base}/billing?manual=true` });
  }

  const customerId = await getOrCreateStripeCustomer(session.tenantId);

  const lineItems: { price: string; quantity?: number }[] = [
    { price: STRIPE_PRICE_SEAT, quantity: seats },
  ];
  if (STRIPE_PRICE_STONE) {
    lineItems.push({ price: STRIPE_PRICE_STONE });
  }

  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: lineItems,
    automatic_tax: { enabled: true },
    customer_update: { address: "auto" },
    subscription_data: {
      metadata: {
        tenant_id: session.tenantId,
        plan,
        billing_country: billing_country || "",
      },
    },
    success_url: `${base}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/billing?checkout=cancelled`,
    metadata: { tenant_id: session.tenantId },
  });

  return NextResponse.json({ redirect_url: checkoutSession.url });
}
