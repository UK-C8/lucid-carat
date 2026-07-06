// FR-12, BR-6: Core billing functions.
// - getOrCreateStripeCustomer: idempotent, stores customer ID on tenants row
// - reportStoneUsage: meters one stone to Stripe + writes per_stone_usage_metered event
// - syncSubscription: upserts stripe_subscriptions from a Stripe subscription object
//
// Tax: prices are tax-exclusive; Stripe Tax handles US/UK/UAE automatically.
// Indian tenants (billing_manual = true) skip Stripe metering — billed separately.
import { stripe, STRIPE_PRICE_SEAT, STRIPE_PRICE_STONE, STRIPE_METER_EVENT_NAME } from "./stripe";
import { query } from "./db";
import type Stripe from "stripe";

// ── Customer ──────────────────────────────────────────────────────────────────

export async function getOrCreateStripeCustomer(tenantId: string): Promise<string> {
  const rows = await query<{ stripe_customer_id: string | null; name: string; billing_manual: boolean | null }>(
    `SELECT stripe_customer_id, name,
            EXISTS(SELECT 1 FROM stripe_subscriptions WHERE tenant_id = $1 AND billing_manual = true) AS billing_manual
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (!rows.length) throw new Error(`Tenant ${tenantId} not found`);

  if (rows[0].stripe_customer_id) return rows[0].stripe_customer_id;

  const customer = await stripe.customers.create({
    name: rows[0].name,
    metadata: { tenant_id: tenantId, platform: "lucidcarat" },
  });

  await query(
    `UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`,
    [customer.id, tenantId]
  );

  return customer.id;
}

// ── Per-stone metering ────────────────────────────────────────────────────────

export async function reportStoneUsage(
  tenantId: string,
  stoneId: string
): Promise<{ skipped: boolean; reason?: string }> {
  // 1. Check for active metered subscription item.
  const subs = await query<{
    metered_subscription_item_id: string | null;
    billing_manual: boolean;
    status: string;
  }>(
    `SELECT metered_subscription_item_id, billing_manual, status
     FROM stripe_subscriptions WHERE tenant_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId]
  );

  if (!subs.length || !subs[0].metered_subscription_item_id) {
    return { skipped: true, reason: "no_active_subscription" };
  }

  const sub = subs[0];
  if (sub.billing_manual) {
    return { skipped: true, reason: "billing_manual_india" };
  }
  if (!["active", "trialing"].includes(sub.status)) {
    return { skipped: true, reason: `subscription_status_${sub.status}` };
  }

  // 2. Idempotency: don't double-bill the same stone.
  const already = await query<{ id: string }>(
    `SELECT id FROM billed_stones WHERE tenant_id = $1 AND stone_id = $2`,
    [tenantId, stoneId]
  );
  if (already.length) return { skipped: true, reason: "already_billed" };

  // 3. Look up the Stripe customer ID for meter event routing.
  const tenantRows = await query<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
    [tenantId]
  );
  const customerId = tenantRows[0]?.stripe_customer_id;
  if (!customerId) return { skipped: true, reason: "no_stripe_customer" };

  // 4. Report usage via Stripe v2 Meter Events API (Stripe v22+).
  //    Idempotency key = tenant_id + stone_id so retries are safe.
  const meterEvent = await stripe.v2.billing.meterEvents.create({
    event_name: STRIPE_METER_EVENT_NAME,
    payload: {
      stripe_customer_id: customerId,
      value: "1",
    },
    identifier: `${tenantId}:${stoneId}`,
  });

  // 5. Mark stone as billed (idempotency guard).
  await query(
    `INSERT INTO billed_stones (tenant_id, stone_id, stripe_usage_record_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [tenantId, stoneId, meterEvent.identifier]
  );

  // 6. Analytics event (CLAUDE.md §11).
  await query(
    `INSERT INTO audit_log (tenant_id, actor_id, event_type, entity_type, entity_id, payload)
     VALUES ($1, NULL, 'per_stone_usage_metered', 'stone', $2, $3)`,
    [
      tenantId,
      stoneId,
      JSON.stringify({ stripe_meter_event_identifier: meterEvent.identifier }),
    ]
  );

  return { skipped: false };
}

// ── Subscription sync ─────────────────────────────────────────────────────────

export async function syncSubscription(
  tenantId: string,
  stripeSub: Stripe.Subscription
): Promise<void> {
  // Find which item is the seat price and which is the metered price.
  let seatItemId: string | null = null;
  let meteredItemId: string | null = null;
  let seatQty = 1;

  for (const item of stripeSub.items.data) {
    const priceId = item.price.id;
    if (priceId === STRIPE_PRICE_SEAT) { seatItemId = item.id; seatQty = item.quantity ?? 1; }
    if (priceId === STRIPE_PRICE_STONE) meteredItemId = item.id;
  }

  const plan = (stripeSub.metadata?.plan as string | undefined) ?? "starter";

  // current_period_start/end moved to SubscriptionItem in Stripe API v22+.
  const firstItem = stripeSub.items.data[0];
  const periodStart = (firstItem as unknown as { current_period_start?: number })?.current_period_start ?? null;
  const periodEnd   = (firstItem as unknown as { current_period_end?:   number })?.current_period_end   ?? null;

  await query(
    `INSERT INTO stripe_subscriptions
       (tenant_id, stripe_subscription_id, stripe_customer_id, status, plan,
        seat_subscription_item_id, metered_subscription_item_id, seat_quantity,
        current_period_start, current_period_end, cancel_at_period_end, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
             to_timestamp($9), to_timestamp($10), $11, NOW())
     ON CONFLICT (stripe_subscription_id)
     DO UPDATE SET
       status = EXCLUDED.status,
       plan = EXCLUDED.plan,
       seat_subscription_item_id = EXCLUDED.seat_subscription_item_id,
       metered_subscription_item_id = EXCLUDED.metered_subscription_item_id,
       seat_quantity = EXCLUDED.seat_quantity,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       updated_at = NOW()`,
    [
      tenantId,
      stripeSub.id,
      typeof stripeSub.customer === "string" ? stripeSub.customer : stripeSub.customer.id,
      stripeSub.status,
      plan,
      seatItemId,
      meteredItemId,
      seatQty,
      periodStart,
      periodEnd,
      stripeSub.cancel_at_period_end,
    ]
  );

  // Keep tenants.plan in sync.
  await query(
    `UPDATE tenants SET plan = $1 WHERE id = $2`,
    [plan, tenantId]
  );
}

// ── Usage summary (for dashboard) ────────────────────────────────────────────

export interface UsageSummary {
  subscription: {
    status: string;
    plan: string;
    seat_quantity: number;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
  stones_billed_this_period: number;
  stones_published_total: number;
  active_users: number;
  billing_manual: boolean;
}

export async function getUsageSummary(tenantId: string): Promise<UsageSummary> {
  const [subRows, stonesTotal, stonesPeriod, users] = await Promise.all([
    query<{
      status: string; plan: string; seat_quantity: number;
      current_period_end: Date | null; cancel_at_period_end: boolean;
      billing_manual: boolean;
    }>(
      `SELECT status, plan, seat_quantity, current_period_end,
              cancel_at_period_end, billing_manual
       FROM stripe_subscriptions WHERE tenant_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId]
    ),
    // Total published stones for this tenant (lifetime).
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM billed_stones WHERE tenant_id = $1`,
      [tenantId]
    ),
    // Stones billed in the current billing period.
    query<{ count: string }>(
      `SELECT COUNT(bs.*)::text AS count
       FROM billed_stones bs
       JOIN stripe_subscriptions ss ON ss.tenant_id = bs.tenant_id
       WHERE bs.tenant_id = $1
         AND bs.billed_at >= ss.current_period_start
         AND (ss.current_period_end IS NULL OR bs.billed_at <= ss.current_period_end)
       ORDER BY ss.created_at DESC LIMIT 1`,
      [tenantId]
    ),
    // Active (non-deleted) users in this tenant via svc pool.
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users WHERE tenant_id = $1 AND is_active = true`,
      [tenantId]
    ),
  ]);

  const sub = subRows[0] ?? null;

  return {
    subscription: sub
      ? {
          status: sub.status,
          plan: sub.plan,
          seat_quantity: sub.seat_quantity,
          current_period_end: sub.current_period_end
            ? new Date(sub.current_period_end).toISOString()
            : null,
          cancel_at_period_end: sub.cancel_at_period_end,
        }
      : null,
    stones_billed_this_period: parseInt(stonesPeriod[0]?.count ?? "0"),
    stones_published_total: parseInt(stonesTotal[0]?.count ?? "0"),
    active_users: parseInt(users[0]?.count ?? "0"),
    billing_manual: sub?.billing_manual ?? false,
  };
}
