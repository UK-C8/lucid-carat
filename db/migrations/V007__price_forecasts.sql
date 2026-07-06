-- V007: Price forecasts — XGBoost model output per stone (FR-5).
-- Multiple rows per stone (re-forecast on grade update, model version bump).
-- is_current = TRUE marks the active forecast used for pricing.

CREATE TABLE price_forecasts (
    id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    stone_id        UUID    NOT NULL REFERENCES stones (id) ON DELETE CASCADE,
    tenant_id       UUID    NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

    model_version   TEXT    NOT NULL,

    -- ── Forecast output ───────────────────────────────────────────────────────
    fair_price_usd          NUMERIC(12, 2)  NOT NULL CHECK (fair_price_usd > 0),
    confidence_low_usd      NUMERIC(12, 2)  NOT NULL,
    confidence_high_usd     NUMERIC(12, 2)  NOT NULL,
    -- Confidence level the band represents (e.g. 0.90 = 90% CI)
    confidence_level        NUMERIC(4, 3)   NOT NULL DEFAULT 0.90,

    -- ── Top contributing features (ranked, for explainability FR-5) ──────────
    -- Array of {feature, direction, importance} objects, descending importance.
    top_drivers     JSONB   NOT NULL DEFAULT '[]',

    -- ── Manual adjustment ─────────────────────────────────────────────────────
    -- Sales staff can apply a markup/markdown % on top of the forecast.
    -- stones.list_price_usd = fair_price_usd * (1 + markup_pct / 100)
    markup_pct      NUMERIC(6, 2)   DEFAULT 0,  -- positive = markup, negative = markdown
    adjusted_by     UUID            REFERENCES users (id),
    adjusted_at     TIMESTAMPTZ,
    adjustment_note TEXT,

    -- Input snapshot used to produce this forecast (for reproducibility)
    input_snapshot  JSONB   NOT NULL DEFAULT '{}',

    is_current      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_forecast_current ON price_forecasts (stone_id)
    WHERE is_current = TRUE;

CREATE INDEX idx_forecast_stone   ON price_forecasts (stone_id);
CREATE INDEX idx_forecast_tenant  ON price_forecasts (tenant_id);

COMMENT ON TABLE price_forecasts IS
    'XGBoost price forecast per stone. Includes confidence band and ranked feature drivers.';
COMMENT ON COLUMN price_forecasts.top_drivers IS
    'Array of {feature, value, direction, importance_pct} — rendered as "why this price" UI.';
COMMENT ON COLUMN price_forecasts.markup_pct IS
    'Sales markup/markdown applied on top of fair_price_usd. Stored separately for model feedback.';
