# PHASE_PROMPTS.md — LucidCarat

Phase-by-phase prompts for pasting directly into Claude Code sessions. Each phase assumes CLAUDE.md is present in the repo root and has already been read. Do not start a phase until the previous phase's acceptance criteria are met and confirmed.

---

## Phase 0 — Discovery & data foundation

```
Read CLAUDE.md in full before doing anything else.

We are starting Phase 0 of LucidCarat: Discovery & data foundation.

Goal for this phase: set up the architecture skeleton, infra-as-code foundation, and data pipeline scaffolding needed before any grading or pricing model work begins. This phase does NOT include building the CV grading model, the price model, or any tenant-facing UI — those are Phase 1+.

Scope for this session:

1. Repository structure
   - Set up a monorepo layout with clear separation: `apps/web` (Next.js 14 App Router), `services/grading` (Python/FastAPI, PyTorch), `services/pricing` (Python/FastAPI, XGBoost), `infra` (Terraform), `packages/shared` (shared types/schemas if needed).
   - Add root-level README explaining the structure and pointing to CLAUDE.md for full context.

2. Infrastructure skeleton (Terraform, AWS ap-south-1 primary)
   - VPC, subnets, security groups sized for ECS/Fargate services.
   - ECS/Fargate cluster definitions (empty task definitions are fine for now — real images come later).
   - RDS Postgres instance with the TimescaleDB extension enabled.
   - Redis (ElastiCache) for queueing/cache/sessions.
   - S3 bucket(s) for video/cert/Passport-export storage, with per-tenant prefix convention documented.
   - Secrets manager setup for API keys/credentials — do not hardcode anything.
   - Keep this as a reviewable skeleton, not a fully wired production environment yet.

3. Data model foundation
   - Draft the core Postgres schema for: tenants, users/roles (admin/grader/sales/viewer/buyer per FR-11), stones (with the FR-1 status lifecycle: uploaded -> grading -> priced -> published -> sold/archived), certificates, grading_results, price_forecasts.
   - Draft the TimescaleDB hypertable schema for price/provenance time-series events.
   - Do NOT build the Diamond Passport hash-chain logic yet — that's Phase 2 (FR-8). Just leave a placeholder table/interface note in the schema doc.
   - Write this up as a schema design doc plus actual migration files (use whatever migration tool fits the stack — confirm with me before picking one if it's not obvious).

4. Data pipeline scaffolding for the labeled dataset
   - Build a simple internal tool/script for ingesting a 360-degree video + matching GIA/IGI certificate pair into S3 with correct tagging, for the ~1,000-stone labeled dataset we need to collect from pilot diamond houses.
   - This does not need a UI yet — a CLI or minimal internal script is fine.

5. Threat model
   - Write a lightweight threat model doc covering: tenant data isolation risks, PII handling for overseas buyers (DPDP/GDPR), video/cert storage security, and API surface risks for the future standalone Grading/Provenance APIs (BR-7).

Constraints to respect (see CLAUDE.md Section 2 for full list):
- Do not build any CV or pricing model logic this phase.
- Do not build tenant-facing UI this phase.
- Everything must be provisioned via Terraform — no manual console changes.

When done, summarize: what was built, what's stubbed/placeholder, and an explicit list of what Phase 1 will need from this foundation (schema tables, S3 conventions, service scaffolds).
```

**Phase 0 acceptance criteria before moving to Phase 1:**
- Terraform applies cleanly and provisions VPC, ECS/Fargate cluster, RDS Postgres+TimescaleDB, Redis, S3, and secrets manager.
- Core schema migrations run cleanly against a fresh Postgres instance.
- At least one test video+cert pair can be ingested through the data pipeline script and lands correctly in S3 with tenant-prefixed tagging.
- Threat model doc exists and has been reviewed.
- Design-partner data/agreement status confirmed with 2-3 Surat houses (this is a business dependency, not a code deliverable, but should not be skipped before Phase 1 model training begins).

---

## Phase 1 — MVP: grading + pricing core

```
Read CLAUDE.md in full. Confirm Phase 0's infra skeleton and schema are in place before proceeding.

We are starting Phase 1 of LucidCarat: MVP grading + pricing core.

Goal: an internal, single-tenant web app where a user can upload a stone (video + cert), get it auto-graded, and get a price forecast — end to end, with human override built in. No multi-tenant catalog, no CRM, no billing, no Passport yet.

Scope for this session:

1. Certificate ingestion (FR-2)
   - Build the FastAPI service (or module within services/grading) that parses GIA/IGI certificates (PDF or structured input) and extracts: cert number, carat, color, clarity, cut, measurements, fluorescence.
   - Implement cert-number lookup verification where available.
   - Flag low-confidence/ambiguous fields rather than guessing silently.
   - Carat must come from the cert/scale — never from CV estimation.

2. CV 4Cs grading (FR-3)
   - Build the PyTorch-based grading pipeline behind FastAPI in services/grading.
   - MVP priority order: Color and Cut first with real model training; Clarity as a beta pass with deliberately conservative confidence scoring (per BRD risk R-1 — clarity inclusions are hard to detect from video).
   - Input: 360-degree video frames. Output: per-dimension grade + confidence + cert-disagreement flag if CV and cert disagree.
   - This should run as an async job (target ~30s per stone) with a way to poll/check progress — do not make this a blocking synchronous call.
   - Set up the offline eval harness now so we can measure grading agreement against the labeled holdout set as data comes in.

3. Human-in-the-loop override (FR-4)
   - Build the override workflow: a grader can accept or override any predicted grade.
   - A stone cannot move to "priced" status until every graded dimension is confirmed or overridden.
   - Every override must log: user, timestamp, old value, new value. This log is permanent and feeds the override-rate metric (BR-9).

4. Price forecasting (FR-5)
   - Build the XGBoost pricing service in services/pricing, behind FastAPI.
   - Inputs: 4Cs, shape, fluorescence, measurements, market reference data.
   - Output: predicted fair wholesale price, confidence band, and ranked top price drivers (explainability via feature contributions — not a black box number).
   - Support per-shape models if the data supports it (per PRD notes).
   - Allow manual markup/markdown on top of the forecast.
   - Set up the same offline eval harness approach for MAPE tracking against holdout stones.

5. Internal single-tenant web app (apps/web)
   - Minimal Next.js UI: upload a stone (video + cert) -> see ingestion results -> see grading results with confidence/flags -> confirm or override each dimension -> see price forecast with confidence band and drivers -> apply markup -> mark as priced.
   - This is internal-only, single-tenant. No buyer-facing pages, no catalog, no auth complexity beyond basic login — multi-tenancy and RBAC come in Phase 2 (FR-11).
   - Wire up metering hooks now (just event logging is fine — actual Stripe billing is Phase 3) so usage data isn't lost.

6. Analytics
   - Instrument: stone_uploaded, cert_ingested, grading_completed, grading_overridden, price_forecast_generated, price_adjusted (see CLAUDE.md Section 11 for the full event list — only these six apply to Phase 1).

Constraints:
- Do not build multi-tenant catalog, CRM, Diamond Passport, 3D viewer, verify widget, or Stripe billing this phase — those are Phase 2/3.
- Do not present any grade as an official replacement for GIA/IGI certification anywhere in the UI copy.
- Keep the grading and pricing services cleanly separated behind their own API boundaries — this pays off when we expose them as standalone APIs in Phase 3 (BR-7).

When done, report: model performance on whatever holdout data exists so far (even if the dataset is still small), what's stubbed, and confirm the FR-1 status lifecycle (uploaded -> grading -> priced) is fully working end-to-end.
```

**Phase 1 acceptance criteria before moving to Phase 2:**
- A stone with a valid video + cert can be graded end-to-end within ~30s (async), with confidence and cert-disagreement flags shown.
- A stone cannot reach "priced" until every grade is confirmed or overridden, with full audit trail.
- Price forecast returns in under 2 seconds with confidence band and ranked drivers.
- Grading agreement and price MAPE are being measured against the holdout set (targets — ≥90% within ±1 grade / ≥70% exact for grading, ≤8%/≤12% MAPE for pricing — do not need to be hit yet, but the measurement pipeline must exist and produce real numbers).
- Grading and pricing services are behind clean, separately callable FastAPI boundaries.

---

## Phase 2 — B2B catalog, CRM & Passport

```
Read CLAUDE.md in full. Confirm Phase 1's grading + pricing core is working end-to-end, including working eval-harness metrics, before proceeding.

We are starting Phase 2 of LucidCarat: multi-tenant B2B catalog, CRM, and Diamond Passport.

Scope for this session:

1. Multi-tenancy, RBAC & audit (FR-11, BR-8)
   - Introduce real multi-tenancy: tenant isolation at the data layer, not just app-layer filtering — this is foundational for trust (BRD risk R-3) and SOC 2.
   - Implement roles: admin, grader, sales, viewer, buyer.
   - Build a full audit log covering grading actions, pricing changes, price-book reads, and (once built below) provenance edits. This log must be tamper-resistant and queryable.

2. B2B catalog with private price books (FR-6, BR-3)
   - Publish stones from "priced" to a tenant catalog.
   - Support scoping visibility and pricing per buyer or buyer group — a buyer must only ever see their assigned pricing, never another buyer's.
   - Implement stale-price protection (flag or block outdated price-book entries).
   - Every price-book read must be captured in the audit log.

3. Lightweight CRM (FR-7)
   - Buyer accounts, segments, shared lists.
   - Inquiry -> quote -> order workflow. An "order" here is a soft reservation, not a payment capture (Stripe billing is Phase 3, and full payments/escrow is permanently out of scope per CLAUDE.md Section 2).
   - Activity/negotiation timeline per buyer.

4. Diamond Passport (FR-8, BR-4)
   - Build the append-only, hash-chained provenance event log per stone: origin/rough source, manufacturer, grading result, ownership transfers, export events.
   - Each event's hash must incorporate the prior event's hash (tamper-evident chain).
   - Support exporting a verifiable PDF/JSON record of a stone's full Passport.
   - Do NOT build the Polygon anchoring yet unless the team explicitly wants it now — it's marked "Could" priority (FR-9) and should degrade gracefully whether present or not. Confirm before building it.
   - Every published stone should get a Passport grading event appended automatically at publish time (per the primary flow in the PRD).

5. Validate Phase 1 accuracy targets
   - This is the checkpoint where BR-1/BR-2 accuracy targets need to be frozen and validated on the full holdout set: grading agreement ≥90% within ±1 grade, ≥70% exact; price MAPE ≤8% (rounds)/≤12% (fancies).
   - If targets aren't met, flag this clearly rather than proceeding to present the numbers as ready — per the BRD, these metrics gate before public promotion of the features.

Constraints:
- Do not build the 3D viewer, verify widget, or Stripe billing this phase — Phase 3.
- Passport chain integrity logic must work correctly with or without any future blockchain anchor — do not couple its correctness to the optional Polygon feature.
- Tenant isolation must be real data-layer isolation, not just query filters that could be bypassed by a bug.

When done, report: tenant isolation test results, whether BR-1/BR-2 targets are met on the full holdout, and confirm the Passport hash chain correctly breaks validation when an event is tampered with (this should be explicitly tested).
```

**Phase 2 acceptance criteria before moving to Phase 3:**
- A buyer assigned a private price book sees only their pricing; a different buyer cannot see or infer it; all reads are audit-logged.
- Tenant isolation, RBAC, and audit logging are verified working — ideally with an explicit isolation test (attempt cross-tenant access and confirm it's blocked).
- Every published stone has a Diamond Passport whose hash chain validates, and tampering with any event demonstrably breaks validation.
- BR-1/BR-2 accuracy targets are validated on the full 1,000-stone holdout (or the gap to target is clearly reported if not yet met).

---

## Phase 3 — Buyer experience, billing & hardening

```
Read CLAUDE.md in full. Confirm Phase 2's multi-tenant catalog, CRM, and Passport are working, and that BR-1/BR-2 accuracy targets have been validated (or the gap is understood), before proceeding.

We are starting Phase 3 of LucidCarat: buyer experience, billing, and hardening toward GA.

Scope for this session:

1. 3D viewer (FR-10, BR-5)
   - Build the React Three Fiber viewer for buyer-facing stone pages: render the stone with specs, cert data, and Passport summary.
   - Provide a non-3D specs fallback for assistive tech, low-power devices, and non-WebGL browsers (accessibility requirement — WCAG 2.1 AA).
   - Target interactive load under 3 seconds on broadband.

2. Embeddable "Verify this diamond" widget (FR-10, BR-5)
   - Build an iframe/script embeddable widget keyed by stone/cert id, for tenants to embed on their own external site.
   - Read-only public verification: shows specs, cert match, Passport summary.
   - Must work cross-origin, include a branded CTA (tenant + Centr8), and fire widget_verify_viewed / lead_submitted analytics events.

3. Stripe billing & metering (FR-12, BR-6)
   - Per-seat subscriptions + per-stone usage metering (graded/priced/published events from Phase 1/2 should already be logged — wire them into Stripe usage records).
   - Self-serve plan management and a usage dashboard for tenants.
   - Handle cross-border billing/tax for US/UK/UAE tenants.

4. Standalone Grading & Provenance APIs (FR-12, BR-7)
   - Expose the grading and provenance functionality built in Phases 1-2 as authenticated, documented, standalone APIs with rate limits and per-call metering.
   - This is the foundation for the white-label-to-labs revenue path — keep the API contracts clean and stable.

5. Security & compliance hardening (BR-8, NFR Security section)
   - TLS in transit, KMS/S3 SSE at rest, secrets in managed vault — verify all of this is actually in place, not just planned.
   - DPDP (India) + GDPR-aligned data-subject tooling: buyer PII must be exportable and deletable on request.
   - Complete the SOC 2 Type I readiness checklist.
   - Commission/run a penetration test — target 0 high/critical findings before GA.

6. Analytics & lead attribution (BR-9)
   - Complete the remaining analytics events: stone_published, viewer_3d_opened, buyer_inquiry_submitted, order_reserved, stone_sold, passport_event_appended, widget_verify_viewed, lead_submitted, tenant_subscription_active, per_stone_usage_metered.
   - Wire lead attribution from the verify widget and marketing pages back to Centr8's lead tracking.

7. Marketing pages
   - Build the public marketing/landing pages for LucidCarat itself, consistent with Centr8's existing brand kit and marketing site.

Constraints:
- Do not launch GA marketing claims about grading accuracy or price accuracy unless BR-1/BR-2 targets are actually validated (check Phase 2 output).
- All copy (marketing pages, verify widget, exported Passport documents) must carry the required disclaimers: grades are decision aids not certificates, and Passport chain integrity does not equal proof of real-world origin.
- Do not proceed to GA until the pen test and SOC 2 readiness checklist are both complete.

When done, report: pen test results, SOC 2 checklist completion status, and confirm 2-3 pilot tenants are ready to go live.
```

**Phase 3 / GA acceptance criteria:**
- A buyer can open a stone in the 3D viewer (with non-3D fallback) and a third party can verify specs/cert/Passport via the embeddable widget on an external site.
- A tenant can be onboarded, seats managed, and billed via Stripe with per-stone usage metered and visible in a usage dashboard.
- Standalone Grading/Provenance APIs are authenticated, documented, rate-limited, and metered.
- Pen test shows 0 high/critical findings; SOC 2 Type I readiness checklist is 100% complete.
- DPDP/GDPR controls verified: buyer PII export and deletion work on request.
- 2-3 pilot tenants are live.

---

## Phase 4 — Pilot, iterate & productize

```
Read CLAUDE.md in full. Confirm GA has shipped with 2-3 pilot tenants live per Phase 3 acceptance criteria.

We are starting Phase 4 of LucidCarat: pilot scale-up and productization. This phase is ongoing (roughly 8-12 weeks post-GA) rather than a single build sprint — treat each session as iterating on a specific piece below based on real pilot usage and feedback.

Areas of work (tackle one at a time, confirm priority with me before starting):

1. Onboard additional paying tenants (target: 5+ total) — identify and remove friction in the onboarding flow based on pilot tenant feedback.
2. Tune the CV grading and pricing models using real production usage data and override logs collected from pilots — this is where the override-rate metric (FR-4) and holdout eval harness (Phase 1) get put to real use.
3. Build the white-label-to-labs path: package the standalone Grading/Provenance APIs (Phase 3) for a certification-lab customer rather than a diamond-house tenant — identify what's different about that customer's needs (auth model, branding, SLAs).
4. Track and report against the two business-facing success metrics: MRR (target ≥USD 4,000 within 6 months of GA) and qualified lead generation (target ≥30 qualified leads, ≥3 custom-build conversations per quarter from GA+1 quarter onward).
5. Publish the flagship case study once there's enough real usage/results to make it credible.

For each session in this phase, tell me which of the above you want to work on and I'll scope that specific piece rather than treating this as one big prompt.
```

---

## Notes for whoever runs these sessions

- Paste one phase's prompt block at a time into a fresh or continued Claude Code session, after confirming CLAUDE.md is present in the repo.
- Do not let a session jump ahead to a later phase's scope just because it seems easy to bundle in — the phase gates exist specifically to stop scope creep on this large flagship build (BRD risk R-5).
- If real-world constraints force a deviation from a phase's scope (e.g., pilot data isn't ready, so Phase 0/1 need to run longer), update this file and CLAUDE.md's dependencies section rather than silently drifting the plan.
