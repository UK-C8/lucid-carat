################################################################################
# Environment: dev
# Wires all modules together for a development deployment.
# Apply with: terraform -chdir=infra/environments/dev apply
################################################################################

terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment and configure S3 backend before first team apply:
  # backend "s3" {
  #   bucket         = "lucidcarat-tfstate"
  #   key            = "dev/terraform.tfstate"
  #   region         = "ap-south-1"
  #   encrypt        = true
  #   dynamodb_table = "lucidcarat-tfstate-lock"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

locals {
  name_prefix = "lucidcarat-${var.environment}"
  common_tags = {
    Project     = "LucidCarat"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Team        = "Centr8"
  }
}

# ── Secrets first — KMS key ARN flows into data + storage ─────────────────────

module "secrets" {
  source = "../../modules/secrets"

  name_prefix       = local.name_prefix
  environment       = var.environment
  aws_region        = var.aws_region
  media_bucket_name = var.media_bucket_name
  tags              = local.common_tags
}

# ── Networking ─────────────────────────────────────────────────────────────────

module "networking" {
  source = "../../modules/networking"

  name_prefix          = local.name_prefix
  vpc_cidr             = var.vpc_cidr
  availability_zones   = var.availability_zones
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
  tags                 = local.common_tags
}

# ── Storage ────────────────────────────────────────────────────────────────────

module "storage" {
  source = "../../modules/storage"

  name_prefix          = local.name_prefix
  media_bucket_name    = var.media_bucket_name
  kms_key_arn          = module.secrets.kms_key_arn
  cors_allowed_origins = var.cors_allowed_origins
  tags                 = local.common_tags
}

# ── Data (RDS + Redis) ─────────────────────────────────────────────────────────

module "data" {
  source = "../../modules/data"

  name_prefix        = local.name_prefix
  private_subnet_ids = module.networking.private_subnet_ids
  sg_rds_id          = module.networking.sg_rds_id
  sg_redis_id        = module.networking.sg_redis_id
  kms_key_arn        = module.secrets.kms_key_arn

  db_instance_class   = var.db_instance_class
  db_name             = var.db_name
  db_username         = var.db_username
  db_password         = var.db_password        # sensitive var — see variables.tf
  deletion_protection = false                   # dev: no protection
  multi_az            = false                   # dev: single-AZ to reduce cost

  redis_node_type    = var.redis_node_type
  redis_num_replicas = 0                        # dev: primary only
  redis_auth_token   = var.redis_auth_token     # sensitive var

  tags = local.common_tags
}

# ── Compute (ECS/Fargate) ──────────────────────────────────────────────────────

module "compute" {
  source = "../../modules/compute"

  name_prefix  = local.name_prefix
  environment  = var.environment
  aws_region   = var.aws_region

  media_bucket_name = module.storage.media_bucket_name
  db_secret_arn     = module.secrets.db_secret_arn
  redis_secret_arn  = module.secrets.redis_secret_arn
  media_secret_arn  = module.secrets.media_secret_arn

  # Image URIs are placeholders — CI/CD pipeline overwrites these at deploy time
  web_image_uri     = var.web_image_uri
  grading_image_uri = var.grading_image_uri
  pricing_image_uri = var.pricing_image_uri

  tags = local.common_tags
}
