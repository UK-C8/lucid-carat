################################################################################
# Module: secrets
# AWS Secrets Manager placeholders for every credential LucidCarat needs.
#
# Pattern:
#   - Each secret is created here as an empty shell (or with a placeholder).
#   - Real values are populated via the AWS Console, CLI, or a CI/CD bootstrap
#     script — NEVER committed to the repository.
#   - ECS task definitions reference secrets by ARN (see compute module).
#   - KMS encryption key is created here and shared across data/storage modules.
#
# Secret naming: lucidcarat/<environment>/<service>/<purpose>
################################################################################

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

# ── KMS key for encrypting secrets and RDS/S3 ─────────────────────────────────

resource "aws_kms_key" "main" {
  description             = "LucidCarat ${var.environment} — master encryption key"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = merge(var.tags, { Name = "${var.name_prefix}-kms" })
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.name_prefix}"
  target_key_id = aws_kms_key.main.key_id
}

# ── Database credentials ───────────────────────────────────────────────────────

resource "aws_secretsmanager_secret" "db" {
  name        = "${var.name_prefix}/db/credentials"
  description = "RDS Postgres credentials and connection URL"
  kms_key_id  = aws_kms_key.main.arn
  tags        = merge(var.tags, { Service = "db" })

  # Prevent accidental deletion in production
  recovery_window_in_days = var.environment == "prod" ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "db_placeholder" {
  secret_id = aws_secretsmanager_secret.db.id
  # Placeholder — replace with real credentials before first apply against a live DB.
  # Format expected by ECS task: {"url": "postgresql://user:pass@host:5432/dbname"}
  secret_string = jsonencode({
    url      = "REPLACE_ME"
    host     = "REPLACE_ME"
    port     = 5432
    dbname   = "lucidcarat"
    username = "REPLACE_ME"
    password = "REPLACE_ME"
  })

  lifecycle { ignore_changes = [secret_string] }
}

# ── Redis auth token ───────────────────────────────────────────────────────────

resource "aws_secretsmanager_secret" "redis" {
  name        = "${var.name_prefix}/redis/credentials"
  description = "ElastiCache Redis auth token and connection URL"
  kms_key_id  = aws_kms_key.main.arn
  tags        = merge(var.tags, { Service = "redis" })

  recovery_window_in_days = var.environment == "prod" ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "redis_placeholder" {
  secret_id = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    url        = "REPLACE_ME"
    auth_token = "REPLACE_ME"
  })

  lifecycle { ignore_changes = [secret_string] }
}

# ── S3 / media metadata (bucket name surfaced to app at runtime) ───────────────

resource "aws_secretsmanager_secret" "media" {
  name        = "${var.name_prefix}/media/config"
  description = "S3 media bucket name and region for runtime config"
  kms_key_id  = aws_kms_key.main.arn
  tags        = merge(var.tags, { Service = "media" })

  recovery_window_in_days = var.environment == "prod" ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "media_placeholder" {
  secret_id = aws_secretsmanager_secret.media.id
  secret_string = jsonencode({
    bucket_name = var.media_bucket_name
    region      = var.aws_region
  })

  lifecycle { ignore_changes = [secret_string] }
}

# ── Stripe billing ─────────────────────────────────────────────────────────────

resource "aws_secretsmanager_secret" "stripe" {
  name        = "${var.name_prefix}/stripe/api-keys"
  description = "Stripe secret key and webhook signing secret"
  kms_key_id  = aws_kms_key.main.arn
  tags        = merge(var.tags, { Service = "billing" })

  recovery_window_in_days = var.environment == "prod" ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "stripe_placeholder" {
  secret_id = aws_secretsmanager_secret.stripe.id
  secret_string = jsonencode({
    secret_key              = "REPLACE_ME"
    webhook_signing_secret  = "REPLACE_ME"
    publishable_key         = "REPLACE_ME"
  })

  lifecycle { ignore_changes = [secret_string] }
}

# ── Polygon / blockchain anchor (optional — gracefully disabled when empty) ─────

resource "aws_secretsmanager_secret" "polygon" {
  name        = "${var.name_prefix}/polygon/wallet"
  description = "Polygon RPC URL and wallet private key for optional Passport anchoring"
  kms_key_id  = aws_kms_key.main.arn
  tags        = merge(var.tags, { Service = "polygon", Optional = "true" })

  recovery_window_in_days = var.environment == "prod" ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "polygon_placeholder" {
  secret_id = aws_secretsmanager_secret.polygon.id
  secret_string = jsonencode({
    rpc_url     = "REPLACE_ME_OR_LEAVE_EMPTY_TO_DISABLE"
    private_key = "REPLACE_ME_OR_LEAVE_EMPTY_TO_DISABLE"
  })

  lifecycle { ignore_changes = [secret_string] }
}

# ── Internal service-to-service signing key (JWT / HMAC) ──────────────────────

resource "aws_secretsmanager_secret" "internal_jwt" {
  name        = "${var.name_prefix}/internal/jwt-secret"
  description = "JWT signing secret for inter-service auth and session tokens"
  kms_key_id  = aws_kms_key.main.arn
  tags        = merge(var.tags, { Service = "auth" })

  recovery_window_in_days = var.environment == "prod" ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "internal_jwt_placeholder" {
  secret_id = aws_secretsmanager_secret.internal_jwt.id
  secret_string = jsonencode({ secret = "REPLACE_ME" })

  lifecycle { ignore_changes = [secret_string] }
}
