import type { Metadata } from "next";
import Link from "next/link";
import DemoRequestForm from "@/components/marketing/DemoRequestForm";

export const metadata: Metadata = {
  title: "LucidCarat — Diamond Grading & Provenance Platform",
  description:
    "AI-assisted grading, forecast-backed pricing, tamper-evident provenance, and a private B2B catalog — built for Surat's diamond houses by Centr8 LLP.",
};

// ── Reusable small components ─────────────────────────────────────────────────

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-lc-blue border border-lc-blue/30 bg-lc-blue/10 px-3 py-1 rounded-full uppercase tracking-widest">
      {children}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold text-lc-blue uppercase tracking-widest mb-3">
      {children}
    </p>
  );
}

function Disclaimer({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-lc-muted/70 border-l-2 border-lc-border pl-3 leading-relaxed">
      {children}
    </p>
  );
}

// ── Pain / solution cards ─────────────────────────────────────────────────────

const pains = [
  {
    icon: "⏱",
    pain: "Manual grading takes days",
    solution: "Upload a 360° video and receive an AI-assisted pre-screen of Color, Clarity, and Cut within ~30 seconds. Your grader confirms or overrides — every decision logged.",
    disclaimer:
      "LucidCarat grades are a decision aid, not a GIA or IGI certificate. Human confirmation is required before any stone is published.",
  },
  {
    icon: "📊",
    pain: "Pricing by feel — no benchmark",
    solution: "The ML pricing model forecasts a fair wholesale price with a confidence band and ranked contributing factors, drawing on shape, grade, carat, and current market references.",
    disclaimer:
      "Price forecasts are statistical estimates. Confidence bands reflect model uncertainty. Forecasts are not guaranteed transaction prices.",
  },
  {
    icon: "🔗",
    pain: "No verifiable paper trail",
    solution: "Every grading decision, price change, and ownership event is appended to a tamper-evident hash chain — the Diamond Passport — exportable as a verifiable JSON or PDF.",
    disclaimer:
      "The Diamond Passport records chain integrity. It does not constitute proof of real-world geographic origin.",
  },
];

// ── Feature grid ─────────────────────────────────────────────────────────────

const features = [
  {
    icon: "🎥",
    title: "360° video grading",
    body: "Upload a turntable video and cert. CV model pre-screens Color, Clarity, and Cut in ~30 seconds. Grader confirms or overrides; override rate and confidence tracked for ongoing model improvement.",
  },
  {
    icon: "💰",
    title: "Forecast-backed pricing",
    body: "XGBoost model outputs a fair price, a confidence band, and the top factors driving the estimate. Sales staff can apply markups and maintain private price books per buyer or group.",
  },
  {
    icon: "🔒",
    title: "Private B2B catalog",
    body: "Each buyer sees only their assigned pricing. Price books are tenant-isolated and access-logged. Stale-price protection prevents outdated rates from being quoted.",
  },
  {
    icon: "🧊",
    title: "React Three Fiber 3D viewer",
    body: "Buyers explore stones in an interactive 3D viewer. A non-3D specs fallback is shown on low-power devices or when WebGL is unavailable.",
  },
  {
    icon: "📋",
    title: "Diamond Passport",
    body: "Append-only, hash-chained provenance record per stone — mine to market. Exportable as a verifiable JSON bundle. Optional Polygon anchoring for independent chain-root verification.",
  },
  {
    icon: "🔌",
    title: "Standalone grading & provenance API",
    body: "The grading and provenance modules are available as authenticated, rate-limited, metered APIs — designed to integrate with certification labs and existing workflows.",
  },
  {
    icon: "🌐",
    title: "Embeddable verify widget",
    body: "A cross-origin iframe widget lets buyers verify a stone's specs and Passport chain directly on your own site, with a branded CTA linking back to your catalog.",
  },
  {
    icon: "📈",
    title: "Stripe billing & usage metering",
    body: "Per-seat subscriptions plus per-stone metered usage. Self-serve plan management, usage dashboards, and automatic tax calculation for US, UK, and UAE.",
  },
];

// ── How it works steps ────────────────────────────────────────────────────────

const steps = [
  {
    num: "01",
    title: "Upload video + cert",
    body: "Grader uploads a 360° turntable video and GIA/IGI certificate. Cert fields are auto-parsed; Carat comes from the cert, never estimated by CV.",
  },
  {
    num: "02",
    title: "AI pre-screens; grader confirms",
    body: "CV model pre-screens Color, Clarity, and Cut with per-dimension confidence scores and cert-disagreement flags. Grader reviews and confirms or overrides each grade before the stone can proceed.",
  },
  {
    num: "03",
    title: "Price forecast generated",
    body: "XGBoost model produces a fair price estimate and confidence band. Sales staff reviews, applies markup, and publishes the stone to the private catalog with buyer-specific pricing.",
  },
  {
    num: "04",
    title: "Buyer browses, inquires, and closes",
    body: "Buyers browse the private catalog, open the 3D viewer, and submit inquiries. Sales manages quotes and soft reservations in the lightweight CRM. Closing a deal appends a 'sold' event to the Diamond Passport.",
  },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="bg-white text-lc-text font-sans">

      {/* ── Hero ── */}
      <section className="pt-32 pb-24 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <Badge>Built for Surat&apos;s diamond industry</Badge>
          <h1 className="mt-6 text-4xl md:text-6xl font-bold leading-tight tracking-tight text-lc-text">
            Grade, price, and sell<br />
            <span className="text-lc-blue">diamonds — with a paper trail.</span>
          </h1>
          <p className="mt-6 text-lg text-lc-muted max-w-2xl mx-auto leading-relaxed">
            LucidCarat is a vertical SaaS for diamond houses that replaces slow manual grading
            with an AI-assisted pre-screen, forecast-backed pricing, a private B2B catalog,
            and a tamper-evident Diamond Passport from grading to sale.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="#request-demo"
              className="bg-lc-blue hover:bg-lc-blue-light text-white font-semibold px-8 py-3.5 rounded-lg transition-colors text-sm"
            >
              Request a demo
            </Link>
            <Link
              href="#how-it-works"
              className="text-lc-muted hover:text-lc-text text-sm transition-colors flex items-center gap-1.5"
            >
              See how it works <span>↓</span>
            </Link>
          </div>

          <div className="mt-6">
            <Disclaimer>
              LucidCarat grades are a pre-screening decision aid. They are not GIA or IGI certificates
              and carry no gemological or legal certification status. Human confirmation is required
              before any stone is published.
            </Disclaimer>
          </div>
        </div>
      </section>

      {/* ── Stat strip ── */}
      <section className="border-y border-lc-border bg-lc-surface py-10 px-6">
        <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
          {[
            { value: "~30s", label: "AI pre-screen per stone" },
            { value: "4Cs", label: "Color, Clarity, Cut + Carat from cert" },
            { value: "100%", label: "Human confirmation before publish" },
            { value: "Append-only", label: "Tamper-evident Diamond Passport" },
          ].map(s => (
            <div key={s.label}>
              <div className="text-2xl font-bold text-lc-blue">{s.value}</div>
              <div className="text-xs text-lc-muted mt-1">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Pain → Solution ── */}
      <section className="py-24 px-6" id="features">
        <div className="max-w-6xl mx-auto">
          <SectionLabel>Why LucidCarat</SectionLabel>
          <h2 className="text-3xl md:text-4xl font-bold mb-14">
            Three problems diamond houses face every day.
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {pains.map(p => (
              <div key={p.pain} className="bg-lc-surface border border-lc-border rounded-xl p-6 flex flex-col gap-4">
                <div className="text-3xl">{p.icon}</div>
                <div>
                  <p className="text-xs text-lc-muted line-through mb-1">{p.pain}</p>
                  <p className="text-lc-text text-sm leading-relaxed">{p.solution}</p>
                </div>
                <Disclaimer>{p.disclaimer}</Disclaimer>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="py-24 px-6 bg-lc-surface border-y border-lc-border" id="how-it-works">
        <div className="max-w-6xl mx-auto">
          <SectionLabel>Workflow</SectionLabel>
          <h2 className="text-3xl md:text-4xl font-bold mb-14">
            From upload to sold — in four steps.
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {steps.map((s, i) => (
              <div key={s.num} className="relative">
                {i < steps.length - 1 && (
                  <div className="hidden md:block absolute top-5 left-full w-full h-px bg-lc-border z-0" />
                )}
                <div className="relative z-10">
                  <div className="text-4xl font-bold text-lc-blue/30 mb-3">{s.num}</div>
                  <h3 className="font-semibold text-lc-text mb-2">{s.title}</h3>
                  <p className="text-sm text-lc-muted leading-relaxed">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Feature grid ── */}
      <section className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <SectionLabel>Full platform</SectionLabel>
          <h2 className="text-3xl md:text-4xl font-bold mb-14">
            Everything a diamond house needs in one platform.
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {features.map(f => (
              <div
                key={f.title}
                className="bg-lc-surface border border-lc-border rounded-xl p-5 flex flex-col gap-2 hover:border-lc-blue/40 transition-colors"
              >
                <div className="text-2xl">{f.icon}</div>
                <h3 className="font-semibold text-sm text-lc-text">{f.title}</h3>
                <p className="text-xs text-lc-muted leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── API / white-label band ── */}
      <section className="py-16 px-6 bg-lc-surface border-y border-lc-border">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          <div>
            <SectionLabel>For certification labs & integrators</SectionLabel>
            <h2 className="text-2xl font-bold text-lc-text mb-2">
              Grading & Provenance as standalone APIs.
            </h2>
            <p className="text-sm text-lc-muted max-w-lg leading-relaxed">
              The CV grading model and Diamond Passport engine are available as
              authenticated, rate-limited, metered APIs — independently of the
              full tenant platform. Designed for certification labs and workflow
              integrations.
            </p>
          </div>
          <Link
            href="/docs/api-reference"
            className="shrink-0 border border-lc-blue text-lc-blue hover:bg-lc-blue hover:text-white font-semibold text-sm px-6 py-3 rounded-lg transition-colors"
          >
            View API reference →
          </Link>
        </div>
      </section>

      {/* ── Centr8 attribution ── */}
      <section className="py-20 px-6">
        <div className="max-w-2xl mx-auto text-center">
          <SectionLabel>Built by Centr8 LLP</SectionLabel>
          <p className="text-lc-muted text-sm leading-relaxed">
            LucidCarat is a flagship product from{" "}
            <a
              href="https://centr8.io"
              target="_blank"
              rel="noopener noreferrer"
              className="text-lc-blue hover:text-lc-blue-light transition-colors"
            >
              Centr8 LLP
            </a>
            , a technology consultancy that builds full-stack AI, data, and cloud solutions
            for industry verticals. LucidCarat demonstrates Centr8&apos;s capabilities across
            AI/ML, web development, data & analytics, cloud infrastructure, security &
            compliance, and digital marketing — in a single production system.
          </p>
        </div>
      </section>

      {/* ── Demo request / lead form ── */}
      <section className="py-24 px-6 bg-lc-surface border-t border-lc-border" id="request-demo">
        <div className="max-w-lg mx-auto">
          <div className="text-center mb-10">
            <SectionLabel>Get started</SectionLabel>
            <h2 className="text-3xl font-bold text-lc-text">
              Request a demo from Centr8.
            </h2>
            <p className="mt-3 text-sm text-lc-muted">
              We onboard design-partner diamond houses directly. Tell us about your
              workflow and we will set up a tailored walkthrough.
            </p>
          </div>
          <DemoRequestForm source="lucidcarat_landing" />
        </div>
      </section>
    </div>
  );
}
