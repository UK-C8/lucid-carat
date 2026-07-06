output "kms_key_arn" {
  value = aws_kms_key.main.arn
}

output "kms_key_id" {
  value = aws_kms_key.main.key_id
}

output "db_secret_arn" {
  value = aws_secretsmanager_secret.db.arn
}

output "redis_secret_arn" {
  value = aws_secretsmanager_secret.redis.arn
}

output "media_secret_arn" {
  value = aws_secretsmanager_secret.media.arn
}

output "stripe_secret_arn" {
  value = aws_secretsmanager_secret.stripe.arn
}

output "polygon_secret_arn" {
  value = aws_secretsmanager_secret.polygon.arn
}

output "internal_jwt_secret_arn" {
  value = aws_secretsmanager_secret.internal_jwt.arn
}
