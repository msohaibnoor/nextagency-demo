resource "aws_cloudwatch_log_group" "app" {
  for_each          = local.apps
  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = 7
}
