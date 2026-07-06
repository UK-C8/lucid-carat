################################################################################
# Module: storage
# S3 buckets for diamond media, certs, and Passport exports.
#
# Per-tenant prefix convention
# ──────────────────────────────
# All objects are stored under a tenant-scoped key prefix so that:
#   - IAM conditions can enforce tenant isolation at the S3 level
#   - CloudWatch / S3 Access Logs are filterable per tenant
#   - Future bucket policies can be tightened per-tenant if needed
#
# Key structure:
#   s3://<bucket>/tenants/<tenant_id>/<stone_id>/video/          — 360° video frames/segments
#   s3://<bucket>/tenants/<tenant_id>/<stone_id>/cert/           — GIA/IGI cert PDF/JSON
#   s3://<bucket>/tenants/<tenant_id>/<stone_id>/passport/       — Diamond Passport exports
#   s3://<bucket>/tenants/<tenant_id>/<stone_id>/thumbnails/     — preview images
#
# The application layer MUST enforce that each authenticated request only
# generates pre-signed URLs scoped to its own tenant_id prefix.
# An IAM condition on the task role further enforces this at the API level.
################################################################################

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

# ── Main media bucket (videos, certs, thumbnails, Passport exports) ────────────

resource "aws_s3_bucket" "media" {
  bucket = var.media_bucket_name
  tags   = merge(var.tags, { Name = var.media_bucket_name, Purpose = "diamond-media" })
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn != null ? "aws:kms" : "AES256"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    id     = "transition-to-ia"
    status = "Enabled"
    filter { prefix = "tenants/" }

    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = 365
      storage_class = "GLACIER"
    }
  }

  rule {
    id     = "expire-incomplete-uploads"
    status = "Enabled"
    filter { prefix = "" }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

# ── Access log bucket (separate, no server-access-logging on itself) ───────────

resource "aws_s3_bucket" "access_logs" {
  bucket = "${var.media_bucket_name}-access-logs"
  tags   = merge(var.tags, { Name = "${var.media_bucket_name}-access-logs", Purpose = "s3-access-logs" })
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    id     = "expire-logs"
    status = "Enabled"
    filter { prefix = "" }
    expiration { days = 90 }
  }
}

resource "aws_s3_bucket_logging" "media" {
  bucket        = aws_s3_bucket.media.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "media/"
}

# ── CORS for direct browser → S3 presigned-URL uploads (resumable) ────────────

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}
