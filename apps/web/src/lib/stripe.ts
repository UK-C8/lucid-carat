// FR-12, BR-6: Stripe client singleton.
// Env vars required:
//   STRIPE_SECRET_KEY   — sk_test_… / sk_live_…
//   STRIPE_WEBHOOK_SECRET — whsec_…
//
// Price IDs (create once in Stripe dashboard or via Stripe CLI):
//   STRIPE_PRICE_SEAT       — recurring, per_unit, $99/seat/month
//   STRIPE_PRICE_STONE      — recurring, metered, $2.00/stone (aggregate_usage: sum)
//
// Tax: Stripe Tax is enabled on the Stripe account. All prices are tax-exclusive.
// Currency: USD throughout (per decision in Phase 3 Step 3).
import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("[billing] STRIPE_SECRET_KEY not set — billing calls will fail");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder", {
  apiVersion: "2026-06-24.dahlia",
  typescript: true,
});

export const STRIPE_PRICE_SEAT   = process.env.STRIPE_PRICE_SEAT   ?? "";
export const STRIPE_PRICE_STONE  = process.env.STRIPE_PRICE_STONE  ?? "";
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
// Meter event name configured in Stripe dashboard (Usage-Based Billing v2 API).
export const STRIPE_METER_EVENT_NAME = process.env.STRIPE_METER_EVENT_NAME ?? "stone_published";

// Billing plans mapped to seat limits (soft cap; enforcement is advisory in v1).
export const PLAN_SEAT_LIMITS: Record<string, number> = {
  trial:      3,
  starter:    10,
  growth:     50,
  enterprise: Infinity,
};
