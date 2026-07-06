variable "name_prefix" {
  type = string
}

variable "environment" {
  type = string
}

variable "aws_region" {
  type = string
}

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

variable "web_cpu" {
  type    = number
  default = 512
}

variable "web_memory" {
  type    = number
  default = 1024
}

# Grading runs PyTorch inference — needs more headroom
variable "grading_cpu" {
  type    = number
  default = 2048
}

variable "grading_memory" {
  type    = number
  default = 4096
}

variable "pricing_cpu" {
  type    = number
  default = 1024
}

variable "pricing_memory" {
  type    = number
  default = 2048
}

variable "media_bucket_name" {
  type = string
}

variable "db_secret_arn" {
  type = string
}

variable "redis_secret_arn" {
  type = string
}

variable "media_secret_arn" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
