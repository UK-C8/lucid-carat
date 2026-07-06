# LucidCarat — Threat Model

**Version:** Phase 0 / Steps 1–4  
**Date:** 2026-07-04  
**Author:** Centr8 Engineering  
**Scope:** What has actually been built — monorepo scaffold (Step 1), Terraform infra skeleton (Step 2), Postgres schema (Step 3), dataset ingestion CLI (Step 4). Future-phase features are flagged only where design decisions made now will be hard to undo.

This is a living document. Update it before each phase gate.

---

## 1. Tenant data isolation

### What we built

- Every table in the schema carries a `tenant_id UUID NOT NULL FK → tenants.id`.
- S3 object keys follow `tenants/<tenant_id>/<stone_id>/…` enforced by the ingestion CLI.
- The ECS task IAM role grants S3 access to the whole bucket; tenant scoping inside S3 is application-layer only (presigned URL generation scoped to `tenant_id`).
- RDS is a single multi-tenant database (shared schema, no per-tenant schemas or row-level security yet).

### Threat: cross-tenant data leakage via missing WHERE clause

**Likelihood:** Medium (common class of multi-tenant bug).  
**Impact:** Critical — a diamond house can see another house's stones, price books, or buyer relationships. This is an existential trust issue per Risk R-3 in CLAUDE.md.

**Where isolation is currently enforced:**  
Application layer only. Every query must include `WHERE tenant_id = $current_tenant`. There is no database-enforced backstop yet.

**Where it is NOT enforced:**  
- No Postgres Row-Level Security (RLS) policies on any table.  
- No per-tenant database schema or user.  
- The ECS task IAM policy allows the task to read/write any object under `tenants/*` in the S3 bucket — it is not restricted to `tenants/<own_tenant_id>/*`.

**Mitigations to design in now:**

1. **RLS before Phase 2 ships.** Add `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY` plus a policy of the form:
   ```sql
   CREATE POLICY tenant_isolation ON stones
     USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
   ```
   The application sets `SET LOCAL app.current_tenant_id = '<uuid>'` at the start of each request. This makes cross-tenant leakage impossible at the DB layer, not just at the application layer.

2. **S3 IAM condition before Phase 2 ships.** Restrict the ECS task IAM policy to only generate presigned URLs for its own tenant prefix:
   ```json
   "Condition": {
     "StringLike": { "s3:prefix": ["tenants/${aws:PrincipalTag/TenantId}/*"] }
   }
   ```
   This requires the task to assume a per-tenant IAM role or carry the tenant ID as a principal tag. Design this in Phase 1 before the catalog is multi-tenant.

3. **Integration test.** Before Phase 2 ships, write a test that logs in as tenant A and asserts it cannot fetch any resource belonging to tenant B — at both the API layer and directly against the DB.

### Threat: stone ID enumeration / IDOR

**Likelihood:** Medium.  
**Impact:** High — a buyer who knows another tenant's stone UUID could attempt to fetch it.

**Mitigation:** UUIDs (v4) are used throughout — 122 bits of entropy, not enumerable. Presigned S3 URLs must be time-limited (≤ 1 hour for video, ≤ 15 minutes for cert PDFs). These are not yet implemented; flag for Phase 1.

---

## 2. PII handling — DPDP (India) and GDPR (EU/UK/UAE)

### What we built

- `users` table stores `email`, `full_name`, `password_hash`, `consent_given_at`, `data_region`.
- `audit_log` stores `ip_address`, `user_agent` per event — both are personal data under GDPR/DPDP.
- `provenance_events.payload` is JSONB — can contain arbitrary data including buyer PII if a future feature embeds it.
- Primary data residency: `ap-south-1` (Mumbai) — correct for DPDP; acceptable for GDPR with appropriate SCCs/transfer mechanisms for EU/UK/UAE buyers.

### Who is a data subject?

| Person | Data held | Applicable law |
|---|---|---|
| Diamond house staff (India) | email, name, login history, IP in audit_log | DPDP (India) |
| Overseas B2B buyers (EU/UK) | email, name, inquiry content, IP in audit_log | GDPR / UK GDPR |
| Overseas B2B buyers (UAE) | email, name, inquiry content | PDPL (UAE) — similar to GDPR in practice |

### Threat: consent not captured before processing buyer PII

**Likelihood:** High if not designed now.  
**Impact:** Regulatory — GDPR Art. 6/7 and DPDP S.6 require a lawful basis before processing. For buyers, legitimate interest (inquiry processing) is defensible for core CRM data, but marketing communication requires explicit consent.

**Current state:** `users.consent_given_at` column exists but the application does not yet populate it or block PII processing if NULL.

**Required before Phase 2 (CRM ships):**
- The buyer signup / inquiry flow must collect and timestamp consent.
- A `consent_purposes` column or separate `consents` table should record what the user consented to (inquiry processing vs. marketing), since these are separable.
- The application must refuse to send marketing emails if `consent_given_at IS NULL`.

### Threat: audit_log retains PII (IP, user agent) indefinitely

**Likelihood:** Certain — the current schema has no retention policy on `audit_log`.  
**Impact:** Medium — GDPR Art. 5(1)(e) requires storage limitation; retaining IPs for longer than needed for security/fraud purposes is a compliance risk.

**Required:**
- Add a data-retention schedule. Recommendation: anonymise `ip_address` and `user_agent` in `audit_log` after 90 days (replace with a hash or NULL) while keeping the event record for compliance. Implement as a scheduled job.
- Document this in a Privacy Notice served to buyers.

### Threat: PII embedded in JSONB payload columns

**Likelihood:** Medium — `provenance_events.payload`, `audit_log.payload`, and `stones.metadata` are freeform JSONB. Future features may embed buyer names, addresses, or deal terms there without flagging them as PII fields.

**Required:**
- Establish a coding convention: structured PII (name, email, address) goes in typed columns only, never embedded in JSONB blobs. JSONB is for operational metadata (S3 keys, model versions, feature flags).
- Before Phase 2 ships CRM/inquiry: audit all JSONB write paths for PII.

### Data subject rights (erasure and export)

**Current state:** No mechanism exists. `users` rows can be deleted (CASCADE will propagate to scoped data), but `audit_log` and `provenance_events` are append-only and must not be deleted for compliance/integrity reasons.

**Required before GA:**
- **Erasure:** Replace personal identifiers (`email`, `full_name`, `ip_address`) in `users` and `audit_log` with anonymised values (`[REDACTED]`), keeping the structural record. Implement as a `DELETE /users/:id` endpoint that triggers anonymisation, not an actual row delete.
- **Export:** Implement a DSAR (Data Subject Access Request) export that serialises all non-anonymised rows attributable to a user into JSON. Must complete within 30 days (GDPR) / 30 days (DPDP).
- Both operations must themselves be audit-logged.

### International data transfer (EU/UK buyers → ap-south-1)

India is not an EU-adequate country. Transferring EU buyer PII to `ap-south-1` requires a lawful transfer mechanism (Standard Contractual Clauses) or the buyer's explicit consent. UK buyers require UK IDTA or addendum SCCs post-Brexit.

**Required before any EU/UK buyer onboards:**
- Execute SCCs with each EU/UK buyer entity as data controller.
- Document the transfer mechanism in the Privacy Notice.
- Add a `transfer_mechanism` field to the tenant or user record for audit purposes.

---

## 3. Video and certificate storage security (S3)

### What we built (Step 2 Terraform — `infra/modules/storage/main.tf`)

- Public access fully blocked (`block_public_acls = true`, `restrict_public_buckets = true`).
- Server-side encryption: `aws:kms` with the KMS key from `infra/modules/secrets/main.tf` (30-day deletion window, auto-rotation enabled).
- S3 access logging to a separate `*-access-logs` bucket with 90-day expiry.
- Versioning enabled — accidental or malicious overwrites are recoverable.
- Lifecycle: STANDARD_IA after 90 days, GLACIER after 365 days.
- CORS configured for presigned-URL direct browser uploads (PUT/POST only from allowed origins).

### Threat: presigned URL leakage — video or cert accessible without authentication

**Likelihood:** Medium.  
**Impact:** High — a GIA cert is a sensitive business document; a leaked presigned URL lets anyone download it.

**Current state:** The ingestion CLI writes S3 keys to the DB but the application layer (not yet built) will generate presigned URLs. No expiry policy has been specified in code yet.

**Required for Phase 1:**
- Presigned GET URLs: **15 minutes** maximum for cert PDFs, **1 hour** for video streams.
- Never return presigned URLs in API responses that are cached (no `Cache-Control: public` on these endpoints).
- Log presigned URL generation in `audit_log` as a `price_book_viewed`-equivalent event so there is a trail of who fetched what and when.
- Consider using CloudFront signed URLs with a short-lived key pair instead of S3 presigned URLs for the 3D viewer (Phase 3) — CloudFront gives you invalidation and WAF integration.

### Threat: tenant A uploads a file that overwrites tenant B's S3 object

**Likelihood:** Low (UUIDs make key collision statistically impossible), but the IAM policy makes it theoretically possible.

**Mitigation:** The per-tenant prefix IAM condition (flagged in Section 1) also closes this. Until that's implemented, the UUID-based key structure is sufficient.

### Threat: unencrypted cert data in transit between ECS and S3

**Current state:** AWS SDK always uses HTTPS for S3 operations. The Terraform bucket does not enforce an `aws:SecureTransport` bucket policy.

**Required:**
```json
{
  "Effect": "Deny",
  "Principal": "*",
  "Action": "s3:*",
  "Resource": ["arn:aws:s3:::lucidcarat-*", "arn:aws:s3:::lucidcarat-*/*"],
  "Condition": { "Bool": { "aws:SecureTransport": "false" } }
}
```
Add this to `infra/modules/storage/main.tf` as `aws_s3_bucket_policy`. Small change, important defence-in-depth.

### Threat: cert PDF contains PII and is stored without access controls beyond S3

GIA/IGI certs identify the stone owner at time of certification. In some cert formats, the original customer name is printed on the cert. This makes the cert file personal data for that customer.

**Required:**
- In the cert ingestion service (Phase 1), check whether the parsed cert contains a customer name field. If so, redact it from the stored copy before uploading to S3.
- Add `contains_pii: boolean` to the `certificates` table (or `certificates.metadata`) to flag this for future DSAR handling.

---

## 4. API surface risks for the standalone Grading/Provenance APIs (BR-7)

These APIs don't exist yet, but decisions made in Phase 1 on the internal API design will be hard to reverse when they are exposed externally in Phase 3.

### Threat: no API key isolation between tenants

**Current risk:** The grading and pricing FastAPI services (`services/grading/main.py`, `services/pricing/main.py`) have a health endpoint and nothing else. When real endpoints are added in Phase 1, they will initially be internal-only (ECS service-to-service). If no authentication layer is designed in from the start, Phase 3 will require a retrofit that touches every endpoint.

**Required from Phase 1, first real endpoint:**
- Every request to the grading and pricing services must carry a JWT issued by the Next.js web layer (for internal calls) or an API key (for future external calls). The `internal/jwt-secret` in Secrets Manager is already provisioned for this.
- Validate `tenant_id` from the JWT on every handler — never accept `tenant_id` as a user-supplied query parameter.
- Design the API key model now: `api_keys` table with `tenant_id`, `key_hash` (bcrypt), `scopes` (e.g., `grading:read`, `provenance:write`), `rate_limit_rpm`, `last_used_at`. Add this as a migration before Phase 1 ships any endpoint. Retrofitting scopes after external customers have keys is painful.

### Threat: grading endpoint accepts arbitrary video URLs (SSRF)

**Likelihood:** High if not designed carefully.  
**Impact:** High — an attacker provides a URL pointing to an internal AWS metadata endpoint (`http://169.254.169.254/…`) or an internal service, and the grading worker fetches it.

**Required:**
- The grading service must only accept S3 object keys (not arbitrary URLs). The worker fetches the video directly from S3 using the task IAM role. Never accept a caller-supplied URL and fetch it server-side.
- If a download URL must be accepted (e.g., for lab-submitted certs), validate against an allowlist of domains (GIA's cert portal, IGI's cert portal) and use a separate network-isolated Lambda or ECS task for the fetch.

### Threat: grading results returned before human confirmation — misleading buyers

This is not a traditional security threat but a product integrity / trust threat specific to LucidCarat.

**Required (from CLAUDE.md hard boundaries):** The API must never expose raw CV grading output as a "grade" to an external caller. It must expose only `confirmed` grades (i.e., where `grading_results.is_current = TRUE` and `stones.confirmed_at IS NOT NULL`). The internal status `grading` must never map to a grade visible via the external API.

Add this to the API contract in Phase 1 and enforce it with a DB check, not just application logic.

### Threat: provenance chain integrity depends on API write ordering

When the Passport hash chain is implemented (Phase 2, FR-8), the chain integrity depends on events being appended in strict `occurred_at` order with no gaps. If two API calls write concurrently, or a retry inserts an event out of order, the chain is silently broken.

**Required design decision now (before Phase 1 touches provenance_events):**
- All `provenance_events` writes for a given `stone_id` must go through a single serialised path (a queue job, not a direct API call).
- Add a `SELECT ... FOR UPDATE` or advisory lock on the stone row before appending a provenance event. This is cheap and prevents the ordering problem.
- When hash-chain fields are added in Phase 2, the chain recomputation must be a migration that runs in a single transaction with a lock.

### Threat: rate limiting absent on metered endpoints

The Phase 3 plan includes per-stone billing (`per_stone_usage_metered`). Without rate limiting at the API layer, a compromised API key can generate unbounded usage charges against the tenant.

**Required before Phase 3 ships external API keys:**
- Rate limiting at the ALB/CloudFront layer (WAF rules) and at the application layer (per `api_key_id`, not just per IP).
- Hard `max_stones_per_day` limit checked before kicking off a grading job — enforced in code, not just a billing cap.
- The `api_keys` table scopes flagged above should include `rate_limit_rpm` as a first-class field so limits are per-key, not global.

---

## 5. Phase 1 build implications — what changes now

The following items should be built into Phase 1 before the first internal endpoint ships. They are not Phase 2 or Phase 3 polish — leaving them out creates architectural debt that is expensive to fix:

| # | Action | Why it can't wait |
|---|---|---|
| 1 | **RLS policies on all tables** (tenant isolation at DB layer) | Every Phase 1 endpoint that queries the DB is vulnerable to a missing-WHERE bug without this backstop. |
| 2 | **JWT validation on every FastAPI handler from the first endpoint** | The grading service will have real endpoints in Phase 1. Auth retrofits break API contracts. |
| 3 | **`api_keys` table with scopes column** | Schema must exist before any key is issued; retroactively adding scopes requires key rotation. |
| 4 | **Presigned URL expiry policy (15 min cert, 60 min video)** | Phase 1 will build the cert ingestion UI, which will need to return download URLs. Expiry must be set at first use. |
| 5 | **`aws:SecureTransport` S3 bucket policy** | One-line Terraform change. No reason to defer. |
| 6 | **No arbitrary URL acceptance in grading service** | The grading worker is being built in Phase 1. SSRF must be excluded from the design, not patched in later. |
| 7 | **Advisory lock on `provenance_events` writes** | The ingestion CLI already writes provenance events. Concurrent ingestion jobs (realistic at Phase 1 scale) can cause ordering issues without this. |
| 8 | **`consent_given_at` enforced, not just present** | The buyer-facing pages ship in Phase 3, but the user model is built in Phase 1. If consent is nullable-but-never-checked now, it stays that way. |

Items that can wait for Phase 2 or 3 (but are documented here so they don't get lost):
- Full DSAR export / anonymisation endpoint (needed before GA, not before Phase 2)
- SCCs with EU/UK buyer entities (needed before first EU/UK buyer onboards)
- Per-tenant S3 IAM condition (needed before Phase 2 catalog ships)
- CloudFront signed URLs replacing S3 presigned URLs for 3D viewer (Phase 3)
- `contains_pii` flag on certificates (Phase 1 cert parser, but low priority until DSAR is required)

---

## Appendix A — Assets and their classification

| Asset | Classification | Where stored | Encrypted at rest |
|---|---|---|---|
| 360° turntable video | Confidential (business) | S3, `tenants/<id>/<stone_id>/video/` | Yes (KMS) |
| GIA/IGI certificate PDF | Confidential (business + potential PII) | S3, `tenants/<id>/<stone_id>/cert/` | Yes (KMS) |
| Diamond Passport export | Confidential (business) | S3, `tenants/<id>/<stone_id>/passport/` | Yes (KMS) |
| Grading results (raw ML output) | Confidential (business) | RDS `grading_results.raw_output` | Yes (RDS KMS) |
| Price forecasts | Confidential (business) | RDS `price_forecasts` | Yes (RDS KMS) |
| Private price books | Highly Confidential | RDS (Phase 2 table, not yet built) | Yes (RDS KMS) |
| Buyer PII (email, name) | Personal Data (GDPR/DPDP) | RDS `users` | Yes (RDS KMS) |
| Buyer IP / user agent | Personal Data (GDPR/DPDP) | RDS `audit_log` | Yes (RDS KMS) |
| API keys | Secret | RDS `api_keys` (not yet built), hash only | Yes (RDS KMS); raw key shown once at issue |
| Stripe keys, JWT secret | Secret | AWS Secrets Manager | Yes (Secrets Manager KMS) |
| RDS master password | Secret | AWS Secrets Manager | Yes (Secrets Manager KMS) |

## Appendix B — Trust boundary diagram (text)

```
Internet
  │
  ▼
[CloudFront / ALB]  ← WAF rules (Phase 3)
  │  HTTPS only
  ▼
[ECS: Next.js web]  ── JWT issued here ──▶ [ECS: FastAPI grading]
  │                                                │
  │  SQL (tenant_id scoped)                       │  SQL (tenant_id scoped)
  ▼                                               ▼
[RDS Postgres — private subnet]         [S3 — via IAM task role]
  │
  ▼
[ElastiCache Redis — private subnet]

External API callers (Phase 3):
  Internet → [ALB] → [ECS: FastAPI grading/provenance] ← API key auth
```

All data stores are in private subnets with no public ingress. The only public entry points are the ALB (HTTPS) and S3 presigned URLs (time-limited, per-object).
