-- FR-12, BR-7: Extend provenance_event_type enum with API-facing event types.
-- These are the values external callers can write via POST /api/v1/provenance/{id}/events.
-- ALTER TYPE ... ADD VALUE does not require a table lock.

ALTER TYPE provenance_event_type ADD VALUE IF NOT EXISTS 'origin_certified';
ALTER TYPE provenance_event_type ADD VALUE IF NOT EXISTS 'transfer_of_custody';
ALTER TYPE provenance_event_type ADD VALUE IF NOT EXISTS 're_graded';
ALTER TYPE provenance_event_type ADD VALUE IF NOT EXISTS 'export_cleared';
ALTER TYPE provenance_event_type ADD VALUE IF NOT EXISTS 'import_cleared';
ALTER TYPE provenance_event_type ADD VALUE IF NOT EXISTS 'lab_verified';
ALTER TYPE provenance_event_type ADD VALUE IF NOT EXISTS 'retailer_received';
ALTER TYPE provenance_event_type ADD VALUE IF NOT EXISTS 'sold';
ALTER TYPE provenance_event_type ADD VALUE IF NOT EXISTS 'note';
