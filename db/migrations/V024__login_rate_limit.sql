-- V024: Login rate-limiting and lockout table.
--
-- Tracks failed login attempts per (email, ip) to enforce:
--   - Max 5 failures within a rolling 15-minute window per email
--   - Max 5 failures within a rolling 15-minute window per IP
-- After the limit is hit, further attempts are rejected with 429 until the
-- window expires (15 minutes from the FIRST failure in the window, not the last).
-- Successful login does NOT clear the window — the window just expires naturally.
-- This prevents an attacker from resetting their window by occasionally succeeding.
--
-- Rows older than 1 hour are safe to prune (cron or periodic cleanup).

CREATE TABLE IF NOT EXISTS login_attempts (
    id          BIGSERIAL   PRIMARY KEY,
    email       TEXT        NOT NULL,
    ip          TEXT        NOT NULL,
    succeeded   BOOLEAN     NOT NULL DEFAULT FALSE,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_login_attempts_email ON login_attempts (email, occurred_at DESC);
CREATE INDEX idx_login_attempts_ip    ON login_attempts (ip,    occurred_at DESC);

-- Add login_lockout event type to audit log if not already present.
ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS 'login_lockout';
