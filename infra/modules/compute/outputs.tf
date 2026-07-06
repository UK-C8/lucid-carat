output "cluster_arn" {
  value = aws_ecs_cluster.main.arn
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "task_execution_role_arn" {
  value = aws_iam_role.ecs_task_execution.arn
}

output "task_role_arn" {
  value = aws_iam_role.ecs_task.arn
}

output "web_task_definition_arn" {
  value = aws_ecs_task_definition.web.arn
}

output "grading_task_definition_arn" {
  value = aws_ecs_task_definition.grading.arn
}

output "pricing_task_definition_arn" {
  value = aws_ecs_task_definition.pricing.arn
}
