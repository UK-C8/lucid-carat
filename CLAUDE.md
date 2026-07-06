# CLAUDE.md — LucidCarat

Persistent context for Claude Code sessions on this project. Read this in full before starting any phase of work.

---

## 1. What this is

LucidCarat is Centr8 LLP's Phase 3 flagship product: a vertical SaaS for diamond houses in Surat that:

1. **Grades** a diamond's 4Cs (Color, Clarity, Cut — Carat comes from the cert/scale) from a 360-degree turntable video plus an uploaded GIA/IGI lab certificate, using computer vision.
2. **Prices** the stone with an ML model that forecasts a fair wholesale sell price, a confidence band, and the top price drivers.
3. **Sells** it through a multi-tenant B2B catalog with private, per-buyer/per-group price books, plus a lightweight CRM (inquiry → quote → order).
4. **Traces** it via a hash-chained "Diamond Passport" — an append-only, tamper-evident record of mine-to-market provenance events, with an optional Polygon anchor for independent verification.

It also ships a buyer-facing React Three Fiber 3D viewer and an embeddable "Verify this diamond" widget that a tenant can put on their own site.

It is the higher-end sibling of **DiamondPrice IQ** (Phase 1 quick-win tool). DiamondPrice IQ feeds top-of-funnel demand into LucidCarat.

**Dual purpose:** this is simultaneously (a) a Centr8 showcase proving 7 of its 8 service pillars (AI/ML, Web & Mobile Dev, Data & Analytics, Cloud & DevOps, IT Consulting, Security & Compliance, Digital Marketing) in one production system, and (b) a real revenue product sold per-seat + per-stone to diamond houses, with a second revenue path of white-labeling the grading/provenance modules as standalone APIs to certification labs.

---

## 2. Hard boundaries (do not build these)

- No physical capture hardware (turntable rigs, calibrated lighting, microscopes) and no in-house gemological lab.
- LucidCarat grades are **not** a legally recognized certificate replacing GIA/IGI. They are a pre-screen/decision aid. Never present them as an official cert anywhere in copy, UI, or exports.
- No consumer D2C storefront or retail point-of-sale.
- No full payments/escrow, trade finance, logistics/customs filing, or insurance underwriting.
- No melee/parcel bulk grading and no colored gemstones in v1 — loose polished diamonds only. Lab-grown stones are flagged from the cert but not separately price-modeled in v1.
- No native mobile apps in v1 — responsive web only.
- No on-chain settlement or tokenizing diamonds as tradable assets. The Polygon anchor (if used) proves provenance-chain integrity only — it is not a marketplace token and does not prove real-world origin truth.

If a request would cross one of these lines, flag it and confirm before proceeding rather than building it.

---

## 3. Tech stack

| Layer | Choice |
|---|---|
| Frontend / web app | Next.js 14 (App Router) + React + Tailwind |
| 3D viewer | React Three Fiber |
| Embeddable widget | iframe/script, cross-origin safe |
| ML / CV services | Python + FastAPI serving PyTorch (CV 4Cs grading) and XGBoost (price forecast); offline eval harness |
| Core data store | PostgreSQL, multi-tenant |
| Time-series data | TimescaleDB extension (price/provenance events) |
| Queue / cache / sessions | Redis |
| Object storage | S3 (videos, certs, Passport exports) |
| Provenance | Internal append-only hash chain per stone; optional Polygon anchor of the chain/Merkle root |
| Infra / DevOps | AWS ECS/Fargate, ap-south-1 (Mumbai) primary; Terraform; GitHub Actions CI/CD; CloudWatch |
| Billing | Stripe Billing (per-seat subscriptions + metered per-stone usage) |
| Security | RBAC + tenant isolation at app layer; KMS/S3 SSE encryption; secrets manager; centralized audit logging; SOC 2-aligned controls; DPDP (India) + GDPR-aligned data-subject tooling |
| Analytics | Event pipeline to warehouse + GA4/server-side events on public verify pages; lead attribution to Centr8 |

This mirrors the Centr8-wide infra pattern (Vercel/Next.js, Postgres, Redis, Railway/Render-style backend services) but scales up to AWS ECS/Fargate + Terraform given the multi-tenant SaaS and compliance requirements — this is not a simple Vercel + Neon showcase tool like SiteScore or DiamondPrice IQ.

---

## 4. Users

- **Diamond house staff** (graders, sales/pricing staff, admins) — the primary tenant-side users. Want faster grading, defensible pricing, private price books that don't leak, and easier export paperwork.
- **Overseas B2B buyers** (US/UK/UAE jewelers & importers) — end buyers using the catalog, 3D viewer, and verify widget. Want trustworthy specs, verifiable provenance, live private pricing, low-friction inquiry.
- **Certification labs (GIA/IGI-type) & compliance advisors** — cert data source, potential white-label prospect, and compliance reviewer for Kimberley Process / KYC alignment.
- **Centr8 internal** — Product/Tech Lead (architecture/delivery owner), ML/CV Engineer (grading + pricing models), Founders/Leadership (ROI + flagship case study).

Primary end-to-end flow: grader uploads video+cert → cert ingestion parses fields → CV grading runs async (~30s) → grader confirms/overrides each grade → stone unlocks to "priced" → sales staff reviews price forecast, applies markup, publishes to catalog with buyer-specific pricing → Passport grading event appended → buyer browses catalog, opens 3D viewer, submits inquiry → quote thread opens in CRM → deal closes, stone marked sold, Passport records ownership/export event → buyer can later verify via the embeddable widget.

---

## 5. Business requirements (BR) — from BRD

| ID | Requirement | Priority |
|---|---|---|
| BR-1 | Auto-grade Color/Clarity/Cut from video + cert, with confidence/disagreement flags, one-click human override, full audit trail | Must |
| BR-2 | Forecast fair wholesale price with confidence band + top contributing factors | Must |
| BR-3 | Multi-tenant B2B catalog with private price books per buyer/group, stale-price protection, access logging | Must |
| BR-4 | Hash-chained Diamond Passport per stone, tamper-evident, exportable for compliance | Must |
| BR-5 | Buyer-facing 3D viewer + embeddable "Verify this diamond" widget | Must |
| BR-6 | Stripe billing, per-seat + per-stone, self-serve plan management + usage metering | Should |
| BR-7 | Grading and Provenance exposed as authenticated, documented, metered standalone APIs | Should |
| BR-8 | Strict tenant data isolation, RBAC, full audit logging, SOC 2-aligned controls | Must |
| BR-9 | End-to-end instrumentation for product analytics and Centr8 lead attribution | Should |

## 6. Functional requirements (FR) — from PRD

| ID | Requirement | Priority | Key notes |
|---|---|---|---|
| FR-1 | Stone intake: 360° video upload to S3 + cert; status lifecycle `uploaded → grading → priced → published → sold/archived` | Must | Resumable/large upload, per-tenant S3 prefix, lab-grown flag from cert |
| FR-2 | Cert ingestion: parse GIA/IGI certs, verify against cert-number lookup, flag low-confidence fields | Must | Carat comes from cert/scale, never estimated by CV |
| FR-3 | CV 4Cs grading via PyTorch/FastAPI: predict Color/Clarity/Cut with confidence + cert-disagreement flags | Must | MVP prioritizes Color/Cut; Clarity in beta with conservative confidence |
| FR-4 | Human-in-the-loop override: accept/override any grade; override-or-confirm required before publish; log who/when/old/new | Must | Override events feed model retraining + override-rate metric |
| FR-5 | Price forecasting via XGBoost: fair price + confidence band + ranked drivers; manual markup/markdown allowed | Must | Per-shape models, explainability via feature contributions |
| FR-6 | B2B catalog with private price books; visibility/pricing scoped per buyer/group; stale-price protection; access logging | Must | Buyer sees only assigned pricing |
| FR-7 | Lightweight CRM: buyer accounts, segments, shared lists, inquiry→quote→order workflow, activity timeline | Should | Order is a soft reservation, not payment capture |
| FR-8 | Diamond Passport: append-only hash-chained provenance events; export verifiable PDF/JSON | Must | Chain integrity is internal and tamper-evident even without anchoring |
| FR-9 | Optional Polygon anchor of the Passport chain root | Could | Anchor integrity only; no tokenization/trading; degrades gracefully when off |
| FR-10 | 3D viewer (React Three Fiber) + embeddable verify widget keyed by stone/cert id | Must | Widget is read-only public verification with branded CTA |
| FR-11 | Multi-tenancy, RBAC (admin/grader/sales/viewer/buyer), full audit log | Must | Foundational for trust + SOC 2 |
| FR-12 | Billing & metering via Stripe: per-seat + per-stone usage, self-serve management, usage dashboards; Grading/Provenance as metered APIs | Should | API keys + rate limits for standalone-API product |

## 7. Non-functional requirements

- **Performance:** CV grading returns in ~30s per stone (async job, progress shown); price forecast < 2s; catalog/CRM pages p95 < 500ms; 3D viewer interactive load < 3s on broadband.
- **Scalability:** stateless FastAPI + Next.js on AWS ECS/Fargate, autoscaling; grading jobs queued via Redis; TimescaleDB scales to 100k+ stones per tenant.
- **Security & privacy:** strict tenant isolation, RBAC, TLS in transit, KMS/S3 SSE at rest, secrets in a managed vault, full audit logging. DPDP (India) + GDPR-aligned handling for EU/UK/UAE buyer PII (consent, export, deletion). Data residency in ap-south-1. SOC 2 Type I readiness, 0 high/critical pen-test findings at GA.
- **Accessibility:** WCAG 2.1 AA across the web app and buyer-facing pages; 3D viewer needs a non-3D specs fallback for assistive tech and low-power devices.
- **Availability:** 99.5% monthly uptime target; durable S3 media with backups; daily Postgres backups with tested restore; graceful degradation if grading/anchor services are down (queue + retry).
- **Compatibility:** responsive on latest Chrome/Safari/Firefox/Edge and mobile browsers; WebGL required for 3D viewer with specs fallback otherwise; widget must work cross-origin via iframe/script on tenant sites.
- **Auditability/compliance:** every grading override, price change, price-book read, and provenance event is immutably logged. Passport exports align with Kimberley Process / EU & US due-diligence framing. Always disclose: grades are decision aids, not certificates; chain integrity does not equal proof of real-world origin.

---

## 8. Success metrics (from BRD objectives)

| Objective | Metric | Target |
|---|---|---|
| Accurate auto-grading | CV grading agreement with lab cert | ≥90% within ±1 grade, ≥70% exact match on 1,000-stone holdout |
| Accurate price forecasting | Price model MAPE vs. actual/RapNet-referenced prices | ≤8% on round brilliants, ≤12% on fancy shapes |
| Real revenue product | Paying tenants / MRR | ≥5 paying tenants, ≥USD 4,000 MRR within 6 months of GA |
| Lead generation for Centr8 | Qualified inbound leads attributable to LucidCarat | ≥30 qualified leads and ≥3 custom-build conversations per quarter, ongoing from GA+1 quarter |
| Export-grade provenance | Passports with complete, tamper-evident chain passing external compliance review | 100% of pilot-tenant stones carry a verifiable Passport; sample audit passes with 0 critical findings by end of Phase 3 |
| SOC 2-ready platform | Tenant isolation, audit-log coverage, SOC 2 Type I checklist | 100% of control checklist met, 0 high/critical pen-test findings at GA |

Gate the accuracy metrics (grading agreement, price MAPE) before promoting either feature publicly — do not ship marketing claims ahead of validated holdout results.

---

## 9. Phased build plan

| Phase | Outcome | Duration (indicative) |
|---|---|---|
| Phase 0 — Discovery & data foundation | Design-partner agreements with 2-3 Surat houses; video+cert data pipeline; ~1,000-stone labeled dataset started; architecture + threat model + Terraform skeleton on AWS | 3-4 weeks |
| Phase 1 — MVP: grading + pricing core | CV grading (color/cut first, clarity beta) + XGBoost pricing behind FastAPI; cert ingestion with human-override; internal single-tenant web app to upload/grade/price a stone; metering hooks | 5-7 weeks |
| Phase 2 — B2B catalog, CRM & Passport | Multi-tenant catalog with private price books; lightweight CRM; hash-chained Diamond Passport with optional Polygon anchor; RBAC + audit logging; BR-1/BR-2 accuracy targets frozen and validated on holdout | 6-8 weeks |
| Phase 3 — Buyer experience, billing & hardening | React Three Fiber 3D viewer; embeddable verify widget; Stripe per-seat+per-stone billing; standalone Grading/Provenance APIs; SOC 2 Type I readiness + pen test; analytics + lead attribution; marketing pages; GA with pilot tenants | 5-6 weeks |
| Phase 4 — Pilot, iterate & productize | Onboard 5+ paying tenants; tune models on real usage; white-label-to-labs path; publish flagship case study; track MRR + lead objectives | Ongoing, first 8-12 weeks post-GA |

**Follow the phase gates.** Do not start Phase 2 catalog/CRM work until Phase 1 grading + pricing models are behind FastAPI and functioning end-to-end internally. Do not start Phase 3 billing/hardening until Phase 2's accuracy targets (BR-1/BR-2) are frozen and validated on the holdout set. This matches the "fix/prove core before adding features" discipline used across other Centr8 projects.

---

## 10. Acceptance criteria (representative, see PRD §11 for full list)

- A stone with a valid 360° video + GIA/IGI cert is graded for Color/Clarity/Cut with per-dimension confidence and cert-disagreement flags within ~30s.
- On the 1,000-stone holdout: grading agreement ≥90% within ±1 grade and ≥70% exact; price MAPE ≤8% (rounds) / ≤12% (fancies); metrics reproducible from the eval harness.
- A stone cannot reach "published" until every grade is confirmed or overridden, with full audit trail (user, timestamp, old/new value).
- A buyer with a private price book sees only their pricing; a different buyer cannot see or infer it; all price-book reads are audit-logged.
- Every published stone has a Diamond Passport whose hash chain validates; tampering with any event breaks validation; Polygon anchoring (if enabled) verifies on-chain and degrades gracefully when disabled.
- A buyer can open a stone in the 3D viewer (with non-3D specs fallback) and a third party can verify specs/cert/Passport via the embeddable widget on an external site.
- A tenant can be onboarded, seats managed, and billed via Stripe with per-stone usage metered and visible in a usage dashboard.
- Tenant isolation, RBAC, TLS + at-rest encryption, and audit logging verified; pen test 0 high/critical findings; SOC 2 Type I readiness checklist 100% complete at GA.
- DPDP/GDPR controls work: buyer PII exportable and deletable on request; grades/Passport carry required disclaimers.

---

## 11. Key analytics events (instrument from day one)

`stone_uploaded`, `cert_ingested`, `grading_completed`, `grading_overridden`, `price_forecast_generated`, `price_adjusted`, `stone_published`, `price_book_assigned`, `price_book_viewed`, `viewer_3d_opened`, `buyer_inquiry_submitted`, `order_reserved`, `stone_sold`, `passport_event_appended`, `widget_verify_viewed`, `lead_submitted` (source: `lucidcarat`), `tenant_subscription_active`, `per_stone_usage_metered`.

---

## 12. Dependencies & assumptions to track

- Labeled training data (360° video + matching GIA/IGI cert pairs) from pilot diamond houses — not yet secured; blocks Phase 0/1 model work.
- Historical sold-price / RapNet-referenced benchmark data — needed to train/validate the price model; licensing terms TBD.
- Certificate parsing access/format stability for GIA/IGI.
- AWS account + Terraform-provisioned infra in ap-south-1.
- Stripe account + cross-border (US/UK/UAE) tax/billing configuration.
- Optional Polygon RPC/wallet if anchoring is turned on.
- Compliance advisor engaged for Kimberley Process / EU & US due-diligence and DPDP/GDPR review.
- DiamondPrice IQ live as the top-of-funnel feeder — coordinate messaging/handoff between the two products.
- 2-3 design-partner diamond houses recruited before GA (risk R-6 mitigation — without them, LucidCarat risks staying a demo).

---

## 13. Known risks to design around

- CV grading may not reach a trustworthy bar, especially for Clarity (inclusions are hard to detect from video alone) — mitigate with conservative confidence, cert cross-check, mandatory human-override-before-publish, and staged rollout (color/cut first).
- Insufficient/low-quality transaction data could make the price model unreliable — blend with RapNet-referenced benchmarks, always show confidence bands, gate the MAPE metric before promoting the feature publicly.
- Tenants may distrust a cloud SaaS holding their pricing and buyer relationships — hard tenant isolation, full audit logs, SOC 2 readiness, and data export/deletion controls are not optional polish, they are trust prerequisites.
- Provenance/blockchain framing could be dismissed as gimmick or misread as a legal origin guarantee — lead messaging with the internal hash chain + audit trail value; treat Polygon as optional tamper-evidence only; always disclaim that integrity ≠ origin truth.
- Scope creep (marketplace, payments, melee grading, mobile apps) could blow the budget on this single large flagship — enforce the out-of-scope list in Section 2 strictly; keep grading/provenance as clean APIs so future extensions are additive, not rewrites.
- No paying tenants convert — recruit design partners early, price for low entry friction (per-stone metering), and use the verify widget + content to compound inbound leads; white-label-to-labs is a second revenue path if direct tenant sales lag.

---

## 14. Working conventions for this project

- Use FR-numbered and BR-numbered identifiers (as above) when referencing requirements in code comments, PR descriptions, and commit messages, consistent with other Centr8 projects.
- Do not skip phase gates — get sign-off/acceptance-criteria confirmation on a phase before starting the next.
- Keep Grading and Provenance functionality behind clean, documented API boundaries from the start (FR-7, BR-7) — they need to be sellable as standalone products later without a rewrite.
- Never let copy, UI labels, or exports imply LucidCarat grades are official GIA/IGI certificates.
- Any Polygon/blockchain feature work must remain strictly optional and fail gracefully when disabled — don't let it become a hard dependency of the Passport feature.
- This project uses AWS (ECS/Fargate, RDS/TimescaleDB, S3, Redis) via Terraform, not the Vercel/Neon/Upstash stack used on SiteScore/DiamondPrice IQ/ExportInvoice Pro — don't default to the lighter stack out of habit.
