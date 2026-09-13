output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "service_names" {
  value = { for k, s in aws_ecs_service.app : k => s.name }
}

output "ecr_repository_urls" {
  value = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}

output "github_deploy_role_arn" {
  value = aws_iam_role.github_deploy.arn
}

output "redis_secret_arn" {
  value = aws_secretsmanager_secret.redis_url.arn
}
