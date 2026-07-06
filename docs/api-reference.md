# LucidCarat API Reference

**Version:** 1.0  
**Base URL:** `https://app.lucidcarat.com/api/v1`  
**Contact:** api@lucidcarat.com

---

## Overview

The LucidCarat API exposes the platform's two core modules — **Grading** and **Provenance** — as standalone, authenticated, metered endpoints. These APIs are designed for:

- **Certification labs** (GIA/IGI-type) integrating computer-vision pre-screening into their intake workflow
- **Diamond traders** automating provenance record-keeping across custody transfer steps
- **Compliance integrators** pulling verifiable Passport data for trade documentation and due-diligence submissions

All API endpoints live under `/api/v1/` and are versioned independently of the web application.

> **Disclaimer:** LucidCarat grades are computer-vision decision aids — not official GIA/IGI certificates. Passport chain integrity proves tamper-evidence of the digital record only; it does not constitute proof of real-world diamond origin or compliance with any regulatory framework.

---

## Authentication

All API endpoints require an API key passed as a Bearer token:

```
Authorization: Bearer lc_<key>
```

API keys are scoped to one or more capabilities (`grading`, `provenance`) and are rate-limited per minute. Generate keys via the LucidCarat dashboard under **Settings → API Keys**, or via the management API described below.

**Key format:** `lc_` followed by 40 hex characters (160 bits of entropy).

**Security:** Raw keys are shown once on creation and never stored. The platform stores only a SHA-256 hash of each key. Treat API keys as secrets — rotate them if exposed.

---

## Rate Limiting

Each key has a per-minute call limit (default: 60 req/min, configurable on creation). When the limit is reached, the API returns:

```http
HTTP 429 Too Many Requests
Retry-After: 60
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
```

```json
{
  "error": "Rate limit exceeded",
  "limit": 60,
  "window": "1 minute"
}
```

---

## Errors

All error responses follow the same shape:

```json
{
  "error": "Human-readable error message",
  "hint": "Optional: suggested fix"
}
```

| HTTP Status | Meaning |
|---|---|
| 400 | Bad request — missing or invalid parameters |
| 401 | Missing, invalid, or revoked API key |
| 403 | Key does not have the required scope |
| 404 | Resource not found in your account |
| 409 | Conflict — stone is in a state that prevents the operation |
| 429 | Rate limit exceeded |
| 502 | Upstream grading service error |

---

## Grading API

### Submit a Grading Job

Kicks off an async computer-vision grading job for a stone. The stone must already exist in your LucidCarat account with a video and certificate on file.

Grading analyses Color, Clarity (beta), and Cut from the 360° turntable video, cross-referenced against the submitted lab certificate.

```http
POST /api/v1/grading/jobs
Authorization: Bearer lc_<key>
Content-Type: application/json
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `stone_id` | UUID | Yes | The stone's LucidCarat ID |
| `shape` | string | No | Override shape if not yet on cert (e.g. `"round"`, `"oval"`) |
| `video_path` | string | No | Override video path (advanced; normally set at intake) |

**Example request:**

```bash
curl -X POST https://app.lucidcarat.com/api/v1/grading/jobs \
  -H "Authorization: Bearer lc_a1b2c3d4e5f6..." \
  -H "Content-Type: application/json" \
  -d '{ "stone_id": "f50a07cc-beec-47d9-8637-58df8a4994de" }'
```

**Response `202 Accepted`:**

```json
{
  "job_id": "job_abc123",
  "stone_id": "f50a07cc-beec-47d9-8637-58df8a4994de",
  "status": "queued",
  "estimated_seconds": 30,
  "poll_url": "/api/v1/grading/jobs/job_abc123"
}
```

---

### Poll Grading Job Status

Poll for job completion. Completed jobs include full grading results. Typical completion time is 20–40 seconds. We recommend polling every 5 seconds.

```http
GET /api/v1/grading/jobs/{job_id}
Authorization: Bearer lc_<key>
```

**Path parameter:**

| Parameter | Description |
|---|---|
| `job_id` | Job ID returned from POST /jobs |

**Response — in progress:**

```json
{
  "job_id": "job_abc123",
  "status": "running",
  "stone_id": "f50a07cc-beec-47d9-8637-58df8a4994de",
  "created_at": "2026-07-06T10:00:00Z",
  "updated_at": "2026-07-06T10:00:12Z"
}
```

Status values: `queued` → `running` → `completed` | `failed`

**Response — completed `200 OK`:**

```json
{
  "job_id": "job_abc123",
  "status": "completed",
  "stone_id": "f50a07cc-beec-47d9-8637-58df8a4994de",
  "completed_at": "2026-07-06T10:00:34Z",
  "result": {
    "color": {
      "grade": "E",
      "confidence": 0.91,
      "cert_disagreement": false
    },
    "clarity": {
      "grade": "VS1",
      "confidence": 0.74,
      "cert_disagreement": false,
      "note": "Clarity grading is in beta — confidence thresholds are conservative."
    },
    "cut": {
      "grade": "Excellent",
      "confidence": 0.96,
      "cert_disagreement": false
    }
  },
  "disclaimer": "LucidCarat grades are computer-vision decision aids — not official GIA/IGI certificates. Always cross-check against the submitted lab certificate before commercial use."
}
```

**Result fields:**

| Field | Description |
|---|---|
| `grade` | Predicted grade string |
| `confidence` | Model confidence 0.0–1.0 |
| `cert_disagreement` | `true` if the predicted grade disagrees with the submitted certificate value |

> **Billing note:** Each completed grading job is metered as one `api_grading_call` event against your Stripe subscription. Failed jobs are not metered.

---

## Provenance API

### Get Diamond Passport

Returns the full append-only hash chain for a stone, plus a live chain validation result. Use this to verify that no provenance events have been tampered with.

```http
GET /api/v1/provenance/{stone_id}
Authorization: Bearer lc_<key>
```

**Example request:**

```bash
curl https://app.lucidcarat.com/api/v1/provenance/f50a07cc-beec-47d9-8637-58df8a4994de \
  -H "Authorization: Bearer lc_a1b2c3d4e5f6..."
```

**Response `200 OK`:**

```json
{
  "stone_id": "f50a07cc-beec-47d9-8637-58df8a4994de",
  "internal_ref": "STN-20240101-001",
  "chain_validation": {
    "valid": true,
    "event_count": 4,
    "head_hash": "7f3a9c21b4e8d0...",
    "detail": "Chain of 4 events verified. Head hash: 7f3a9c21b4e8d0…"
  },
  "events": [
    {
      "seq": 1,
      "event_type": "stone_uploaded",
      "occurred_at": "2026-07-01T09:00:00Z",
      "location": null,
      "payload": { "uploaded_by": "grader@example.com" },
      "event_hash": "4a2f8b...",
      "prev_event_hash": "GENESIS"
    },
    {
      "seq": 2,
      "event_type": "grading_completed",
      "occurred_at": "2026-07-01T09:01:12Z",
      "location": null,
      "payload": { "color": "E", "clarity": "VS1", "cut": "Excellent" },
      "event_hash": "9c3e71...",
      "prev_event_hash": "4a2f8b..."
    }
  ],
  "disclaimer": "Chain integrity proves tamper-evidence of this digital record. It does not constitute proof of real-world origin or compliance with any regulatory framework."
}
```

> **Billing note:** Each GET request is metered as one `api_provenance_call` against your Stripe subscription.

---

### Append a Provenance Event

Appends a new tamper-evident event to the stone's Passport chain. Use this to record custody transfers, origin certifications, re-grading results, or export clearances.

```http
POST /api/v1/provenance/{stone_id}/events
Authorization: Bearer lc_<key>
Content-Type: application/json
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `event_type` | string | Yes | One of the allowed types (see below) |
| `payload` | object | No | Structured data for this event |
| `location` | string | No | Physical location associated with the event |

**Allowed `event_type` values:**

| Value | Typical use |
|---|---|
| `origin_certified` | Certification lab confirms origin documentation |
| `transfer_of_custody` | Stone changes hands between parties |
| `re_graded` | Stone is graded again by lab or independent party |
| `export_cleared` | Kimberley Process or customs clearance recorded |
| `import_cleared` | Destination country import clearance |
| `lab_verified` | Independent lab verification event |
| `retailer_received` | Buyer/retailer confirms receipt |
| `sold` | Stone sold to end consumer |
| `note` | Freeform note (use payload.text) |

**Example request:**

```bash
curl -X POST https://app.lucidcarat.com/api/v1/provenance/f50a07cc-beec-47d9-8637-58df8a4994de/events \
  -H "Authorization: Bearer lc_a1b2c3d4e5f6..." \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "transfer_of_custody",
    "payload": {
      "from_party": "Kiran Diamonds, Surat",
      "to_party": "Prestige Imports, New York",
      "invoice_ref": "KD-2026-1042"
    },
    "location": "Surat, India"
  }'
```

**Response `201 Created`:**

```json
{
  "id": "evt_uuid_here",
  "seq": 5,
  "event_type": "transfer_of_custody",
  "occurred_at": "2026-07-06T14:22:01Z",
  "event_hash": "b8d1f9...",
  "prev_event_hash": "7f3a9c..."
}
```

---

### Export Verifiable Passport JSON

Returns a self-contained, verifiable export document suitable for trade documentation, compliance submission, or archival. Recipients can independently re-verify chain integrity offline using the published SHA-256 hash algorithm described in the document.

```http
GET /api/v1/provenance/{stone_id}/export
Authorization: Bearer lc_<key>
```

**Response `200 OK`:**

```json
{
  "schema_version": "1.0",
  "exported_at": "2026-07-06T14:30:00Z",
  "stone": {
    "id": "f50a07cc-...",
    "internal_ref": "STN-20240101-001",
    "shape": "round",
    "carat_weight": "2.01",
    "color": "E",
    "clarity": "VS1",
    "cut": "Excellent",
    "lab_grown": false,
    "certificate": { "lab": "GIA", "cert_number": "1234567890" }
  },
  "issuer": {
    "name": "Kiran Diamonds",
    "platform": "LucidCarat",
    "platform_url": "https://lucidcarat.com"
  },
  "passport": {
    "chain_valid": true,
    "event_count": 5,
    "head_hash": "b8d1f9...",
    "events": [ ... ]
  },
  "hash_algorithm": {
    "name": "SHA-256",
    "canonical_form": "SHA256(prev_hash + NUL + stone_id + NUL + event_type + NUL + sorted_json(payload) + NUL + occurred_at_iso)",
    "verification_note": "Any party can independently verify the chain by recomputing each event_hash from the canonical form above."
  },
  "disclaimers": [
    "LucidCarat grades are computer-vision decision aids — not official GIA/IGI certificates.",
    "Passport chain integrity proves tamper-evidence of this digital record only.",
    "It does not constitute proof of real-world diamond origin or compliance with any regulatory framework."
  ]
}
```

---

## API Key Management

These endpoints are session-authenticated (web app login, admin role only) — not API-key-authenticated. Use them to manage keys for your team.

### Create an API Key

```http
POST /api/api-keys
Content-Type: application/json
```

**Request body:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | Yes | — | Human-readable label |
| `scopes` | string[] | No | `["grading","provenance"]` | Capability scopes to grant |
| `rate_limit_per_minute` | integer | No | `60` | Max calls per minute |

**Response `201 Created`:**

```json
{
  "id": "uuid",
  "name": "Lab Integration",
  "scopes": ["grading", "provenance"],
  "rate_limit_per_minute": 60,
  "key_prefix": "lc_a1b2c3d",
  "created_at": "2026-07-06T10:00:00Z",
  "secret_key": "lc_a1b2c3d4e5f6...",
  "warning": "Store this key securely — it will not be shown again."
}
```

> The `secret_key` is returned **once only**. It is not stored by LucidCarat. Copy it immediately.

### List API Keys

```http
GET /api/api-keys
```

Returns all keys (active and revoked) with prefix and metadata — never the raw key.

### Revoke an API Key

```http
DELETE /api/api-keys/{id}
```

Immediately invalidates the key. All subsequent API calls using this key return `401`.

---

## Chain Integrity Verification (Offline)

Anyone with the export document can verify the Passport chain without calling the API:

```python
import hashlib, json

GENESIS = "GENESIS"

def sorted_json(obj):
    if not isinstance(obj, dict):
        return json.dumps(obj)
    return json.dumps(dict(sorted(obj.items())))

def compute_event_hash(prev_hash, stone_id, event_type, payload, occurred_at):
    canonical = "\x00".join([prev_hash, stone_id, event_type, sorted_json(payload), occurred_at])
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

def verify_chain(stone_id, events):
    sorted_events = sorted(events, key=lambda e: e["seq"])
    for i, evt in enumerate(sorted_events):
        expected_prev = GENESIS if i == 0 else sorted_events[i-1]["event_hash"]
        if evt["prev_event_hash"] != expected_prev:
            return False, f"Chain break at seq {evt['seq']}"
        recomputed = compute_event_hash(
            evt["prev_event_hash"], stone_id, evt["event_type"],
            evt["payload"], evt["occurred_at"]
        )
        if recomputed != evt["event_hash"]:
            return False, f"Hash mismatch at seq {evt['seq']}"
    return True, "Chain verified"
```

---

## Changelog

| Version | Date | Notes |
|---|---|---|
| 1.0 | 2026-07-06 | Initial release — Grading and Provenance APIs |
