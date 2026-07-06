variable "environment" {
  type    = string
  default = "dev"
}

variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "availability_zones" {
  type    = list(string)
  default = ["ap-south-1a", "ap-south-1b"]
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.10.0/24", "10.0.11.0/24"]
}

variable "media_bucket_name" {
  type    = string
  default = "lucidcarat-dev-media"
}

variable "cors_allowed_origins" {
  type    = list(string)
  default = ["http://localhost:3000", "https://dev.lucidcarat.com"]
}

# ── RDS ────────────────────────────────────────────────────────────────────────

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_name" {
  type    = string
  default = "lucidcarat"
}

variable "db_username" {
  type    = string
  default = "lcadmin"
}

variable "db_password" {
  description = "RDS master password — provide via TF_VAR_db_password env var or -var flag. Never hardcode."
  type        = string
  sensitive   = true
}

# ── Redis ──────────────────────────────────────────────────────────────────────

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "redis_auth_token" {
  description = "ElastiCache Redis auth token — provide via TF_VAR_redis_auth_token. Never hardcode."
  type        = string
  sensitive   = true
}

# ── Container images (CI/CD overrides these) ───────────────────────────────────

variable "web_image_uri" {
  type    = string
  default = "public.ecr.aws/docker/library/node:20-alpine"
}

variable "grading_image_uri" {
  type    = string
  default = "public.ecr.aws/docker/library/python:3.11-slim"
}

variable "pricing_image_uri" {
  type    = string
  default = "public.ecr.aws/docker/library/python:3.11-slim"
}
