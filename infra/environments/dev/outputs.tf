output "vpc_id" {
  value = module.networking.vpc_id
}

output "ecs_cluster_name" {
  value = module.compute.cluster_name
}

output "db_endpoint" {
  value     = module.data.db_instance_endpoint
  sensitive = true
}

output "redis_primary_endpoint" {
  value     = module.data.redis_primary_endpoint
  sensitive = true
}

output "media_bucket_name" {
  value = module.storage.media_bucket_name
}

output "kms_key_id" {
  value = module.secrets.kms_key_id
}
