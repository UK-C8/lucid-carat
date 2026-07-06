-- V011: Relax certificates.carat_weight to nullable at ingestion time.
-- The cert parser fills this in after the cert PDF/JSON is processed.
-- The NOT NULL + CHECK(> 0) constraint is enforced at the application layer
-- before a stone can move from 'uploaded' to 'grading'.

ALTER TABLE certificates
    ALTER COLUMN carat_weight DROP NOT NULL,
    ALTER COLUMN carat_weight DROP DEFAULT;

-- Keep the check: when a value IS provided, it must be positive.
-- The existing CHECK(carat_weight > 0) already handles NULLs correctly
-- (a NULL check evaluates to NULL, not FALSE) so no DDL change needed there.

COMMENT ON COLUMN certificates.carat_weight IS
    'From lab cert (FR-2). NULL until cert parsing completes. Populated by cert ingestion service before stone moves to grading.';
