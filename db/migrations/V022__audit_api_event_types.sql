-- FR-12, BR-7: Extend audit_event_type enum with standalone API analytics events.
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'api_grading_submitted';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'api_grading_metered';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'api_provenance_read';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'api_key_created';
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'api_key_revoked';
