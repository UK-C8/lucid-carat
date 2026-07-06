"""
Tests for the certificate ingestion pipeline.

Covers:
  - Parser: field extraction, normalization, confidence annotation
  - Confidence flagging: low/missing fields appear in low_confidence_fields
  - Carat hard rule: missing/unparseable carat → MISSING confidence, never guessed
  - Writer: DB persistence, analytics event emission
  - Integration: full parse → write → DB verify round-trip

Run with:
    cd services/grading
    pip install -r requirements.txt pytest
    pytest tests/ -v
"""
from __future__ import annotations

import json
import uuid
from decimal import Decimal

import psycopg
import psycopg.rows
import pytest

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from cert_ingestion.models import CertLab, FieldConfidence, LabGrownFlag
from cert_ingestion.parser import parse_cert_from_dict
from cert_ingestion.lookup import LookupResult, StubLookupClient
from cert_ingestion.writer import write_parsed_cert

# ─────────────────────────────────────────────────────────────────────────────
# Test fixtures — representative cert field sets
# ─────────────────────────────────────────────────────────────────────────────

# Fixture A: Ideal GIA round brilliant — all fields clean
GIA_CLEAN = {
    "cert_number":    "2141438167",
    "carat_weight":   "1.01",
    "shape":          "Round Brilliant",
    "color_grade":    "D",
    "clarity_grade":  "FL",
    "cut_grade":      "Excellent",
    "polish":         "Excellent",
    "symmetry":       "Excellent",
    "fluorescence":   "None",
    "measurements_mm": "6.42 - 6.46 x 3.98",
    "depth_pct":      "61.9",
    "table_pct":      "57",
    "issued_date":    "January 15, 2024",
}

# Fixture B: IGI oval — no cut grade (fancy shape), abbreviated values
IGI_OVAL = {
    "cert_number":    "507234891",
    "carat_weight":   "2.05",
    "shape":          "OVAL",
    "color_grade":    "G",
    "clarity_grade":  "VS1",
    "cut_grade":      None,        # Not applicable for ovals
    "polish":         "EX",        # Abbreviation → should normalize
    "symmetry":       "VG",
    "fluorescence":   "FNT",       # Abbreviation → should normalize
    "measurements_mm": "9.21 x 7.14 x 4.60",
    "depth_pct":      "64.4",
    "table_pct":      "59",
    "issued_date":    "03-2023",      # Non-standard format → LOW confidence
}

# Fixture C: GIA cert with ambiguous / low-quality values
GIA_LOW_QUALITY = {
    "cert_number":    "214143816",   # Only 9 digits → MEDIUM
    "carat_weight":   "25.00",       # Out of plausible range → LOW
    "shape":          "EXOTIC CUT",  # Unknown shape → LOW
    "color_grade":    "ZZ",           # Not in GIA scale → LOW
    "clarity_grade":  "VS-1",        # Hyphenated → should normalize to VS1
    "cut_grade":      "EX",
    "polish":         "EX",
    "symmetry":       "GD",
    "fluorescence":   "STRONG BLUE", # Extra descriptor → MEDIUM
    "measurements_mm": "ABC",        # Garbage → LOW
    "depth_pct":      "not available",
    "table_pct":      "62",
    "issued_date":    "yesterday",   # Unparseable → LOW
}

# Fixture D: Missing carat — tests the hard rule
GIA_MISSING_CARAT = {
    "cert_number":    "3141592653",
    "carat_weight":   "",            # Absent
    "shape":          "Round Brilliant",
    "color_grade":    "E",
    "clarity_grade":  "VVS1",
    "cut_grade":      "Excellent",
    "polish":         "Very Good",
    "symmetry":       "Excellent",
    "fluorescence":   "Medium",
    "measurements_mm": "5.50 - 5.52 x 3.42",
    "depth_pct":      "62.2",
    "table_pct":      "55",
    "issued_date":    "June 01, 2023",
}

# Fixture E: Lab-grown stone (text marker present)
GIA_LAB_GROWN = {
    **GIA_CLEAN,
    "cert_number": "5678901234",
    "full_text": "This is a LABORATORY GROWN diamond. CVD process. D FL 1.01ct.",
}


# ─────────────────────────────────────────────────────────────────────────────
# Parser unit tests
# ─────────────────────────────────────────────────────────────────────────────

class TestParserGIAClean:
    def setup_method(self):
        self.parsed = parse_cert_from_dict(GIA_CLEAN, CertLab.GIA)

    def test_cert_number_high_confidence(self):
        assert self.parsed.cert_number.confidence == FieldConfidence.HIGH
        assert self.parsed.cert_number.value == "2141438167"

    def test_carat_weight_high_confidence(self):
        assert self.parsed.carat_weight.confidence == FieldConfidence.HIGH
        assert self.parsed.carat_weight.value == Decimal("1.01")

    def test_color_high_confidence(self):
        assert self.parsed.color_grade.confidence == FieldConfidence.HIGH
        assert self.parsed.color_grade.value == "D"

    def test_clarity_high_confidence(self):
        assert self.parsed.clarity_grade.confidence == FieldConfidence.HIGH
        assert self.parsed.clarity_grade.value == "FL"

    def test_cut_high_confidence_for_round(self):
        assert self.parsed.cut_grade.confidence == FieldConfidence.HIGH
        assert self.parsed.cut_grade.value == "Excellent"

    def test_fluorescence_normalized(self):
        assert self.parsed.fluorescence.value == "None"
        assert self.parsed.fluorescence.confidence == FieldConfidence.HIGH

    def test_measurements_high_confidence(self):
        assert self.parsed.measurements_mm.confidence == FieldConfidence.HIGH

    def test_no_low_confidence_fields(self):
        assert self.parsed.low_confidence_fields == [], (
            f"Expected no flagged fields, got: {self.parsed.low_confidence_fields}"
        )

    def test_lab_grown_unknown(self):
        assert self.parsed.lab_grown == LabGrownFlag.UNKNOWN


class TestParserIGIOval:
    def setup_method(self):
        self.parsed = parse_cert_from_dict(IGI_OVAL, CertLab.IGI)

    def test_cut_grade_missing_for_oval(self):
        # Fancy shapes don't get a cut grade — this should be MISSING, not LOW
        assert self.parsed.cut_grade.confidence == FieldConfidence.MISSING
        assert "not applicable" in (self.parsed.cut_grade.note or "").lower()

    def test_polish_abbreviation_normalized(self):
        assert self.parsed.polish.value == "Excellent"
        assert self.parsed.polish.raw == "EX"

    def test_symmetry_abbreviation_normalized(self):
        assert self.parsed.symmetry.value == "Very Good"

    def test_fluorescence_abbreviation_normalized(self):
        assert self.parsed.fluorescence.value == "Faint"
        assert self.parsed.fluorescence.raw == "FNT"

    def test_date_non_standard_format_low_confidence(self):
        # "03-2023" is not a standard cert date format — should be LOW
        assert self.parsed.issued_date.confidence in (FieldConfidence.LOW, FieldConfidence.MEDIUM)

    def test_cut_in_low_confidence_fields(self):
        # cut_grade is MISSING → must appear in low_confidence_fields
        assert "cut_grade" in self.parsed.low_confidence_fields

    def test_date_in_low_confidence_fields(self):
        # "03-2023" should be flagged (LOW or MEDIUM → both land in low_confidence_fields)
        assert "issued_date" in self.parsed.low_confidence_fields


class TestParserLowQuality:
    def setup_method(self):
        self.parsed = parse_cert_from_dict(GIA_LOW_QUALITY, CertLab.GIA)

    def test_cert_number_medium_confidence_wrong_length(self):
        assert self.parsed.cert_number.confidence == FieldConfidence.MEDIUM

    def test_carat_out_of_range_low_confidence(self):
        assert self.parsed.carat_weight.confidence == FieldConfidence.LOW
        assert "outside expected range" in (self.parsed.carat_weight.note or "")

    def test_unknown_shape_low_confidence(self):
        assert self.parsed.shape.confidence == FieldConfidence.LOW

    def test_invalid_color_low_confidence(self):
        # "ZZ" is not in the GIA D–Z scale → LOW
        assert self.parsed.color_grade.confidence == FieldConfidence.LOW

    def test_hyphenated_clarity_normalized(self):
        # "VS-1" should normalize to "VS1" at HIGH or at least not LOW
        assert self.parsed.clarity_grade.value == "VS1"
        assert self.parsed.clarity_grade.confidence == FieldConfidence.HIGH

    def test_garbage_measurements_low_confidence(self):
        assert self.parsed.measurements_mm.confidence == FieldConfidence.LOW

    def test_unparseable_date_low_confidence(self):
        assert self.parsed.issued_date.confidence == FieldConfidence.LOW

    def test_many_low_confidence_fields_flagged(self):
        flagged = set(self.parsed.low_confidence_fields)
        # At minimum these must be flagged
        must_flag = {"carat_weight", "shape", "color_grade",
                     "measurements_mm", "issued_date"}
        missing_flags = must_flag - flagged
        assert not missing_flags, (
            f"Expected these fields to be flagged: {missing_flags}. "
            f"Actual flagged: {flagged}"
        )

    def test_fluorescence_extra_descriptor_medium(self):
        # "STRONG BLUE" → inferred as "Strong" via partial match → MEDIUM
        assert self.parsed.fluorescence.value == "Strong"
        assert self.parsed.fluorescence.confidence == FieldConfidence.MEDIUM


class TestCaratHardRule:
    """
    HARD RULE (FR-2): carat_weight must come from the cert.
    If absent or unparseable, confidence = MISSING and the field is flagged.
    The value must never be synthesized or guessed.
    """

    def test_missing_carat_confidence_is_missing(self):
        parsed = parse_cert_from_dict(GIA_MISSING_CARAT, CertLab.GIA)
        assert parsed.carat_weight.confidence == FieldConfidence.MISSING
        assert parsed.carat_weight.value is None

    def test_missing_carat_appears_in_low_confidence_fields(self):
        parsed = parse_cert_from_dict(GIA_MISSING_CARAT, CertLab.GIA)
        assert "carat_weight" in parsed.low_confidence_fields, (
            "carat_weight must be in low_confidence_fields when MISSING"
        )

    def test_missing_carat_never_has_a_value(self):
        # Regression guard: ensure no code path ever fills in a carat value
        # from anything other than the cert fields dict.
        parsed = parse_cert_from_dict(GIA_MISSING_CARAT, CertLab.GIA)
        assert parsed.carat_weight.value is None, (
            "Carat must not be synthesized — FR-2 hard rule"
        )

    def test_unparseable_carat_string_low_confidence(self):
        fields = {**GIA_CLEAN, "carat_weight": "not a number"}
        parsed = parse_cert_from_dict(fields, CertLab.GIA)
        assert parsed.carat_weight.confidence == FieldConfidence.LOW
        assert parsed.carat_weight.value is None

    def test_zero_carat_low_confidence(self):
        fields = {**GIA_CLEAN, "carat_weight": "0.00"}
        parsed = parse_cert_from_dict(fields, CertLab.GIA)
        assert parsed.carat_weight.confidence == FieldConfidence.LOW


class TestLabGrownDetection:
    def test_lab_grown_marker_detected(self):
        parsed = parse_cert_from_dict(GIA_LAB_GROWN, CertLab.GIA)
        assert parsed.lab_grown == LabGrownFlag.LAB_GROWN

    def test_natural_stone_unknown_without_marker(self):
        parsed = parse_cert_from_dict(GIA_CLEAN, CertLab.GIA)
        assert parsed.lab_grown == LabGrownFlag.UNKNOWN

    def test_natural_keyword_detected(self):
        fields = {**GIA_CLEAN, "full_text": "Natural mined diamond D FL"}
        parsed = parse_cert_from_dict(fields, CertLab.GIA)
        assert parsed.lab_grown == LabGrownFlag.NATURAL


# ─────────────────────────────────────────────────────────────────────────────
# Writer + DB integration tests
# ─────────────────────────────────────────────────────────────────────────────

DB_URL = os.environ.get("LC_DATABASE_URL", "postgresql://urvilkargathala@localhost/lucidcarat_dev")


def _get_conn():
    return psycopg.connect(DB_URL, row_factory=psycopg.rows.dict_row)


def _seed_tenant_and_stone(conn, cert_number: str, lab: str = "GIA"):
    """Create the minimal tenant + stone + cert shell needed for writer tests."""
    tenant_id = str(uuid.uuid4())
    stone_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO tenants (id, name, slug) VALUES (%s, %s, %s)",
        (tenant_id, f"Test House {tenant_id[:8]}", f"test-{tenant_id[:8]}"),
    )
    conn.execute(
        "INSERT INTO stones (id, tenant_id, status, video_s3_key, cert_s3_key) "
        "VALUES (%s, %s, 'uploaded', 'tenants/x/y/video/v.mp4', 'tenants/x/y/cert/c.pdf')",
        (stone_id, tenant_id),
    )
    # Cert shell (as created by the ingest CLI)
    conn.execute(
        "INSERT INTO certificates (stone_id, tenant_id, lab, cert_number, cert_s3_key) "
        "VALUES (%s, %s, %s, %s, 'tenants/x/y/cert/c.pdf')",
        (stone_id, tenant_id, lab, cert_number),
    )
    return tenant_id, stone_id


class TestWriterIntegration:
    """Full parse → write → DB verify round-trip tests."""

    # Cert numbers used across all writer tests — cleaned up on setup.
    _TEST_CERT_NUMBERS = (
        "2141438167", "3141592653", "214143816",
        "9999999999", "8888888888", "7777777777",
    )

    def setup_method(self):
        self.conn = _get_conn()
        # Remove any leftover rows from a previous interrupted test run.
        self.conn.execute(
            "DELETE FROM certificates WHERE cert_number = ANY(%s)",
            (list(self._TEST_CERT_NUMBERS),),
        )
        self.conn.commit()

    def teardown_method(self):
        self.conn.rollback()
        self.conn.close()

    def test_clean_cert_writes_all_fields(self):
        tenant_id, stone_id = _seed_tenant_and_stone(self.conn, "2141438167")
        parsed = parse_cert_from_dict(GIA_CLEAN, CertLab.GIA)
        stub = StubLookupClient(matched=True, notes="stub verified")
        lookup = stub.lookup(CertLab.GIA, "2141438167", Decimal("1.01"))

        cert_id = write_parsed_cert(
            self.conn,
            parsed=parsed,
            stone_id=stone_id,
            tenant_id=tenant_id,
            cert_s3_key="tenants/x/y/cert/c.pdf",
            lookup_result=lookup,
        )

        row = self.conn.execute(
            "SELECT * FROM certificates WHERE id = %s", (cert_id,)
        ).fetchone()

        assert row["carat_weight"] == Decimal("1.01")
        assert row["color_grade"] == "D"
        assert row["clarity_grade"] == "FL"
        assert row["cut_grade"] == "Excellent"
        assert row["fluorescence"] == "None"
        assert row["low_confidence_fields"] == []
        assert row["verified_at"] is not None    # lookup matched → verified
        assert row["verification_notes"] == "stub verified"


    def test_missing_carat_writes_null_to_db(self):
        """HARD RULE: missing carat must be NULL in DB, never synthesized."""
        tenant_id, stone_id = _seed_tenant_and_stone(self.conn, "3141592653")
        parsed = parse_cert_from_dict(GIA_MISSING_CARAT, CertLab.GIA)
        stub = StubLookupClient()
        lookup = stub.lookup(CertLab.GIA, "3141592653", None)

        cert_id = write_parsed_cert(
            self.conn,
            parsed=parsed,
            stone_id=stone_id,
            tenant_id=tenant_id,
            cert_s3_key="tenants/x/y/cert/c.pdf",
            lookup_result=lookup,
        )

        row = self.conn.execute(
            "SELECT carat_weight, low_confidence_fields FROM certificates WHERE id = %s",
            (cert_id,),
        ).fetchone()

        assert row["carat_weight"] is None, (
            "carat_weight must be NULL in DB when cert has no carat — FR-2 hard rule"
        )
        assert "carat_weight" in row["low_confidence_fields"], (
            "carat_weight must appear in low_confidence_fields when MISSING"
        )

    def test_low_confidence_fields_stored_in_db(self):
        """All flagged fields must be persisted to low_confidence_fields[], not silently dropped."""
        tenant_id, stone_id = _seed_tenant_and_stone(self.conn, "214143816")
        parsed = parse_cert_from_dict(GIA_LOW_QUALITY, CertLab.GIA)
        stub = StubLookupClient(matched=False)
        lookup = stub.lookup(CertLab.GIA, "214143816", None)

        cert_id = write_parsed_cert(
            self.conn,
            parsed=parsed,
            stone_id=stone_id,
            tenant_id=tenant_id,
            cert_s3_key="tenants/x/y/cert/c.pdf",
            lookup_result=lookup,
        )

        row = self.conn.execute(
            "SELECT low_confidence_fields FROM certificates WHERE id = %s",
            (cert_id,),
        ).fetchone()

        flagged = set(row["low_confidence_fields"])
        must_flag = {"carat_weight", "shape", "color_grade", "measurements_mm"}
        missing = must_flag - flagged
        assert not missing, (
            f"These fields should be in low_confidence_fields but aren't: {missing}. "
            f"Got: {flagged}"
        )

    def test_analytics_event_emitted(self):
        """cert_ingested event must appear in audit_log after write."""
        tenant_id, stone_id = _seed_tenant_and_stone(self.conn, "9999999999")
        fields_with_num = {**GIA_CLEAN, "cert_number": "9999999999"}
        parsed = parse_cert_from_dict(fields_with_num, CertLab.GIA)
        stub = StubLookupClient(matched=True)
        lookup = stub.lookup(CertLab.GIA, "9999999999", Decimal("1.01"))

        write_parsed_cert(
            self.conn,
            parsed=parsed,
            stone_id=stone_id,
            tenant_id=tenant_id,
            cert_s3_key="tenants/x/y/cert/c.pdf",
            lookup_result=lookup,
        )

        event = self.conn.execute(
            "SELECT * FROM audit_log WHERE event_type = 'cert_ingested' AND entity_id = %s",
            (stone_id,),
        ).fetchone()

        assert event is not None, "cert_ingested analytics event must be in audit_log"
        payload = event["payload"]
        assert payload["lab"] == "GIA"
        assert payload["cert_number"] == "9999999999"
        assert "low_confidence_fields" in payload
        assert payload["lookup_matched"] is True

    def test_provenance_event_appended(self):
        """cert_ingested provenance_event must also be written."""
        tenant_id, stone_id = _seed_tenant_and_stone(self.conn, "8888888888")
        fields_prov = {**GIA_CLEAN, "cert_number": "8888888888"}
        parsed = parse_cert_from_dict(fields_prov, CertLab.GIA)
        stub = StubLookupClient()
        lookup = stub.lookup(CertLab.GIA, "8888888888", Decimal("1.01"))

        write_parsed_cert(
            self.conn,
            parsed=parsed,
            stone_id=stone_id,
            tenant_id=tenant_id,
            cert_s3_key="tenants/x/y/cert/c.pdf",
            lookup_result=lookup,
        )

        prov = self.conn.execute(
            "SELECT * FROM provenance_events WHERE stone_id = %s AND event_type = 'cert_ingested'",
            (stone_id,),
        ).fetchone()

        assert prov is not None, "provenance_events must have a cert_ingested row"
        assert prov["payload"]["lab"] == "GIA"

    def test_idempotent_reparse(self):
        """Running the writer twice on the same cert must not raise an error."""
        tenant_id, stone_id = _seed_tenant_and_stone(self.conn, "7777777777")
        fields_idem = {**GIA_CLEAN, "cert_number": "7777777777"}
        parsed = parse_cert_from_dict(fields_idem, CertLab.GIA)
        stub = StubLookupClient(matched=True)

        for _ in range(2):
            lookup = stub.lookup(CertLab.GIA, "7777777777", Decimal("1.01"))
            write_parsed_cert(
                self.conn,
                parsed=parsed,
                stone_id=stone_id,
                tenant_id=tenant_id,
                cert_s3_key="tenants/x/y/cert/c.pdf",
                lookup_result=lookup,
            )

        row = self.conn.execute(
            "SELECT carat_weight FROM certificates WHERE stone_id = %s",
            (stone_id,),
        ).fetchone()
        assert row["carat_weight"] == Decimal("1.01")
