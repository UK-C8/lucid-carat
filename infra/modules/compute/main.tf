################################################################################
# Module: compute
# ECS/Fargate cluster + per-service task definitions (image URIs filled later).
# Services: web (Next.js), grading (FastAPI/PyTorch), pricing (FastAPI/XGBoost).
################################################################################

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

# ── ECS Cluster ────────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = "${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-cluster" })
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# ── IAM: task execution role (pull images, write CloudWatch logs) ──────────────

resource "aws_iam_role" "ecs_task_execution" {
  name = "${var.name_prefix}-ecs-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow reading secrets from Secrets Manager during container startup
resource "aws_iam_role_policy" "ecs_secrets_read" {
  name = "${var.name_prefix}-ecs-secrets-read"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = ["arn:aws:secretsmanager:${var.aws_region}:*:secret:${var.name_prefix}/*"]
    }]
  })
}

# ── IAM: task role (runtime permissions — S3 access, etc.) ───────────────────

resource "aws_iam_role" "ecs_task" {
  name = "${var.name_prefix}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "ecs_task_s3" {
  name = "${var.name_prefix}-ecs-task-s3"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ]
      Resource = [
        "arn:aws:s3:::${var.media_bucket_name}",
        "arn:aws:s3:::${var.media_bucket_name}/*"
      ]
    }]
  })
}

# ── CloudWatch log groups ──────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${var.name_prefix}/web"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "grading" {
  name              = "/ecs/${var.name_prefix}/grading"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "pricing" {
  name              = "/ecs/${var.name_prefix}/pricing"
  retention_in_days = 30
  tags              = var.tags
}

# ── Task Definitions (image URIs are placeholders — filled in CI/CD) ──────────

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name_prefix}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "web"
    image     = var.web_image_uri   # e.g. <account>.dkr.ecr.ap-south-1.amazonaws.com/lucidcarat-web:latest
    essential = true
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = var.environment }
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = "${var.db_secret_arn}:url::" },
      { name = "REDIS_URL",    valueFrom = "${var.redis_secret_arn}:url::" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.web.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "web"
      }
    }
  }])

  tags = var.tags
}

resource "aws_ecs_task_definition" "grading" {
  family                   = "${var.name_prefix}-grading"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.grading_cpu
  memory                   = var.grading_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "grading"
    image     = var.grading_image_uri
    essential = true
    portMappings = [{ containerPort = 8001, protocol = "tcp" }]
    environment = [
      { name = "ENV", value = var.environment }
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = "${var.db_secret_arn}:url::" },
      { name = "REDIS_URL",    valueFrom = "${var.redis_secret_arn}:url::" },
      { name = "S3_BUCKET",    valueFrom = "${var.media_secret_arn}:bucket_name::" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.grading.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "grading"
      }
    }
  }])

  tags = var.tags
}

resource "aws_ecs_task_definition" "pricing" {
  family                   = "${var.name_prefix}-pricing"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.pricing_cpu
  memory                   = var.pricing_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "pricing"
    image     = var.pricing_image_uri
    essential = true
    portMappings = [{ containerPort = 8002, protocol = "tcp" }]
    environment = [
      { name = "ENV", value = var.environment }
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = "${var.db_secret_arn}:url::" },
      { name = "REDIS_URL",    valueFrom = "${var.redis_secret_arn}:url::" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.pricing.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "pricing"
      }
    }
  }])

  tags = var.tags
}
