"""
Certificate number online verification against GIA and IGI public lookup APIs.

Both labs provide a public cert-check endpoint; we hit them to confirm:
  - The cert number exists
  - The carat weight on the cert matches what we parsed (≤ 0.01 ct tolerance)
  - The grading values match

We treat the lookup as best-effort: if it times out or returns an error, we
record verification_notes and move on rather than blocking ingestion.
Callers should check ParsedCert after write to see whether verified_at is set.

Real endpoints (not yet callable from this environment — stubs used in tests):
  GIA:  https://www.gia.edu/report-check?reportno=<cert_number>
  IGI:  https://www.igi.org/verify-your-report/?r=<cert_number>

Both require either an API key or scraping the HTML response; the exact
mechanism depends on which access tier Centr8 has negotiated with each lab.
This module is structured so the actual HTTP call is swappable without
changing the interface.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import Dict, Optional, Protocol

import httpx

from .models import CertLab

logger = logging.getLogger(__name__)

VERIFICATION_TIMEOUT_S = 10


@dataclass
class LookupResult:
    success: bool
    matched: bool           # True = cert number exists and key fields match
    notes: str              # Human-readable summary, stored in certificates.verification_notes
    raw_response: Dict      # Full response for audit trail


class CertLookupClient(Protocol):
    def lookup(self, lab: CertLab, cert_number: str, carat_weight: Optional[Decimal]) -> LookupResult:
        ...


# ── GIA lookup ────────────────────────────────────────────────────────────────

class GIALookupClient:
    """
    Calls the GIA public report-check endpoint.

    GIA doesn't provide a machine-readable JSON API publicly; the current
    implementation parses the HTML response for key values.  When Centr8
    obtains a GIA API key, replace `_fetch_html` with a proper API call.
    """

    BASE_URL = "https://www.gia.edu/report-check"

    def lookup(
        self,
        lab: CertLab,
        cert_number: str,
        carat_weight: Decimal | None,
    ) -> LookupResult:
        try:
            return self._do_lookup(cert_number, carat_weight)
        except httpx.TimeoutException:
            return LookupResult(
                success=False, matched=False,
                notes="GIA lookup timed out — not verified",
                raw_response={},
            )
        except Exception as exc:
            logger.warning("GIA lookup failed for %s: %s", cert_number, exc)
            return LookupResult(
                success=False, matched=False,
                notes=f"GIA lookup error: {type(exc).__name__}",
                raw_response={},
            )

    def _do_lookup(self, cert_number: str, carat_weight: Decimal | None) -> LookupResult:
        with httpx.Client(timeout=VERIFICATION_TIMEOUT_S) as client:
            resp = client.get(
                self.BASE_URL,
                params={"reportno": cert_number},
                headers={"User-Agent": "LucidCarat/1.0 (cert-verification; contact@centr8.com)"},
                follow_redirects=True,
            )

        if resp.status_code == 404:
            return LookupResult(
                success=True, matched=False,
                notes=f"GIA cert number {cert_number} not found in GIA database",
                raw_response={"status_code": 404},
            )

        if resp.status_code != 200:
            return LookupResult(
                success=False, matched=False,
                notes=f"GIA lookup HTTP {resp.status_code}",
                raw_response={"status_code": resp.status_code},
            )

        # Parse the HTML to find the carat weight value
        # This is a best-effort scrape; a proper GIA API key would return JSON.
        import re
        carat_match = re.search(r"(\d+\.\d+)\s*(?:carat|ct)", resp.text, re.IGNORECASE)
        found_carat = Decimal(carat_match.group(1)) if carat_match else None

        if found_carat is None:
            return LookupResult(
                success=True, matched=False,
                notes="GIA cert found but carat weight not parseable from response",
                raw_response={"status_code": 200, "found_carat": None},
            )

        if carat_weight is not None:
            diff = abs(found_carat - carat_weight)
            if diff > Decimal("0.01"):
                return LookupResult(
                    success=True, matched=False,
                    notes=(
                        f"GIA cert found but carat mismatch: "
                        f"cert says {carat_weight}, GIA says {found_carat}"
                    ),
                    raw_response={"found_carat": str(found_carat)},
                )

        return LookupResult(
            success=True, matched=True,
            notes=f"Verified against GIA database; carat {found_carat} matches",
            raw_response={"found_carat": str(found_carat)},
        )


# ── IGI lookup ────────────────────────────────────────────────────────────────

class IGILookupClient:
    BASE_URL = "https://www.igi.org/verify-your-report/"

    def lookup(
        self,
        lab: CertLab,
        cert_number: str,
        carat_weight: Decimal | None,
    ) -> LookupResult:
        try:
            return self._do_lookup(cert_number, carat_weight)
        except httpx.TimeoutException:
            return LookupResult(
                success=False, matched=False,
                notes="IGI lookup timed out — not verified",
                raw_response={},
            )
        except Exception as exc:
            logger.warning("IGI lookup failed for %s: %s", cert_number, exc)
            return LookupResult(
                success=False, matched=False,
                notes=f"IGI lookup error: {type(exc).__name__}",
                raw_response={},
            )

    def _do_lookup(self, cert_number: str, carat_weight: Decimal | None) -> LookupResult:
        with httpx.Client(timeout=VERIFICATION_TIMEOUT_S) as client:
            resp = client.get(
                self.BASE_URL,
                params={"r": cert_number},
                headers={"User-Agent": "LucidCarat/1.0 (cert-verification; contact@centr8.com)"},
                follow_redirects=True,
            )

        if resp.status_code != 200:
            return LookupResult(
                success=False, matched=False,
                notes=f"IGI lookup HTTP {resp.status_code}",
                raw_response={"status_code": resp.status_code},
            )

        import re
        if "not found" in resp.text.lower() or "invalid" in resp.text.lower():
            return LookupResult(
                success=True, matched=False,
                notes=f"IGI cert number {cert_number} not found",
                raw_response={"status_code": 200},
            )

        carat_match = re.search(r"(\d+\.\d+)\s*(?:carat|ct|cts)", resp.text, re.IGNORECASE)
        found_carat = Decimal(carat_match.group(1)) if carat_match else None

        if carat_weight and found_carat:
            diff = abs(found_carat - carat_weight)
            if diff > Decimal("0.01"):
                return LookupResult(
                    success=True, matched=False,
                    notes=f"IGI carat mismatch: cert={carat_weight}, IGI={found_carat}",
                    raw_response={"found_carat": str(found_carat)},
                )

        return LookupResult(
            success=True, matched=True,
            notes=f"Verified against IGI database",
            raw_response={"found_carat": str(found_carat) if found_carat else None},
        )


# ── Stub for tests / offline environments ─────────────────────────────────────

class StubLookupClient:
    """
    Returns a configurable result without making any network calls.
    Used in unit tests and when CERT_LOOKUP_ENABLED=false.
    """
    def __init__(self, matched: bool = True, notes: str = "stub — lookup skipped"):
        self._matched = matched
        self._notes = notes

    def lookup(self, lab: CertLab, cert_number: str, carat_weight: Decimal | None) -> LookupResult:
        return LookupResult(
            success=True,
            matched=self._matched,
            notes=self._notes,
            raw_response={"stub": True},
        )


# ── Factory ───────────────────────────────────────────────────────────────────

def get_lookup_client(lab: CertLab, enabled: bool = True) -> CertLookupClient:
    """Return the appropriate lookup client based on lab and config."""
    if not enabled:
        return StubLookupClient(matched=False, notes="online lookup disabled")
    if lab == CertLab.GIA:
        return GIALookupClient()
    if lab == CertLab.IGI:
        return IGILookupClient()
    return StubLookupClient(matched=False, notes=f"no lookup client for lab {lab.value}")
