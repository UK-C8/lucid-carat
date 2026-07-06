-- V010: updated_at auto-maintenance trigger applied to all mutable tables.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_stones_updated_at
    BEFORE UPDATE ON stones
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_certificates_updated_at
    BEFORE UPDATE ON certificates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
