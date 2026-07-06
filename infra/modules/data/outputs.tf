output "db_instance_endpoint" {
  value = aws_db_instance.postgres.endpoint
}

output "db_instance_id" {
  value = aws_db_instance.postgres.id
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "redis_reader_endpoint" {
  value = aws_elasticache_replication_group.redis.reader_endpoint_address
}
