#!/usr/bin/env python3
"""
LucidCarat — Dataset Ingestion CLI (Phase 0)

Accepts a 360-degree turntable video file and a GIA/IGI certificate file,
uploads both to S3 under the per-tenant prefix convention, then creates
stone + certificate records in Postgres in "uploaded" status.

S3 key convention (mirrors infra/modules/storage/main.tf):
    tenants/<tenant_id>/<stone_id>/video/<filename>
    tenants/<tenant_id>/<stone_id>/cert/<filename>

Usage:
    python ingest.py \\
        --tenant-id <uuid> \\
        --video path/to/video.mp4 \\
        --cert  path/to/cert.pdf  \\
        --lab GIA \\
        --cert-number 2141438167 \\
        [--split training|holdout|validation] \\
        [--internal-ref "SD-2024-0042"] \\
        [--dry-run]
"""

import json
import os
import sys
import hashlib
import mimetypes
from datetime import datetime, timezone
from pathlib import Path

import click
import boto3
from botocore.exceptions import BotoCoreError, ClientError
import psycopg
from dotenv import load_dotenv
from tqdm import tqdm

load_dotenv()

# ── Config ────────────────────────────────────────────────────────────────────

S3_BUCKET   = os.environ.get("LC_S3_BUCKET",    "lucidcarat-dev-media")
S3_REGION   = os.environ.get("LC_S3_REGION",    "ap-south-1")
DATABASE_URL = os.environ.get("LC_DATABASE_URL", "postgresql://urvilkargathala@localhost/lucidcarat_dev")

VALID_LABS  = ("GIA", "IGI", "HRD", "AGS", "other")
VALID_SPLITS = ("training", "holdout", "validation")

# ── S3 helpers ────────────────────────────────────────────────────────────────

class ProgressFileObj:
    """Wraps a file object with a tqdm progress bar for S3 uploads."""
    def __init__(self, fobj, total, label):
        self._fobj = fobj
        self._bar  = tqdm(total=total, unit="B", unit_scale=True, desc=label, leave=False)

    def read(self, n=-1):
        data = self._fobj.read(n)
        self._bar.update(len(data))
        return data

    def close(self):
        self._bar.close()
        self._fobj.close()

    def __enter__(self): return self
    def __exit__(self, *a): self.close()


def s3_key(tenant_id: str, stone_id: str, slot: str, filename: str) -> str:
    """Build an S3 object key following the per-tenant prefix convention.

    Pattern: tenants/<tenant_id>/<stone_id>/<slot>/<filename>
    Slots: video | cert | thumbnails | passport
    """
    return f"tenants/{tenant_id}/{stone_id}/{slot}/{filename}"


def upload_to_s3(
    s3_client,
    bucket: str,
    key: str,
    filepath: Path,
    extra_tags: dict[str, str],
    dry_run: bool,
) -> str:
    """Upload a file to S3, returning the full S3 key."""
    if dry_run:
        click.echo(f"  [dry-run] Would upload {filepath.name} → s3://{bucket}/{key}")
        return key

    size = filepath.stat().st_size
    tag_str = "&".join(f"{k}={v}" for k, v in extra_tags.items())

    content_type = mimetypes.guess_type(str(filepath))[0] or "application/octet-stream"

    with open(filepath, "rb") as fobj:
        wrapped = ProgressFileObj(fobj, total=size, label=filepath.name)
        s3_client.upload_fileobj(
            wrapped,
            bucket,
            key,
            ExtraArgs={
                "ContentType": content_type,
                "Tagging": tag_str,
                "ServerSideEncryption": "aws:kms",
            },
        )

    click.echo(f"  ✓ Uploaded → s3://{bucket}/{key}")
    return key


# ── Postgres helpers ──────────────────────────────────────────────────────────

def resolve_tenant(conn, tenant_id: str) -> dict:
    row = conn.execute(
        "SELECT id, name, slug, is_active FROM tenants WHERE id = %s",
        (tenant_id,),
    ).fetchone()
    if row is None:
        raise click.ClickException(f"Tenant {tenant_id!r} not found in database.")
    if not row["is_active"]:
        raise click.ClickException(f"Tenant {tenant_id!r} is inactive.")
    return dict(row)


def insert_stone(conn, tenant_id: str, stone_id: str, *, internal_ref, dataset_split, dataset_notes, video_s3_key, cert_s3_key, dry_run) -> str:
    if dry_run:
        click.echo(f"  [dry-run] Would INSERT stone id={stone_id} status=uploaded dataset_split={dataset_split}")
        return stone_id

    conn.execute(
        """
        INSERT INTO stones (
            id, tenant_id, status,
            internal_ref, dataset_split, dataset_notes,
            video_s3_key, cert_s3_key
        ) VALUES (
            %(id)s, %(tenant_id)s, 'uploaded',
            %(internal_ref)s, %(dataset_split)s, %(dataset_notes)s,
            %(video_s3_key)s, %(cert_s3_key)s
        )
        """,
        dict(
            id=stone_id,
            tenant_id=tenant_id,
            internal_ref=internal_ref,
            dataset_split=dataset_split,
            dataset_notes=dataset_notes,
            video_s3_key=video_s3_key,
            cert_s3_key=cert_s3_key,
        ),
    )
    click.echo(f"  ✓ Stone inserted  id={stone_id}  status=uploaded  split={dataset_split}")
    return stone_id


def insert_certificate(conn, cert_id: str, stone_id: str, tenant_id: str, *, lab, cert_number, cert_s3_key, dry_run):
    if dry_run:
        click.echo(f"  [dry-run] Would INSERT certificate lab={lab} cert_number={cert_number}")
        return

    # carat_weight is intentionally NULL here — the cert parsing service
    # populates it after reading the PDF/JSON (V011 makes the column nullable).
    conn.execute(
        """
        INSERT INTO certificates (
            id, stone_id, tenant_id,
            lab, cert_number,
            cert_s3_key,
            raw_parsed
        ) VALUES (
            %(id)s, %(stone_id)s, %(tenant_id)s,
            %(lab)s, %(cert_number)s,
            %(cert_s3_key)s,
            '{}'::jsonb
        )
        """,
        dict(
            id=cert_id,
            stone_id=stone_id,
            tenant_id=tenant_id,
            lab=lab,
            cert_number=cert_number,
            cert_s3_key=cert_s3_key,
        ),
    )
    click.echo(f"  ✓ Certificate inserted  lab={lab}  cert_number={cert_number}")


def insert_provenance_event(conn, stone_id: str, tenant_id: str, event_type: str, payload: dict, dry_run: bool):
    if dry_run:
        click.echo(f"  [dry-run] Would INSERT provenance_event type={event_type}")
        return

    conn.execute(
        """
        INSERT INTO provenance_events (occurred_at, stone_id, tenant_id, event_type, payload)
        VALUES (NOW(), %s, %s, %s, %s)
        """,
        (stone_id, tenant_id, event_type, json.dumps(payload)),
    )


def insert_audit_event(conn, tenant_id: str, event_type: str, entity_id: str, payload: dict, dry_run: bool):
    if dry_run:
        return

    conn.execute(
        """
        INSERT INTO audit_log (tenant_id, event_type, entity_type, entity_id, payload)
        VALUES (%s, %s, 'stone', %s, %s)
        """,
        (tenant_id, event_type, entity_id, json.dumps(payload)),
    )


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ── CLI ───────────────────────────────────────────────────────────────────────

@click.command()
@click.option("--tenant-id",    required=True,  help="UUID of the tenant (diamond house)")
@click.option("--video",        required=True,  type=click.Path(exists=True, dir_okay=False), help="360° turntable video file")
@click.option("--cert",         required=True,  type=click.Path(exists=True, dir_okay=False), help="GIA/IGI certificate file (PDF or JSON)")
@click.option("--lab",          required=True,  type=click.Choice(VALID_LABS), help="Certifying laboratory")
@click.option("--cert-number",  required=True,  help="Certificate number as printed on the cert")
@click.option("--split",        default="training", type=click.Choice(VALID_SPLITS), show_default=True, help="Dataset split assignment")
@click.option("--internal-ref", default=None,   help="Tenant's own reference code for this stone")
@click.option("--notes",        default=None,   help="Free-text notes for this ingestion")
@click.option("--dry-run",      is_flag=True,   help="Print what would happen without writing anything")
@click.option("--s3-bucket",    default=None,   help=f"Override S3 bucket (default: {S3_BUCKET})")
@click.option("--db-url",       default=None,   help="Override Postgres URL (default: LC_DATABASE_URL env)")
def ingest(tenant_id, video, cert, lab, cert_number, split, internal_ref, notes, dry_run, s3_bucket, db_url):
    """
    Ingest a 360° video + lab cert pair into LucidCarat for dataset labeling.

    Creates a stone record in 'uploaded' status, uploads both files to S3
    under the per-tenant prefix, and appends two provenance events.

    To ingest a test pair against the local dev DB without S3:
        LC_DATABASE_URL=postgresql://... python ingest.py \\
            --tenant-id <uuid> --video test.mp4 --cert test.pdf \\
            --lab GIA --cert-number 1234567890 --dry-run
    """
    bucket  = s3_bucket or S3_BUCKET
    db_dsn  = db_url    or DATABASE_URL
    video_p = Path(video)
    cert_p  = Path(cert)

    if dry_run:
        click.secho("── DRY RUN — nothing will be written ──", fg="yellow", bold=True)

    click.echo(f"\nIngesting stone for tenant {tenant_id}")
    click.echo(f"  Video : {video_p}  ({video_p.stat().st_size / 1024:.1f} KB)")
    click.echo(f"  Cert  : {cert_p}   ({cert_p.stat().st_size / 1024:.1f} KB)")
    click.echo(f"  Lab   : {lab}  Cert# {cert_number}")
    click.echo(f"  Split : {split}")

    # Generate stable IDs for this stone and cert
    import uuid
    stone_id = str(uuid.uuid4())
    cert_id   = str(uuid.uuid4())

    # S3 keys
    video_key = s3_key(tenant_id, stone_id, "video", video_p.name)
    cert_key  = s3_key(tenant_id, stone_id, "cert",  cert_p.name)

    # S3 object tags — these are searchable in the AWS console and usable in
    # S3 Inventory / S3 Batch Operations for dataset management.
    common_tags = {
        "Project":      "LucidCarat",
        "TenantId":     tenant_id,
        "StoneId":      stone_id,
        "DatasetSplit": split,
        "CertLab":      lab,
        "CertNumber":   cert_number,
        "IngestedAt":   datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    # ── Step 1: Upload to S3 ──────────────────────────────────────────────────
    click.echo("\n[1/3] Uploading to S3 ...")

    if dry_run:
        s3 = None
    else:
        s3 = boto3.client("s3", region_name=S3_REGION)

    try:
        video_sha = sha256_file(video_p)
        cert_sha  = sha256_file(cert_p)

        upload_to_s3(s3, bucket, video_key, video_p,
                     {**common_tags, "FileType": "video", "SHA256": video_sha}, dry_run)
        upload_to_s3(s3, bucket, cert_key, cert_p,
                     {**common_tags, "FileType": "cert",  "SHA256": cert_sha},  dry_run)
    except (BotoCoreError, ClientError) as exc:
        raise click.ClickException(f"S3 upload failed: {exc}") from exc

    # ── Step 2: Write to Postgres ─────────────────────────────────────────────
    click.echo("\n[2/3] Writing to Postgres ...")

    if dry_run:
        click.echo(f"  [dry-run] Would resolve tenant {tenant_id}")
        click.echo(f"  [dry-run] Would INSERT stone   id={stone_id}  status=uploaded  split={split}")
        click.echo(f"  [dry-run] Would INSERT certificate lab={lab} cert_number={cert_number}")
        click.echo(f"  [dry-run] Would INSERT provenance_events: video_uploaded, cert_ingested")
        click.echo(f"  [dry-run] Would INSERT audit_log:         stone_uploaded")
    else:
        try:
            with psycopg.connect(db_dsn, row_factory=psycopg.rows.dict_row) as conn:
                # Wrap everything in one transaction — either all succeeds or nothing.
                with conn.transaction():
                    tenant = resolve_tenant(conn, tenant_id)

                    insert_stone(
                        conn, tenant_id, stone_id,
                        internal_ref=internal_ref,
                        dataset_split=split,
                        dataset_notes=notes,
                        video_s3_key=video_key,
                        cert_s3_key=cert_key,
                        dry_run=False,
                    )

                    insert_certificate(
                        conn, cert_id, stone_id, tenant_id,
                        lab=lab,
                        cert_number=cert_number,
                        cert_s3_key=cert_key,
                        dry_run=False,
                    )

                    insert_provenance_event(conn, stone_id, tenant_id, "video_uploaded",
                        {"s3_key": video_key, "sha256": video_sha, "filename": video_p.name}, False)

                    insert_provenance_event(conn, stone_id, tenant_id, "cert_ingested",
                        {"s3_key": cert_key, "sha256": cert_sha, "lab": lab,
                         "cert_number": cert_number, "filename": cert_p.name}, False)

                    insert_audit_event(conn, tenant_id, "stone_uploaded", stone_id,
                        {"stone_id": stone_id, "cert_number": cert_number, "dataset_split": split,
                         "video_s3_key": video_key, "cert_s3_key": cert_key}, False)

        except psycopg.Error as exc:
            raise click.ClickException(f"Database write failed: {exc}") from exc

    # ── Step 3: Summary ───────────────────────────────────────────────────────
    click.echo("\n[3/3] Done.")
    click.secho("\n── Ingestion summary ─────────────────────────────────────────", bold=True)
    click.echo(f"  stone_id      : {stone_id}")
    click.echo(f"  cert_id       : {cert_id}")
    click.echo(f"  tenant_id     : {tenant_id}")
    click.echo(f"  status        : uploaded")
    click.echo(f"  dataset_split : {split}")
    click.echo(f"  video s3 key  : {video_key}")
    click.echo(f"  cert  s3 key  : {cert_key}")
    if not dry_run:
        click.echo(f"  video sha256  : {video_sha}")
        click.echo(f"  cert  sha256  : {cert_sha}")
    click.secho("\nNext step: trigger grading pipeline with stone_id above.", fg="green")


if __name__ == "__main__":
    ingest()
