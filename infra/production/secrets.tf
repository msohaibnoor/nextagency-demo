resource "aws_secretsmanager_secret" "redis_url" {
  name                    = "${local.name}/production/redis-url"
  recovery_window_in_days = 0 # demo: allow immediate re-create after destroy
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id     = aws_secretsmanager_secret.redis_url.id
  secret_string = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
}
