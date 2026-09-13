resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ---------- ALB ----------
resource "aws_lb" "this" {
  name               = local.name
  load_balancer_type = "application"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id
  health_check {
    # /healthz is a static Next.js route that never calls the api, so a web
    # task is not condemned while api is mid-rollout (`/` fetches /api/jobs/stats).
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 10
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 4000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id
  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 10
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }
}

# ---------- Task definitions ----------
locals {
  common_env = { NODE_ENV = "production" }
  container = {
    api = {
      port         = 4000
      env          = merge(local.common_env, { PORT = "4000" })
      secrets      = [{ name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn }]
      stop_timeout = 30
    }
    worker = {
      port         = null
      env          = local.common_env
      secrets      = [{ name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn }]
      stop_timeout = 60 # let in-flight jobs finish on deploy
    }
    web = {
      port         = 3000
      env          = merge(local.common_env, { PORT = "3000", HOSTNAME = "0.0.0.0", API_URL = "http://${aws_lb.this.dns_name}" })
      secrets      = []
      stop_timeout = 30
    }
  }
}

resource "aws_ecs_task_definition" "app" {
  for_each                 = local.apps
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name         = each.key
    image        = "${aws_ecr_repository.app[each.key].repository_url}:${var.image_tag}"
    essential    = true
    stopTimeout  = local.container[each.key].stop_timeout
    portMappings = local.container[each.key].port == null ? [] : [{ containerPort = local.container[each.key].port, protocol = "tcp" }]
    environment  = [for k, v in local.container[each.key].env : { name = k, value = v }]
    secrets      = local.container[each.key].secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])
}

# ---------- Services ----------
resource "aws_ecs_service" "app" {
  for_each               = local.apps
  name                   = each.key
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.app[each.key].arn
  desired_count          = 1
  launch_type            = "FARGATE"
  enable_execute_command = true
  # Tasks carry no tags by default, so Fargate spend is invisible under the
  # Project cost-allocation tag. Copy the service's tags (default_tags) onto
  # every task it launches, and let ECS add its own aws:ecs:* tags.
  propagate_tags          = "SERVICE"
  enable_ecs_managed_tags = true

  network_configuration {
    subnets          = aws_subnet.private_app[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  health_check_grace_period_seconds = each.key == "worker" ? null : 60

  dynamic "load_balancer" {
    for_each = each.key == "worker" ? [] : [each.key]
    content {
      target_group_arn = each.key == "web" ? aws_lb_target_group.web.arn : aws_lb_target_group.api.arn
      container_name   = each.key
      container_port   = local.container[each.key].port
    }
  }

  depends_on = [
    aws_lb_listener.http,
    aws_lb_listener_rule.api,
    aws_iam_role_policy.execution_secrets,
    aws_iam_role_policy_attachment.execution_managed,
    aws_secretsmanager_secret_version.redis_url, # the task's REDIS_URL must have an AWSCURRENT value before the first launch
  ]

  lifecycle { ignore_changes = [task_definition] } # app deploys register new revisions outside Terraform
}
