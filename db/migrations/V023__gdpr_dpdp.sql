-- V023: DPDP (India) + GDPR data-subject tooling (FR-11, BR-8).
--
-- Adds:
--   users.anonymised_at    — set when a data-subject erasure request is fulfilled.
--                            Retaining the row with NULLed PII preserves referential
--                            integrity for audit_log / inquiry_events.
--   users.deletion_requested_at — when the request was received (for SLA tracking).
--   audit_event_type values for erasure lifecycle.
--
-- Erasure strategy (pseudonymisation, not hard-delete):
--   email        → 'deleted-<id>@lucidcarat.invalid'
--   full_name    → 'Deleted User'
--   password_hash → NULL
--   metadata     → '{}'
--   last_login_at → NULL
--   Row is retained so foreign keys in audit_log / inquiries remain intact.
--   The anonymised_at column is the proof of erasure for compliance audits.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS anonymised_at          TIMESTAMPTZ;

ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'data_export_requested';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'data_export_completed';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'data_erasure_requested';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'data_erasure_completed';

COMMENT ON COLUMN users.deletion_requested_at IS
  'DPDP/GDPR: timestamp when a data-subject deletion request was received.';
COMMENT ON COLUMN users.anonymised_at IS
  'DPDP/GDPR: timestamp when PII was pseudonymised. NULL = not yet erased.';
