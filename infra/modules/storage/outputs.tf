output "media_bucket_name" {
  value = aws_s3_bucket.media.bucket
}

output "media_bucket_arn" {
  value = aws_s3_bucket.media.arn
}

output "access_logs_bucket_name" {
  value = aws_s3_bucket.access_logs.bucket
}
