-- V001: Enable required Postgres extensions.
-- uuid-ossp and pgcrypto always available on Postgres 15/16.
-- timescaledb: on AWS RDS it must be in shared_preload_libraries (done via the
-- Terraform parameter group in infra/modules/data/main.tf) before this CREATE
-- EXTENSION succeeds. On local dev without TimescaleDB installed, the
-- hypertable conversions in V009 are skipped via the DO block guard there.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create timescaledb only if available; local dev without the extension
-- still gets all tables, just without time-partitioning.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'
    ) THEN
        CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
    ELSE
        RAISE NOTICE 'timescaledb extension not available — price_history and provenance_events will be plain tables. Install TimescaleDB for local dev or use the AWS RDS environment.';
    END IF;
END;
$$;
