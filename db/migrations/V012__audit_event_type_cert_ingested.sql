-- Add cert_ingested and viewer_3d_opened to audit_event_type enum (FR-2, CLAUDE.md §11).
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in Postgres, so each
-- statement runs standalone here (Flyway executes DDL outside an explicit txn by default).

ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'cert_ingested';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'viewer_3d_opened';
