################################################################################
# Module: data
# RDS Postgres 15 with TimescaleDB extension + ElastiCache Redis 7.
#
# TimescaleDB note: AWS RDS does not provide a managed TimescaleDB engine.
# The standard pattern is to use RDS Postgres and then install the extension
# via "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;" in a migration.
# Parameter group enables the shared_preload_libraries entry required by
# TimescaleDB — this must be set BEFORE the extension is created.
################################################################################

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

# ── RDS subnet group ───────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "main" {
  name        = "${var.name_prefix}-rds-subnet-group"
  description = "Private subnets for RDS Postgres"
  subnet_ids  = var.private_subnet_ids
  tags        = merge(var.tags, { Name = "${var.name_prefix}-rds-subnet-group" })
}

# ── RDS parameter group — enables TimescaleDB shared_preload_libraries ─────────

resource "aws_db_parameter_group" "postgres15_timescale" {
  name        = "${var.name_prefix}-pg15-timescale"
  family      = "postgres15"
  description = "Postgres 15 with timescaledb in shared_preload_libraries"

  parameter {
    name  = "shared_preload_libraries"
    value = "timescaledb"
    # static parameter — requires a reboot after creation
    apply_method = "pending-reboot"
  }

  tags = var.tags
}

# ── RDS Postgres 15 ────────────────────────────────────────────────────────────

resource "aws_db_instance" "postgres" {
  identifier = "${var.name_prefix}-postgres"

  engine         = "postgres"
  engine_version = "15.6"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn  # null → AWS-managed key

  db_name  = var.db_name
  username = var.db_username
  # Password injected from Secrets Manager at apply time — never a literal value
  password = var.db_password

  parameter_group_name   = aws_db_parameter_group.postgres15_timescale.name
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.sg_rds_id]

  multi_az               = var.multi_az
  publicly_accessible    = false
  deletion_protection    = var.deletion_protection
  skip_final_snapshot    = !var.deletion_protection
  final_snapshot_identifier = var.deletion_protection ? "${var.name_prefix}-postgres-final" : null

  backup_retention_period = 7
  backup_window           = "02:00-03:00"
  maintenance_window      = "Mon:03:00-Mon:04:00"

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = merge(var.tags, { Name = "${var.name_prefix}-postgres" })
}

# ── ElastiCache subnet group ───────────────────────────────────────────────────

resource "aws_elasticache_subnet_group" "main" {
  name        = "${var.name_prefix}-redis-subnet-group"
  description = "Private subnets for ElastiCache Redis"
  subnet_ids  = var.private_subnet_ids
  tags        = merge(var.tags, { Name = "${var.name_prefix}-redis-subnet-group" })
}

# ── ElastiCache Redis 7 (cluster mode disabled for simplicity in skeleton) ─────

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${var.name_prefix}-redis"
  description          = "LucidCarat Redis — queue, cache, sessions"

  node_type            = var.redis_node_type
  num_cache_clusters   = var.redis_num_replicas + 1  # primary + replicas
  parameter_group_name = "default.redis7"
  engine_version       = "7.1"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [var.sg_redis_id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.redis_auth_token  # from Secrets Manager, never hardcoded

  automatic_failover_enabled = var.redis_num_replicas > 0
  multi_az_enabled           = var.redis_num_replicas > 0

  snapshot_retention_limit = 3
  snapshot_window          = "03:00-04:00"

  tags = merge(var.tags, { Name = "${var.name_prefix}-redis" })
}
