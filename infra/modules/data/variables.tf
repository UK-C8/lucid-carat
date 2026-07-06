variable "name_prefix" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "sg_rds_id" {
  type = string
}

variable "sg_redis_id" {
  type = string
}

variable "kms_key_arn" {
  type    = string
  default = null
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_max_allocated_storage_gb" {
  type    = number
  default = 100
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
  type      = string
  sensitive = true
}

variable "multi_az" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "redis_num_replicas" {
  type    = number
  default = 0
}

variable "redis_auth_token" {
  type      = string
  sensitive = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
