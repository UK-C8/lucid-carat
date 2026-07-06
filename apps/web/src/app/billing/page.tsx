"use client";
// FR-12, BR-6: Self-serve billing dashboard for tenant admins.
// Shows plan, seat count, per-stone usage this period, and billing management links.
import { useEffect, useState } from "react";
import type { UsageSummary } from "@/lib/billing";

const PLAN_LABELS: Record<string, string> = {
  trial: "Trial",
  starter: "Starter",
  growth: "Growth",
  enterprise: "Enterprise",
  manual: "Manual (India)",
};

const STATUS_COLORS: Record<string, string> = {
  active:   "bg-green-100 text-green-800",
  trialing: "bg-blue-100 text-blue-800",
  past_due: "bg-yellow-100 text-yellow-800",
  canceled: "bg-red-100 text-red-800",
  manual:   "bg-gray-100 text-gray-700",
};

export default function BillingPage() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [checkoutResult, setCheckoutResult] = useState<"success" | "cancelled" | null>(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      return (p.get("checkout") as "success" | "cancelled" | null);
    }
    return null;
  });

  useEffect(() => {
    fetch("/api/billing/usage")
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  async function handleCheckout() {
    setActionLoading(true);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "starter", seats: 1, billing_country: "" }),
      });
      const json = await res.json();
      if (json.redirect_url) window.location.href = json.redirect_url;
    } finally {
      setActionLoading(false);
    }
  }

  async function handlePortal() {
    setActionLoading(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const json = await res.json();
      if (json.redirect_url) window.location.href = json.redirect_url;
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="p-8 text-sm text-gray-500">Loading billing…</div>
    );
  }

  const sub = data?.subscription;
  const statusLabel = sub?.status ?? "none";
  const statusClass = STATUS_COLORS[statusLabel] ?? "bg-gray-100 text-gray-700";

  return (
    <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">
      <h1 className="text-2xl font-semibold text-gray-900">Billing & Usage</h1>

      {checkoutResult === "success" && (
        <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          Subscription activated. Thank you!
        </div>
      )}
      {checkoutResult === "cancelled" && (
        <div className="rounded-md bg-yellow-50 border border-yellow-200 px-4 py-3 text-sm text-yellow-700">
          Checkout cancelled. You can start again below.
        </div>
      )}
      {data?.billing_manual && (
        <div className="rounded-md bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
          Your account is on manual billing (India/GST). Contact us to manage your subscription.
        </div>
      )}

      {/* Plan card */}
      <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100 shadow-sm">
        <div className="px-5 py-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Current plan</p>
            <p className="text-lg font-semibold text-gray-900 mt-0.5">
              {PLAN_LABELS[sub?.plan ?? "none"] ?? sub?.plan ?? "No subscription"}
            </p>
          </div>
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${statusClass}`}>
            {statusLabel}
          </span>
        </div>

        <dl className="grid grid-cols-2 divide-x divide-gray-100">
          <div className="px-5 py-4">
            <dt className="text-xs text-gray-500">Seats</dt>
            <dd className="text-2xl font-bold text-gray-900 mt-1">{sub?.seat_quantity ?? "—"}</dd>
          </div>
          <div className="px-5 py-4">
            <dt className="text-xs text-gray-500">Active users</dt>
            <dd className="text-2xl font-bold text-gray-900 mt-1">{data?.active_users ?? "—"}</dd>
          </div>
        </dl>

        {sub?.current_period_end && (
          <div className="px-5 py-3 text-xs text-gray-500">
            {sub.cancel_at_period_end
              ? `Cancels on ${new Date(sub.current_period_end).toLocaleDateString()}`
              : `Next billing date: ${new Date(sub.current_period_end).toLocaleDateString()}`}
          </div>
        )}
      </div>

      {/* Stone usage card */}
      <div className="rounded-lg border border-gray-200 bg-white shadow-sm divide-y divide-gray-100">
        <div className="px-5 py-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Stone usage (per-stone metering)</p>
        </div>
        <dl className="grid grid-cols-2 divide-x divide-gray-100">
          <div className="px-5 py-4">
            <dt className="text-xs text-gray-500">This billing period</dt>
            <dd className="text-2xl font-bold text-gray-900 mt-1">{data?.stones_billed_this_period ?? 0}</dd>
          </div>
          <div className="px-5 py-4">
            <dt className="text-xs text-gray-500">All time</dt>
            <dd className="text-2xl font-bold text-gray-900 mt-1">{data?.stones_published_total ?? 0}</dd>
          </div>
        </dl>
      </div>

      {/* Actions */}
      {!data?.billing_manual && (
        <div className="flex gap-3">
          {!sub || sub.status === "canceled" ? (
            <button
              onClick={handleCheckout}
              disabled={actionLoading}
              className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {actionLoading ? "Redirecting…" : "Subscribe now"}
            </button>
          ) : (
            <button
              onClick={handlePortal}
              disabled={actionLoading}
              className="px-4 py-2 rounded-md bg-white border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {actionLoading ? "Redirecting…" : "Manage subscription"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
