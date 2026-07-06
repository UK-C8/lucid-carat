import type { Metadata } from "next";
import Link from "next/link";
import DemoRequestForm from "@/components/marketing/DemoRequestForm";

export const metadata: Metadata = {
  title: "Pricing — LucidCarat",
  description:
    "Per-seat subscriptions and per-stone metered usage. Start with a trial, scale as your catalog grows.",
};

function Tick() {
  return <span className="text-lc-emerald font-bold">✓</span>;
}

const plans = [
  {
    name: "Trial",
    tagline: "Evaluate before you commit",
    price: "Contact us",
    per: "",
    highlight: false,
    seats: "Up to 3 users",
    stones: "Metered per stone",
    features: [
      "AI grading pre-screen",
      "Price forecasting",
      "Diamond Passport",
      "Private catalog (1 buyer)",
      "3D viewer",
      "Email support",
    ],
    cta: "Request trial",
  },
  {
    name: "Starter",
    tagline: "For growing diamond houses",
    price: "Contact us",
    per: "",
    highlight: true,
    seats: "Up to 10 users",
    stones: "Metered per stone",
    features: [
      "Everything in Trial",
      "Unlimited buyers & price books",
      "Embeddable verify widget",
      "CRM (inquiry → quote → order)",
      "Stripe self-serve billing",
      "Priority support",
    ],
    cta: "Get started",
  },
  {
    name: "Growth",
    tagline: "Multi-team, multi-catalog",
    price: "Contact us",
    per: "",
    highlight: false,
    seats: "Up to 50 users",
    stones: "Metered per stone",
    features: [
      "Everything in Starter",
      "Standalone Grading API access",
      "Standalone Provenance API access",
      "Custom rate limits",
      "Usage dashboards",
      "Dedicated onboarding",
    ],
    cta: "Talk to us",
  },
  {
    name: "Enterprise",
    tagline: "Certification labs & large houses",
    price: "Custom",
    per: "",
    highlight: false,
    seats: "Unlimited users",
    stones: "Volume pricing",
    features: [
      "Everything in Growth",
      "White-label grading module",
      "Custom SLA & data residency",
      "SOC 2 Type I documentation",
      "Polygon provenance anchoring",
      "Dedicated account manager",
    ],
    cta: "Contact Centr8",
  },
];

const faq = [
  {
    q: "What does 'per stone' mean?",
    a: "Each stone that goes through the full workflow — upload, grading, pricing, and publish — counts as one metered unit. Archived or draft stones that never reach 'published' do not count.",
  },
  {
    q: "Are LucidCarat grades a GIA or IGI certificate?",
    a: "No. LucidCarat grades are an AI-assisted pre-screening decision aid. They require human confirmation before a stone can be published. They carry no gemological or legal certification status and are not a substitute for a GIA or IGI certificate.",
  },
  {
    q: "What does the Diamond Passport prove?",
    a: "The Diamond Passport is a tamper-evident, hash-chained record of grading, pricing, and ownership events for a stone. It proves chain integrity — that the record has not been altered. It does not constitute proof of geographic origin or Kimberley Process compliance on its own.",
  },
  {
    q: "Can I use just the grading or provenance module?",
    a: "Yes. The Grading API and Provenance API are available as standalone, authenticated, metered APIs on Growth and Enterprise plans — suitable for certification labs or existing workflow integrations.",
  },
  {
    q: "What currencies and regions are supported?",
    a: "Billing is in USD. Stripe Tax handles automatic tax calculation for US, UK, and UAE customers. Indian customers (GST) are handled on a manual billing arrangement — contact Centr8 for details.",
  },
  {
    q: "Is my data isolated from other tenants?",
    a: "Yes. Every tenant's stones, pricing, buyer data, and audit logs are isolated at the database layer via PostgreSQL Row Level Security. No tenant can read or infer another tenant's data.",
  },
];

export default function PricingPage() {
  return (
    <div className="bg-white text-lc-text font-sans">
      {/* ── Header ── */}
      <section className="pt-32 pb-16 px-6 text-center">
        <p className="text-xs font-semibold text-lc-blue uppercase tracking-widest mb-4">Pricing</p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">
          Start small. Scale with your catalog.
        </h1>
        <p className="text-lc-muted text-base max-w-xl mx-auto leading-relaxed">
          Per-seat subscriptions plus per-stone metered usage. You only pay for
          stones that complete the full grading → pricing → publish workflow.
        </p>
        <p className="mt-4 text-xs text-lc-muted/60">
          All prices in USD. Contact Centr8 for exact pricing — seat rates and
          per-stone rates are set on a per-tenant basis during onboarding.
        </p>
      </section>

      {/* ── Plan cards ── */}
      <section className="px-6 pb-20">
        <div className="max-w-6xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {plans.map(p => (
            <div
              key={p.name}
              className={`rounded-xl border p-6 flex flex-col gap-5 ${
                p.highlight
                  ? "bg-lc-surface border-lc-blue/60 ring-1 ring-lc-blue/30"
                  : "bg-lc-surface border-lc-border"
              }`}
            >
              {p.highlight && (
                <span className="self-start text-xs font-semibold text-white bg-lc-blue px-2 py-0.5 rounded-full uppercase tracking-wider">
                  Most popular
                </span>
              )}
              <div>
                <h2 className="font-bold text-lc-text text-lg">{p.name}</h2>
                <p className="text-xs text-lc-muted mt-0.5">{p.tagline}</p>
              </div>
              <div>
                <div className="text-2xl font-bold text-lc-text">{p.price}</div>
                {p.per && <div className="text-xs text-lc-muted">{p.per}</div>}
                <div className="text-xs text-lc-muted mt-1">{p.seats}</div>
                <div className="text-xs text-lc-muted">{p.stones}</div>
              </div>
              <ul className="space-y-2 text-xs text-lc-muted flex-1">
                {p.features.map(f => (
                  <li key={f} className="flex items-start gap-2">
                    <Tick />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link
                href="#contact-pricing"
                className={`text-center text-sm font-semibold rounded-lg px-4 py-2.5 transition-colors ${
                  p.highlight
                    ? "bg-lc-blue hover:bg-lc-blue-light text-white"
                    : "border border-lc-border text-lc-muted hover:border-lc-blue hover:text-lc-blue"
                }`}
              >
                {p.cta}
              </Link>
            </div>
          ))}
        </div>

        {/* Disclaimer under plans */}
        <div className="max-w-6xl mx-auto mt-8 px-1">
          <p className="text-xs text-lc-muted/60 leading-relaxed">
            LucidCarat grades are a pre-screening decision aid — not GIA/IGI certificates.
            Price forecasts are statistical estimates, not guaranteed transaction prices.
            Diamond Passport chain integrity does not constitute proof of geographic origin.
          </p>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="py-20 px-6 bg-lc-surface border-y border-lc-border">
        <div className="max-w-3xl mx-auto">
          <p className="text-xs font-semibold text-lc-blue uppercase tracking-widest mb-3">FAQ</p>
          <h2 className="text-3xl font-bold mb-12">Common questions.</h2>
          <div className="space-y-8">
            {faq.map(item => (
              <div key={item.q}>
                <h3 className="font-semibold text-lc-text mb-2">{item.q}</h3>
                <p className="text-sm text-lc-muted leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Lead form ── */}
      <section className="py-24 px-6" id="contact-pricing">
        <div className="max-w-lg mx-auto">
          <div className="text-center mb-10">
            <p className="text-xs font-semibold text-lc-blue uppercase tracking-widest mb-3">Talk to us</p>
            <h2 className="text-3xl font-bold text-lc-text">Get exact pricing for your house.</h2>
            <p className="mt-3 text-sm text-lc-muted">
              Seat rates and per-stone rates are configured per tenant during onboarding.
              Fill in the form and the Centr8 team will follow up within one business day.
            </p>
          </div>
          <DemoRequestForm source="lucidcarat_pricing" />
        </div>
      </section>
    </div>
  );
}
