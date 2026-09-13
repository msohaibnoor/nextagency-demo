locals {
  github_owner = split("/", var.github_repo)[0]
  github_name  = split("/", var.github_repo)[1]
  # GitHub's OIDC `sub` may be the classic `repo:owner/name:ref:…` or, since 2026, `repo:owner@<id>/name@<id>:ref:…`.
  github_subs = [
    "repo:${var.github_repo}:ref:refs/heads/${var.github_branch}",
    "repo:${local.github_owner}@*/${local.github_name}@*:ref:refs/heads/${var.github_branch}",
  ]
}

resource "aws_iam_role" "github_deploy" {
  name = "${local.name}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = var.github_oidc_provider_arn }
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = local.github_subs }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  name = "deploy"
  role = aws_iam_role.github_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow",
        Action = ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      Resource = [for r in aws_ecr_repository.app : r.arn] },
      { Effect = "Allow", Action = ["ecs:UpdateService", "ecs:DescribeServices"], Resource = [for s in aws_ecs_service.app : s.id] },
      { Effect = "Allow", Action = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"], Resource = "*" },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.execution.arn, aws_iam_role.task.arn] },
      {
        # deploy.sh runs `terraform output` from infra/production, which reads the
        # S3-backed state and briefly locks it via DynamoDB. GetBucketVersioning is
        # added alongside ListBucket because Terraform's S3 backend calls it on init.
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:ListBucket", "s3:GetBucketVersioning"]
        Resource = [
          "arn:aws:s3:::nextagency-demo-tfstate-${data.aws_caller_identity.current.account_id}",
          "arn:aws:s3:::nextagency-demo-tfstate-${data.aws_caller_identity.current.account_id}/production/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:DescribeTable"]
        Resource = "arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/nextagency-demo-tflock"
      }
    ]
  })
}
