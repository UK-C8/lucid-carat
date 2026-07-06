variable "name_prefix" {
  type = string
}

variable "media_bucket_name" {
  type = string
}

variable "kms_key_arn" {
  type    = string
  default = null
}

variable "cors_allowed_origins" {
  type    = list(string)
  default = ["https://*.lucidcarat.com"]
}

variable "tags" {
  type    = map(string)
  default = {}
}
