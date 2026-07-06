"""
Async grading job manager.

Phase 1 implementation
----------------------
Jobs run in a ThreadPoolExecutor (one thread per grading job, max N_WORKERS
concurrent).  Job state is stored both in-memory (for fast polling) and in the
audit_log table (for durability across restarts — the in-memory store is rebuilt
from the DB on startup in Phase 2; for now a restart loses in-flight jobs, which
is acceptable because Phase 1 is single-instance internal tooling).

The target ~30s per stone (FR-3 NFR) comes from:
  - Frame extraction: ~5s for 24 frames from a 60s video
  - EfficientNet-B0 inference × 24 frames on CPU: ~20s
  - DB writes + analytics: ~1s
  Total: ~26s on modern CPU, well within the 30s target.

GPU (ECS task with GPU) would reduce inference to ~3s total.

Job lifecycle
-------------
  submitted → running → completed | failed

API
---
  submit_job(stone_id, ...) → job_id
  get_job_status(job_id)   → JobStatus
  get_job_result(job_id)   → GradingResult | None
"""
from __future__ import annotations

import logging
import os
import tempfile
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Dict, Optional

import psycopg
import psycopg.rows

from .pipeline import GradingPipeline, GradingResult
from .writer import write_grading_result

logger = logging.getLogger(__name__)

N_WORKERS = int(os.environ.get("GRADING_WORKERS", "2"))


class JobStatus(str, Enum):
    SUBMITTED = "submitted"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class JobRecord:
    job_id: str
    stone_id: str
    tenant_id: str
    status: JobStatus = JobStatus.SUBMITTED
    grading_result_id: Optional[str] = None
    result: Optional[GradingResult] = None
    error: Optional[str] = None
    submitted_at: float = field(default_factory=lambda: __import__("time").time())
    completed_at: Optional[float] = None


class GradingJobManager:
    """
    Singleton service.  Initialise once at FastAPI startup via the lifespan handler.
    """

    def __init__(
        self,
        pipeline: GradingPipeline,
        db_url: str,
    ):
        self._pipeline = pipeline
        self._db_url = db_url
        self._executor = ThreadPoolExecutor(max_workers=N_WORKERS, thread_name_prefix="grading")
        self._jobs: Dict[str, JobRecord] = {}
        self._lock = threading.Lock()

    def submit(
        self,
        *,
        stone_id: str,
        tenant_id: str,
        video_path: str,
        shape: Optional[str] = None,
        cert_color: Optional[str] = None,
        cert_cut: Optional[str] = None,
        cert_clarity: Optional[str] = None,
        actor_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> str:
        """
        Enqueue a grading job.  Returns job_id immediately (non-blocking).
        """
        job_id = str(uuid.uuid4())
        record = JobRecord(job_id=job_id, stone_id=stone_id, tenant_id=tenant_id)
        with self._lock:
            self._jobs[job_id] = record

        self._executor.submit(
            self._run_job,
            record,
            video_path=video_path,
            shape=shape,
            cert_color=cert_color,
            cert_cut=cert_cut,
            cert_clarity=cert_clarity,
            actor_id=actor_id,
            request_id=request_id,
        )
        logger.info("Grading job submitted  job_id=%s  stone_id=%s", job_id, stone_id)
        return job_id

    def get_status(self, job_id: str) -> Optional[JobRecord]:
        with self._lock:
            return self._jobs.get(job_id)

    def _run_job(
        self,
        record: JobRecord,
        *,
        video_path: str,
        shape: Optional[str],
        cert_color: Optional[str],
        cert_cut: Optional[str],
        cert_clarity: Optional[str],
        actor_id: Optional[str],
        request_id: Optional[str],
    ) -> None:
        import time

        with self._lock:
            record.status = JobStatus.RUNNING

        try:
            result = self._pipeline.grade_stone(
                video_path=video_path,
                stone_id=record.stone_id,
                shape=shape,
                cert_color=cert_color,
                cert_cut=cert_cut,
                cert_clarity=cert_clarity,
            )

            # Persist to DB.
            conn = psycopg.connect(self._db_url, row_factory=psycopg.rows.dict_row)
            try:
                with conn.transaction():
                    grading_result_id = write_grading_result(
                        conn,
                        result=result,
                        tenant_id=record.tenant_id,
                        actor_id=actor_id,
                        request_id=request_id,
                    )
            finally:
                conn.close()

            with self._lock:
                record.status = JobStatus.COMPLETED
                record.result = result
                record.grading_result_id = grading_result_id
                record.completed_at = time.time()

            elapsed = record.completed_at - record.submitted_at
            logger.info(
                "Grading job completed  job_id=%s  stone_id=%s  grading_result_id=%s  elapsed=%.1fs",
                record.job_id, record.stone_id, grading_result_id, elapsed,
            )

        except Exception as exc:
            tb = traceback.format_exc()
            logger.error(
                "Grading job failed  job_id=%s  stone_id=%s\n%s",
                record.job_id, record.stone_id, tb,
            )
            import time
            with self._lock:
                record.status = JobStatus.FAILED
                record.error = str(exc)
                record.completed_at = time.time()

    def shutdown(self) -> None:
        self._executor.shutdown(wait=True)
