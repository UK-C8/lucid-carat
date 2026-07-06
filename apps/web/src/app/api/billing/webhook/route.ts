// FR-12, BR-6: Stripe webhook handler.
// Handles subscription lifecycle events and fires tenant_subscription_active analytics.
// Raw body is required for signature verification — do NOT use NextRequest.json().
import { NextRequest, NextResponse } from "next/server";
import { stripe, STRIPE_WEBHOOK_SECRET } from "@/lib/stripe";
import { syncSubscription } from "@/lib/billing";
import { query } from "@/lib/db";
import type Stripe from "stripe";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[webhook] signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    await handleEvent(event);
  } catch (err) {
    console.error(`[webhook] failed to handle ${event.type}:`, err);
    // Return 200 so Stripe doesn't retry endlessly on transient DB errors.
    // Idempotent upserts mean a retry from Stripe is safe.
  }

  return NextResponse.json({ received: true });
}

async function handleEvent(event: Stripe.Event) {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const tenantId = sub.metadata?.tenant_id;
      if (!tenantId) {
        console.warn(`[webhook] subscription ${sub.id} has no tenant_id metadata`);
        return;
      }

      await syncSubscription(tenantId, sub);

      // Emit tenant_subscription_active analytics event (CLAUDE.md §11) on activation.
      if (event.type === "customer.subscription.created" && sub.status === "active") {
        await query(
          `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
           VALUES ($1, NULL, 'tenant_subscription_active', 'tenant', $1, $2)`,
          [
            tenantId,
            JSON.stringify({
              stripe_subscription_id: sub.id,
              plan: sub.metadata?.plan ?? "starter",
              status: sub.status,
            }),
          ]
        );
      }
      break;
    }

    case "checkout.session.completed": {
      // If we need the subscription after checkout (e.g. to pick up billing_country
      // from session metadata before the subscription.created event arrives), handle here.
      const cs = event.data.object as Stripe.Checkout.Session;
      const tenantId = cs.metadata?.tenant_id;
      if (!tenantId || !cs.subscription) break;

      // Retrieve the full subscription to sync it (may arrive before subscription.created).
      const fullSub = await stripe.subscriptions.retrieve(cs.subscription as string);
      // Merge checkout-level billing_country into subscription metadata.
      if (cs.customer_details?.address?.country) {
        await stripe.subscriptions.update(fullSub.id, {
          metadata: {
            ...fullSub.metadata,
            billing_country: cs.customer_details.address.country,
          },
        });
      }
      break;
    }

    default:
      break;
  }
}

// App Router reads the raw body via req.text() — no body-parser config needed.
