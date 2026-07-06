"""
LucidCarat Grading Service — FastAPI application.

Phase 1 endpoints
-----------------
POST /certs/ingest                      — parse a cert (structured JSON) and persist to DB
GET  /certs/{stone_id}                  — return the stored cert record for a stone
POST /grading/jobs                      — submit an async CV grading job
GET  /grading/jobs/{job_id}             — poll job status
GET  /grading/jobs/{job_id}/result      — retrieve grading result
GET  /grading/stones/{stone_id}/review  — view CV grades + confirmed state for grader
POST /grading/stones/{stone_id}/action  — confirm or override one dimension
POST /grading/stones/{stone_id}/advance — transition grading → priced (blocks if incomplete)
GET  /health                            — liveness probe
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID

import psycopg
import psycopg.rows
from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

from cert_ingestion.models import CertLab, ParsedCert
from cert_ingestion.parser import parse_cert_from_dict
from cert_ingestion.lookup import get_lookup_client
from cert_ingestion.writer import write_parsed_cert
from grading.pipeline import GradingPipeline
from grading.jobs import GradingJobManager, JobStatus
from grading.override import (
    apply_grade_action,
    advance_to_priced,
    get_review_state,
    OverrideError,
    InvalidGradeError,
    OverrideIncompleteError,
    StoneNotGradingError,
    NoCurrentGradingResultError,
)

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

DATABASE_URL = os.environ.get(
    "LC_DATABASE_URL",
    "postgresql://urvilkargathala@localhost/lucidcarat_dev",
)
CERT_LOOKUP_ENABLED = os.environ.get("CERT_LOOKUP_ENABLED", "false").lower() == "true"
GRADING_CHECKPOINT = os.environ.get("GRADING_CHECKPOINT")   # path to .pth file; None = untrained
GRADING_MODEL_VERSION = os.environ.get("GRADING_MODEL_VERSION", "0.1.0-untrained")


# ── Singletons ────────────────────────────────────────────────────────────────

_db_conn: psycopg.Connection | None = None
_job_manager: GradingJobManager | None = None


def get_db() -> psycopg.Connection:
    global _db_conn
    if _db_conn is None or _db_conn.closed:
        _db_conn = psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row, autocommit=True)
    return _db_conn


def get_job_manager() -> GradingJobManager:
    if _job_manager is None:
        raise RuntimeError("Job manager not initialised — lifespan error")
    return _job_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db_conn, _job_manager

    _db_conn = psycopg.connect(DATABASE_URL, row_factory=psycopg.rows.dict_row, autocommit=True)
    logger.info("DB connection established")

    pipeline = GradingPipeline(
        checkpoint_path=GRADING_CHECKPOINT,
        model_version=GRADING_MODEL_VERSION,
    )
    _job_manager = GradingJobManager(pipeline=pipeline, db_url=DATABASE_URL)
    logger.info("Grading job manager ready")

    yield

    _job_manager.shutdown()
    if _db_conn and not _db_conn.closed:
        _db_conn.close()
    logger.info("Grading service shut down cleanly")


app = FastAPI(
    title="LucidCarat Grading Service",
    version="0.2.0",
    lifespan=lifespan,
)


# ── Cert ingest request/response ──────────────────────────────────────────────

class CertIngestRequest(BaseModel):
    stone_id: UUID
    tenant_id: UUID
    lab: CertLab
    cert_s3_key: str
    fields: Dict[str, Optional[str]] = Field(
        default_factory=dict,
        description=(
            "Raw cert fields. Keys: cert_number, carat_weight, shape, "
            "color_grade, clarity_grade, cut_grade, polish, symmetry, "
            "fluorescence, measurements_mm, depth_pct, table_pct, issued_date, "
            "full_text (entire cert text for lab_grown detection)."
        ),
    )
    actor_id: Optional[UUID] = None
    request_id: Optional[str] = None


class FieldResultOut(BaseModel):
    value: Any
    confidence: str
    raw: Optional[str]
    note: Optional[str]


class CertIngestResponse(BaseModel):
    cert_id: str
    stone_id: str
    lab: str
    cert_number: Optional[str]
    carat_weight: Optional[str]
    low_confidence_fields: List[str]
    lookup_matched: Optional[bool]
    lookup_notes: Optional[str]
    parser_version: str
    fields: Dict[str, FieldResultOut]


# ── Grading job request/response ──────────────────────────────────────────────

class GradingJobRequest(BaseModel):
    stone_id: UUID
    tenant_id: UUID
    # Local path or S3 key of the 360° video.
    # Phase 1: local file path (service downloads from S3 in Phase 2).
    video_path: str
    shape: Optional[str] = None
    # Cert grades for disagreement detection — pass from cert ingest response.
    cert_color: Optional[str] = None
    cert_cut: Optional[str] = None
    cert_clarity: Optional[str] = None
    actor_id: Optional[UUID] = None
    request_id: Optional[str] = None


class DimensionResultOut(BaseModel):
    grade: Optional[str]
    confidence: float
    disagrees_with_cert: bool
    not_applicable: bool
    top_probs: Dict[str, float]


class GradingJobResponse(BaseModel):
    job_id: str
    stone_id: str
    status: str


class GradingJobStatusResponse(BaseModel):
    job_id: str
    stone_id: str
    status: str
    error: Optional[str] = None
    elapsed_seconds: Optional[float] = None


class GradingResultResponse(BaseModel):
    job_id: str
    stone_id: str
    grading_result_id: Optional[str]
    model_version: str
    color: DimensionResultOut
    cut: DimensionResultOut
    clarity: DimensionResultOut
    n_frames_used: int
    status: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "grading"}


@app.post("/certs/ingest", response_model=CertIngestResponse, status_code=status.HTTP_201_CREATED)
def ingest_cert(req: CertIngestRequest) -> CertIngestResponse:
    """
    Parse structured cert fields and persist to the certificates table.
    Carat weight MUST come from the cert dict — never from CV (FR-2 hard rule).
    """
    parsed: ParsedCert = parse_cert_from_dict(req.fields, req.lab)

    lookup_client = get_lookup_client(req.lab, enabled=CERT_LOOKUP_ENABLED)
    carat_for_lookup = None
    if parsed.carat_weight.value is not None:
        carat_for_lookup = Decimal(str(parsed.carat_weight.value))
    lookup_result = lookup_client.lookup(
        req.lab, str(parsed.cert_number.value or ""), carat_for_lookup,
    )

    conn = get_db()
    try:
        with conn.transaction():
            cert_id = write_parsed_cert(
                conn,
                parsed=parsed,
                stone_id=str(req.stone_id),
                tenant_id=str(req.tenant_id),
                cert_s3_key=req.cert_s3_key,
                lookup_result=lookup_result,
                actor_id=str(req.actor_id) if req.actor_id else None,
                request_id=req.request_id,
            )
    except psycopg.Error as exc:
        logger.error("DB error during cert ingest: %s", exc)
        raise HTTPException(status_code=500, detail=f"Database error: {exc}")

    field_names = [
        "cert_number", "carat_weight", "shape", "color_grade", "clarity_grade",
        "cut_grade", "polish", "symmetry", "fluorescence", "measurements_mm",
        "depth_pct", "table_pct", "issued_date",
    ]
    return CertIngestResponse(
        cert_id=cert_id,
        stone_id=str(req.stone_id),
        lab=parsed.lab.value,
        cert_number=str(parsed.cert_number.value) if parsed.cert_number.value else None,
        carat_weight=str(parsed.carat_weight.value) if parsed.carat_weight.value else None,
        low_confidence_fields=parsed.low_confidence_fields,
        lookup_matched=lookup_result.matched,
        lookup_notes=lookup_result.notes,
        parser_version=parsed.parser_version,
        fields={
            name: FieldResultOut(
                value=str(getattr(parsed, name).value) if getattr(parsed, name).value is not None else None,
                confidence=getattr(parsed, name).confidence.value,
                raw=getattr(parsed, name).raw,
                note=getattr(parsed, name).note,
            )
            for name in field_names
        },
    )


@app.get("/certs/{stone_id}")
def get_cert(stone_id: str) -> dict:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM certificates WHERE stone_id = %s", (stone_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"No certificate for stone {stone_id}")
    return dict(row)


@app.post("/grading/jobs", response_model=GradingJobResponse, status_code=status.HTTP_202_ACCEPTED)
def submit_grading_job(req: GradingJobRequest) -> GradingJobResponse:
    """
    Submit an async CV grading job.  Returns immediately with a job_id to poll.
    The grading pipeline runs in a background thread (~30s).
    """
    jm = get_job_manager()
    job_id = jm.submit(
        stone_id=str(req.stone_id),
        tenant_id=str(req.tenant_id),
        video_path=req.video_path,
        shape=req.shape,
        cert_color=req.cert_color,
        cert_cut=req.cert_cut,
        cert_clarity=req.cert_clarity,
        actor_id=str(req.actor_id) if req.actor_id else None,
        request_id=req.request_id,
    )
    return GradingJobResponse(
        job_id=job_id,
        stone_id=str(req.stone_id),
        status=JobStatus.SUBMITTED.value,
    )


@app.get("/grading/jobs/{job_id}", response_model=GradingJobStatusResponse)
def get_grading_job_status(job_id: str) -> GradingJobStatusResponse:
    """Poll the status of a grading job."""
    jm = get_job_manager()
    record = jm.get_status(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"No grading job: {job_id}")

    elapsed = None
    if record.completed_at is not None:
        elapsed = round(record.completed_at - record.submitted_at, 1)

    return GradingJobStatusResponse(
        job_id=job_id,
        stone_id=record.stone_id,
        status=record.status.value,
        error=record.error,
        elapsed_seconds=elapsed,
    )


@app.get("/grading/jobs/{job_id}/result", response_model=GradingResultResponse)
def get_grading_job_result(job_id: str) -> GradingResultResponse:
    """
    Retrieve the full grading result once the job is completed.
    Returns 404 if job not found, 425 if still running.
    """
    jm = get_job_manager()
    record = jm.get_status(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"No grading job: {job_id}")

    if record.status == JobStatus.FAILED:
        raise HTTPException(status_code=500, detail=f"Grading job failed: {record.error}")

    if record.status in (JobStatus.SUBMITTED, JobStatus.RUNNING):
        raise HTTPException(
            status_code=425,  # Too Early
            detail=f"Grading job still {record.status.value}",
        )

    r = record.result
    return GradingResultResponse(
        job_id=job_id,
        stone_id=record.stone_id,
        grading_result_id=record.grading_result_id,
        model_version=r.model_version,
        color=DimensionResultOut(
            grade=r.color.grade,
            confidence=r.color.confidence,
            disagrees_with_cert=r.color.disagrees_with_cert,
            not_applicable=r.color.not_applicable,
            top_probs=r.color.probs,
        ),
        cut=DimensionResultOut(
            grade=r.cut.grade,
            confidence=r.cut.confidence,
            disagrees_with_cert=r.cut.disagrees_with_cert,
            not_applicable=r.cut.not_applicable,
            top_probs=r.cut.probs,
        ),
        clarity=DimensionResultOut(
            grade=r.clarity.grade,
            confidence=r.clarity.confidence,
            disagrees_with_cert=r.clarity.disagrees_with_cert,
            not_applicable=r.clarity.not_applicable,
            top_probs=r.clarity.probs,
        ),
        n_frames_used=r.n_frames_used,
        status=record.status.value,
    )


# ── Override workflow request/response models ─────────────────────────────────

class GradeActionRequest(BaseModel):
    tenant_id: UUID
    actor_id: UUID
    dimension: str             # 'color' | 'clarity' | 'cut'
    action: str                # 'confirm' | 'override'
    new_grade: str
    override_reason: Optional[str] = None
    request_id: Optional[str] = None


class GradeActionResponse(BaseModel):
    override_id: int
    stone_id: str
    dimension: str
    action: str
    old_grade: Optional[str]
    new_grade: str
    cv_confidence: Optional[float]
    grading_result_id: Optional[str]


class AdvanceRequest(BaseModel):
    tenant_id: UUID
    actor_id: UUID
    request_id: Optional[str] = None


class ReviewStateResponse(BaseModel):
    stone_id: str
    stone_status: str
    grading_result_id: Optional[str]
    model_version: Optional[str]
    cv_color: Optional[str]
    cv_cut: Optional[str]
    cv_clarity: Optional[str]
    color_confidence: Optional[float]
    cut_confidence: Optional[float]
    clarity_confidence: Optional[float]
    color_disagrees_with_cert: bool
    cut_disagrees_with_cert: bool
    clarity_disagrees_with_cert: bool
    confirmed_color: Optional[str]
    confirmed_cut: Optional[str]
    confirmed_clarity: Optional[str]
    confirmed_at: Optional[str]
    cert_color: Optional[str]
    cert_cut: Optional[str]
    cert_clarity: Optional[str]
    ready_to_advance: bool
    unactioned_dimensions: List[str]


# ── Override endpoints ────────────────────────────────────────────────────────

@app.get("/grading/stones/{stone_id}/review", response_model=ReviewStateResponse)
def review_stone(stone_id: str, tenant_id: UUID) -> ReviewStateResponse:
    """
    Return the current grading state for a stone: CV predictions, confidence
    scores, cert-disagreement flags, and which dimensions have been confirmed.
    """
    conn = get_db()
    try:
        state = get_review_state(conn, stone_id=stone_id, tenant_id=str(tenant_id))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return ReviewStateResponse(**state.__dict__)


@app.post(
    "/grading/stones/{stone_id}/action",
    response_model=GradeActionResponse,
    status_code=status.HTTP_201_CREATED,
)
def grade_action(stone_id: str, req: GradeActionRequest) -> GradeActionResponse:
    """
    Confirm or override a single graded dimension.

    - confirm: accept the CV predicted grade as-is.
    - override: supply a corrected grade; override_reason is mandatory.

    Every action is permanently recorded in grading_overrides (immutable).
    The stone cannot advance to 'priced' until all 3 dimensions are actioned.
    """
    conn = get_db()
    try:
        with conn.transaction():
            record = apply_grade_action(
                conn,
                stone_id=stone_id,
                tenant_id=str(req.tenant_id),
                actor_id=str(req.actor_id),
                dimension=req.dimension,
                action=req.action,
                new_grade=req.new_grade,
                override_reason=req.override_reason,
                request_id=req.request_id,
            )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except (InvalidGradeError, OverrideError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except StoneNotGradingError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except NoCurrentGradingResultError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except psycopg.Error as exc:
        logger.error("DB error during grade action: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    return GradeActionResponse(
        override_id=record.override_id,
        stone_id=record.stone_id,
        dimension=record.dimension,
        action=record.action,
        old_grade=record.old_grade,
        new_grade=record.new_grade,
        cv_confidence=record.cv_confidence,
        grading_result_id=record.grading_result_id,
    )


@app.post("/grading/stones/{stone_id}/advance", status_code=status.HTTP_200_OK)
def advance_stone(stone_id: str, req: AdvanceRequest) -> dict:
    """
    Attempt to transition a stone from 'grading' → 'priced'.

    Returns 409 with a structured error listing missing dimensions if any
    dimension has not yet been confirmed or overridden.

    The DB CHECK constraint priced_requires_confirmed_grades provides a second
    enforcement layer independent of this application check.
    """
    conn = get_db()
    try:
        with conn.transaction():
            advance_to_priced(
                conn,
                stone_id=stone_id,
                tenant_id=str(req.tenant_id),
                actor_id=str(req.actor_id),
                request_id=req.request_id,
            )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except OverrideIncompleteError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "override_incomplete",
                "message": str(exc),
                "missing_dimensions": sorted(exc.missing),
            },
        )
    except StoneNotGradingError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except psycopg.errors.CheckViolation as exc:
        # DB constraint fired — belt-and-suspenders path.
        raise HTTPException(
            status_code=409,
            detail={
                "error": "db_constraint_violation",
                "message": "DB rejected the status transition — confirmed grades incomplete.",
            },
        )
    except psycopg.Error as exc:
        logger.error("DB error during advance: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    return {"stone_id": stone_id, "status": "priced"}
