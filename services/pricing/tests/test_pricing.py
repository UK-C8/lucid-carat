"""
Tests for the XGBoost pricing service (FR-5, Step 4).

Coverage:
  TestFeatureEngineering  — build_features, ordinal maps, measurements parsing, NaN handling
  TestHeuristicModel      — fallback price logic, band ordering, driver structure
  TestXGBoostModel        — train-save-load round trip, SHAP drivers, quantile ordering
  TestWriterForecast      — write_forecast persists row, retires previous, emits analytics
  TestWriterAdjustment    — apply_adjustment preserves fair_price, computes adjusted correctly
  TestMarkupPreservation  — fair_price_usd never mutated after markup/markdown
  TestResponseTime        — heuristic predict <2s; XGBoost predict <<2s
  TestAnalyticsEvents     — price_forecast_generated and price_adjusted in audit_log
  TestDBConstraints       — is_current uniqueness per stone
"""
from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from decimal import Decimal
from pathlib import Path

import numpy as np
import psycopg
import psycopg.rows
import pytest

# ── Path setup ────────────────────────────────────────────────────────────────
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pricing.features import (
    build_features, FEATURE_NAMES,
    COLOR_ORDINAL, CLARITY_ORDINAL, CUT_ORDINAL, FLUORESCENCE_ORDINAL,
)
from pricing.model import PricingModel, PriceForecast, train_and_save, _heuristic_price
from pricing.writer import write_forecast, apply_adjustment

DB_URL = os.environ.get("LC_DATABASE_URL",
                        "postgresql://urvilkargathala@localhost/lucidcarat_dev")


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def conn():
    c = psycopg.connect(DB_URL, row_factory=psycopg.rows.dict_row)
    yield c
    c.rollback()
    c.close()


def _seed(conn) -> dict:
    """Create a tenant + user + stone in 'priced' status, return ids."""
    tid = str(uuid.uuid4())
    uid = str(uuid.uuid4())
    sid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO tenants (id, name, slug, plan) VALUES (%s, %s, %s, 'starter')",
        (tid, f"pricing-tenant-{tid[:8]}", f"pt-{tid[:8]}"),
    )
    conn.execute(
        "INSERT INTO users (id, tenant_id, email, full_name, role) "
        "VALUES (%s, %s, %s, 'Pricing Tester', 'sales')",
        (uid, tid, f"ptest-{uid[:8]}@example.com"),
    )
    # Stone must be in 'priced' status — write_forecast doesn't change status
    conn.execute(
        """
        INSERT INTO stones
            (id, tenant_id, status, shape, carat_weight,
             confirmed_color, confirmed_clarity, confirmed_cut, confirmed_by, confirmed_at)
        VALUES (%s, %s, 'priced', 'round_brilliant', 1.01,
                'F', 'VS1', 'Excellent', %s, NOW())
        """,
        (sid, tid, uid),
    )
    return {"tenant_id": tid, "user_id": uid, "stone_id": sid}


def _sample_features():
    return build_features(
        carat_weight=1.01,
        color_grade="F",
        clarity_grade="VS1",
        cut_grade="Excellent",
        fluorescence="None",
        depth_pct=61.4,
        table_pct=57.0,
        measurements_mm="6.41 x 6.45 x 3.97",
        shape="round_brilliant",
    )


# ─────────────────────────────────────────────────────────────────────────────
# TestFeatureEngineering
# ─────────────────────────────────────────────────────────────────────────────

class TestFeatureEngineering:
    def test_vector_length(self):
        f = _sample_features()
        assert len(f.to_vector()) == len(FEATURE_NAMES)

    def test_color_ordinal_D_is_zero(self):
        f = build_features(carat_weight=1.0, color_grade="D", clarity_grade="FL",
                           cut_grade="Excellent")
        assert f.color_ordinal == 0

    def test_clarity_ordinal_FL_is_zero(self):
        f = build_features(carat_weight=1.0, color_grade="D", clarity_grade="FL",
                           cut_grade="Excellent")
        assert f.clarity_ordinal == 0

    def test_cut_ordinal_excellent_is_zero(self):
        f = build_features(carat_weight=1.0, color_grade="D", clarity_grade="FL",
                           cut_grade="Excellent")
        assert f.cut_ordinal == 0

    def test_cut_none_for_fancy_shape(self):
        f = build_features(carat_weight=1.0, color_grade="D", clarity_grade="FL",
                           cut_grade=None, shape="oval")
        assert f.cut_ordinal == -1

    def test_measurements_parsed(self):
        f = build_features(carat_weight=1.0, color_grade="D", clarity_grade="FL",
                           cut_grade="Excellent", measurements_mm="6.41 x 6.45 x 3.97")
        assert f.length_mm == pytest.approx(6.41)
        assert f.width_mm == pytest.approx(6.45)
        assert f.depth_mm == pytest.approx(3.97)

    def test_missing_measurements_are_nan(self):
        f = build_features(carat_weight=1.0, color_grade="D", clarity_grade="FL",
                           cut_grade="Excellent")
        assert np.isnan(f.length_mm)
        assert np.isnan(f.depth_pct)

    def test_unknown_grade_falls_back(self):
        f = build_features(carat_weight=1.0, color_grade="UNKNOWN", clarity_grade="UNKNOWN",
                           cut_grade="UNKNOWN")
        # Should not raise; uses median fallback
        assert 0 <= f.color_ordinal <= 22
        assert 0 <= f.clarity_ordinal <= 10

    def test_shape_one_hot_round(self):
        f = build_features(carat_weight=1.0, color_grade="G", clarity_grade="VS2",
                           cut_grade="Good", shape="round_brilliant")
        vec = f.to_vector()
        # shape_round_brilliant is index 10 in FEATURE_NAMES
        ri = FEATURE_NAMES.index("shape_round_brilliant")
        assert vec[ri] == 1.0
        # All other shape bits are 0
        shape_indices = [FEATURE_NAMES.index(n) for n in FEATURE_NAMES if n.startswith("shape_")]
        assert sum(vec[i] for i in shape_indices) == pytest.approx(1.0)

    def test_to_dict_serializable(self):
        f = _sample_features()
        d = f.to_dict()
        json.dumps(d)   # should not raise


# ─────────────────────────────────────────────────────────────────────────────
# TestHeuristicModel
# ─────────────────────────────────────────────────────────────────────────────

class TestHeuristicModel:
    def test_returns_price_forecast(self):
        f = _sample_features()
        fc = _heuristic_price(f)
        assert isinstance(fc, PriceForecast)

    def test_price_positive(self):
        f = _sample_features()
        fc = _heuristic_price(f)
        assert fc.fair_price_usd >= 100

    def test_band_ordered(self):
        f = _sample_features()
        fc = _heuristic_price(f)
        assert fc.confidence_low_usd < fc.fair_price_usd < fc.confidence_high_usd

    def test_confidence_level_090(self):
        f = _sample_features()
        fc = _heuristic_price(f)
        assert fc.confidence_level == pytest.approx(0.90)

    def test_wide_band_signals_uncertainty(self):
        f = _sample_features()
        fc = _heuristic_price(f)
        # Heuristic band must be ≥ ±35% of fair price
        spread_pct = (fc.confidence_high_usd - fc.confidence_low_usd) / fc.fair_price_usd
        assert spread_pct >= 0.7

    def test_top_drivers_present(self):
        f = _sample_features()
        fc = _heuristic_price(f)
        assert len(fc.top_drivers) >= 1
        for d in fc.top_drivers:
            assert "feature" in d and "direction" in d and "importance" in d

    def test_d_fl_excellent_more_expensive_than_z_i3_poor(self):
        top = build_features(carat_weight=1.0, color_grade="D", clarity_grade="FL",
                             cut_grade="Excellent")
        bot = build_features(carat_weight=1.0, color_grade="Z", clarity_grade="I3",
                             cut_grade="Poor")
        assert _heuristic_price(top).fair_price_usd > _heuristic_price(bot).fair_price_usd

    def test_larger_carat_more_expensive(self):
        small = build_features(carat_weight=0.5, color_grade="G", clarity_grade="VS2",
                               cut_grade="Excellent")
        large = build_features(carat_weight=2.0, color_grade="G", clarity_grade="VS2",
                               cut_grade="Excellent")
        assert _heuristic_price(large).fair_price_usd > _heuristic_price(small).fair_price_usd

    def test_model_via_pricing_model_class(self):
        model = PricingModel()   # no checkpoint → heuristic
        assert model._use_heuristic is True
        fc = model.predict(_sample_features())
        assert isinstance(fc, PriceForecast)


# ─────────────────────────────────────────────────────────────────────────────
# TestXGBoostModel
# ─────────────────────────────────────────────────────────────────────────────

class TestXGBoostModel:
    @pytest.fixture(scope="class")
    def trained_checkpoint(self, tmp_path_factory):
        """Train a tiny XGBoost model on synthetic data and return checkpoint path."""
        rng = np.random.default_rng(42)
        n = 200
        # Synthetic feature matrix matching FEATURE_NAMES dimensions
        X = rng.random((n, len(FEATURE_NAMES)))
        # Price is a simple linear function of first feature (carat proxy)
        y = 3000 * X[:, 0] ** 1.9 + rng.normal(0, 100, n)
        y = np.clip(y, 100, None)

        tmpdir = tmp_path_factory.mktemp("pricing")
        ckpt = str(tmpdir / "model.joblib")
        train_and_save(X, y, checkpoint_path=ckpt, model_version="test-1.0")
        return ckpt

    def test_checkpoint_loads(self, trained_checkpoint):
        model = PricingModel(checkpoint_path=trained_checkpoint)
        assert model._use_heuristic is False

    def test_predict_returns_forecast(self, trained_checkpoint):
        model = PricingModel(checkpoint_path=trained_checkpoint)
        fc = model.predict(_sample_features())
        assert isinstance(fc, PriceForecast)
        assert fc.fair_price_usd > 0

    def test_quantile_ordered(self, trained_checkpoint):
        model = PricingModel(checkpoint_path=trained_checkpoint)
        fc = model.predict(_sample_features())
        assert fc.confidence_low_usd < fc.fair_price_usd
        assert fc.fair_price_usd < fc.confidence_high_usd

    def test_model_version_stored(self, trained_checkpoint):
        model = PricingModel(checkpoint_path=trained_checkpoint, model_version="test-1.0")
        fc = model.predict(_sample_features())
        assert fc.model_version == "test-1.0"

    def test_shap_drivers_present(self, trained_checkpoint):
        model = PricingModel(checkpoint_path=trained_checkpoint)
        fc = model.predict(_sample_features())
        # SHAP should return up to 5 drivers
        assert len(fc.top_drivers) >= 1
        for d in fc.top_drivers:
            assert d["direction"] in ("up", "down")
            assert 0.0 <= d["importance"] <= 1.0

    def test_driver_importances_each_between_0_and_1(self, trained_checkpoint):
        model = PricingModel(checkpoint_path=trained_checkpoint)
        fc = model.predict(_sample_features())
        for d in fc.top_drivers:
            assert 0.0 <= d["importance"] <= 1.0
        # Top-5 of 21 features won't cover 100%, but should be a meaningful portion
        total = sum(d["importance"] for d in fc.top_drivers)
        assert total > 0.5

    def test_missing_checkpoint_falls_back(self):
        model = PricingModel(checkpoint_path="/nonexistent/path.joblib")
        assert model._use_heuristic is True


# ─────────────────────────────────────────────────────────────────────────────
# TestWriterForecast
# ─────────────────────────────────────────────────────────────────────────────

class TestWriterForecast:
    def setup_method(self):
        self.conn = psycopg.connect(DB_URL, row_factory=psycopg.rows.dict_row)
        self.ids = _seed(self.conn)

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def _forecast(self) -> PriceForecast:
        return PriceForecast(
            fair_price_usd=4_500.00,
            confidence_low_usd=3_800.00,
            confidence_high_usd=5_200.00,
            confidence_level=0.90,
            top_drivers=[{"feature": "carat_weight", "direction": "up",
                          "value": 1.01, "importance": 0.45}],
            model_version="test-heuristic",
        )

    def test_write_returns_id(self):
        fid = write_forecast(self.conn,
                             forecast=self._forecast(),
                             features=_sample_features(),
                             stone_id=self.ids["stone_id"],
                             tenant_id=self.ids["tenant_id"])
        assert isinstance(fid, str) and len(fid) > 0

    def test_row_persisted(self):
        write_forecast(self.conn,
                       forecast=self._forecast(),
                       features=_sample_features(),
                       stone_id=self.ids["stone_id"],
                       tenant_id=self.ids["tenant_id"])
        row = self.conn.execute(
            "SELECT fair_price_usd, is_current FROM price_forecasts WHERE stone_id = %s",
            (self.ids["stone_id"],)
        ).fetchone()
        assert row is not None
        assert float(row["fair_price_usd"]) == pytest.approx(4_500.00)
        assert row["is_current"] is True

    def test_previous_is_current_retired(self):
        write_forecast(self.conn, forecast=self._forecast(), features=_sample_features(),
                       stone_id=self.ids["stone_id"], tenant_id=self.ids["tenant_id"])
        write_forecast(self.conn, forecast=self._forecast(), features=_sample_features(),
                       stone_id=self.ids["stone_id"], tenant_id=self.ids["tenant_id"])
        rows = self.conn.execute(
            "SELECT is_current FROM price_forecasts WHERE stone_id = %s",
            (self.ids["stone_id"],)
        ).fetchall()
        assert sum(1 for r in rows if r["is_current"]) == 1

    def test_analytics_event_emitted(self):
        write_forecast(self.conn, forecast=self._forecast(), features=_sample_features(),
                       stone_id=self.ids["stone_id"], tenant_id=self.ids["tenant_id"])
        row = self.conn.execute(
            "SELECT payload FROM audit_log WHERE entity_id = %s AND event_type = 'price_forecast_generated'",
            (self.ids["stone_id"],)
        ).fetchone()
        assert row is not None
        payload = row["payload"]
        assert payload["fair_price_usd"] == pytest.approx(4_500.00)

    def test_input_snapshot_stored(self):
        write_forecast(self.conn, forecast=self._forecast(), features=_sample_features(),
                       stone_id=self.ids["stone_id"], tenant_id=self.ids["tenant_id"])
        row = self.conn.execute(
            "SELECT input_snapshot FROM price_forecasts WHERE stone_id = %s AND is_current = true",
            (self.ids["stone_id"],)
        ).fetchone()
        assert row is not None
        snap = row["input_snapshot"]
        assert "carat_weight" in snap
        assert snap["carat_weight"] == pytest.approx(1.01)


# ─────────────────────────────────────────────────────────────────────────────
# TestWriterAdjustment
# ─────────────────────────────────────────────────────────────────────────────

class TestWriterAdjustment:
    def setup_method(self):
        self.conn = psycopg.connect(DB_URL, row_factory=psycopg.rows.dict_row)
        self.ids = _seed(self.conn)
        # Seed a forecast first
        fc = PriceForecast(
            fair_price_usd=4_500.00,
            confidence_low_usd=3_800.00,
            confidence_high_usd=5_200.00,
            confidence_level=0.90,
            top_drivers=[],
            model_version="heuristic-fallback",
        )
        self.forecast_id = write_forecast(
            self.conn, forecast=fc, features=_sample_features(),
            stone_id=self.ids["stone_id"], tenant_id=self.ids["tenant_id"],
        )

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def test_markup_stored(self):
        result = apply_adjustment(
            self.conn,
            stone_id=self.ids["stone_id"],
            tenant_id=self.ids["tenant_id"],
            markup_pct=10.0,
            actor_id=self.ids["user_id"],
        )
        assert result["markup_pct"] == pytest.approx(10.0)

    def test_adjusted_price_computed_correctly(self):
        result = apply_adjustment(
            self.conn,
            stone_id=self.ids["stone_id"],
            tenant_id=self.ids["tenant_id"],
            markup_pct=10.0,
            actor_id=self.ids["user_id"],
        )
        expected = round(4_500.00 * 1.10, 2)
        assert result["adjusted_price_usd"] == pytest.approx(expected)

    def test_fair_price_unchanged_after_markup(self):
        apply_adjustment(
            self.conn,
            stone_id=self.ids["stone_id"],
            tenant_id=self.ids["tenant_id"],
            markup_pct=20.0,
            actor_id=self.ids["user_id"],
        )
        row = self.conn.execute(
            "SELECT fair_price_usd, markup_pct FROM price_forecasts WHERE stone_id = %s AND is_current = true",
            (self.ids["stone_id"],),
        ).fetchone()
        # fair_price_usd column must NEVER be changed
        assert float(row["fair_price_usd"]) == pytest.approx(4_500.00)
        assert float(row["markup_pct"]) == pytest.approx(20.0)

    def test_markdown_reduces_price(self):
        result = apply_adjustment(
            self.conn,
            stone_id=self.ids["stone_id"],
            tenant_id=self.ids["tenant_id"],
            markup_pct=-5.0,
            actor_id=self.ids["user_id"],
        )
        assert result["adjusted_price_usd"] < 4_500.00

    def test_adjustment_note_stored(self):
        apply_adjustment(
            self.conn,
            stone_id=self.ids["stone_id"],
            tenant_id=self.ids["tenant_id"],
            markup_pct=5.0,
            actor_id=self.ids["user_id"],
            adjustment_note="Market premium",
        )
        row = self.conn.execute(
            "SELECT adjustment_note FROM price_forecasts WHERE stone_id = %s AND is_current = true",
            (self.ids["stone_id"],),
        ).fetchone()
        assert row["adjustment_note"] == "Market premium"

    def test_no_forecast_raises_value_error(self):
        fake_id = str(uuid.uuid4())
        with pytest.raises(ValueError, match="No current forecast"):
            apply_adjustment(
                self.conn,
                stone_id=fake_id,
                tenant_id=self.ids["tenant_id"],
                markup_pct=10.0,
                actor_id=self.ids["user_id"],
            )

    def test_analytics_event_emitted(self):
        apply_adjustment(
            self.conn,
            stone_id=self.ids["stone_id"],
            tenant_id=self.ids["tenant_id"],
            markup_pct=8.0,
            actor_id=self.ids["user_id"],
        )
        row = self.conn.execute(
            "SELECT payload FROM audit_log WHERE entity_id = %s AND event_type = 'price_adjusted'",
            (self.ids["stone_id"],),
        ).fetchone()
        assert row is not None
        payload = row["payload"]
        assert payload["markup_pct"] == pytest.approx(8.0)
        assert payload["fair_price_usd"] == pytest.approx(4_500.00)


# ─────────────────────────────────────────────────────────────────────────────
# TestResponseTime
# ─────────────────────────────────────────────────────────────────────────────

class TestResponseTime:
    def test_heuristic_predict_under_2s(self):
        model = PricingModel()   # heuristic
        f = _sample_features()
        t0 = time.monotonic()
        for _ in range(100):
            model.predict(f)
        elapsed = time.monotonic() - t0
        per_call = elapsed / 100
        assert per_call < 2.0, f"Heuristic predict took {per_call*1000:.1f}ms per call"

    def test_xgb_predict_under_2s(self, tmp_path):
        rng = np.random.default_rng(0)
        X = rng.random((100, len(FEATURE_NAMES)))
        y = 3000 * X[:, 0] ** 1.9 + rng.normal(0, 100, 100)
        ckpt = str(tmp_path / "m.joblib")
        train_and_save(X, y, checkpoint_path=ckpt, model_version="perf-test")
        model = PricingModel(checkpoint_path=ckpt)

        f = _sample_features()
        t0 = time.monotonic()
        for _ in range(50):
            model.predict(f)
        elapsed = time.monotonic() - t0
        per_call = elapsed / 50
        assert per_call < 2.0, f"XGBoost predict took {per_call*1000:.1f}ms per call"


# ─────────────────────────────────────────────────────────────────────────────
# TestDBConstraints
# ─────────────────────────────────────────────────────────────────────────────

class TestDBConstraints:
    def setup_method(self):
        self.conn = psycopg.connect(DB_URL, row_factory=psycopg.rows.dict_row)
        self.ids = _seed(self.conn)

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def test_is_current_unique_per_stone(self):
        """Only one price_forecasts row per stone can have is_current=true (enforced by partial unique index)."""
        fc = PriceForecast(
            fair_price_usd=1000.0, confidence_low_usd=800.0,
            confidence_high_usd=1200.0, confidence_level=0.9,
            top_drivers=[], model_version="v1",
        )
        write_forecast(self.conn, forecast=fc, features=_sample_features(),
                       stone_id=self.ids["stone_id"], tenant_id=self.ids["tenant_id"])
        write_forecast(self.conn, forecast=fc, features=_sample_features(),
                       stone_id=self.ids["stone_id"], tenant_id=self.ids["tenant_id"])
        count = self.conn.execute(
            "SELECT COUNT(*) AS n FROM price_forecasts WHERE stone_id = %s AND is_current = true",
            (self.ids["stone_id"],),
        ).fetchone()["n"]
        assert count == 1
