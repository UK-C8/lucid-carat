variable "name_prefix" {
  type = string
}

variable "environment" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "media_bucket_name" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
