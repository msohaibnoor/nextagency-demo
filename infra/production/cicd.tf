locals {
  github_owner = split("/", var.github_repo)[0]
  github_name  = split("/", var.github_repo)[1]
  # GitHub's OIDC `sub` is, since 2026, `repo:owner@<ownerId>/name@<repoId>:ref:…`
  # (observed in CloudTrail; ids in variables.tf). Pinning both numeric ids is
  # what makes the match strong: names can be renamed and re-registered by
  # someone else, ids cannot. The classic `repo:owner/name:ref:…` form is kept
  # second in case a token is ever minted in the old shape. IAM `*` would match
  # anything in that segment, which is why the earlier `owner@*/name@*` bridge
  # was no stronger than the name-only form.
  github_subs = [
    "repo:${local.github_owner}@${var.github_owner_id}/${local.github_name}@${var.github_repo_id}:ref:refs/heads/${var.github_branch}",
    "repo:${var.github_repo}:ref:refs/heads/${var.github_branch}",
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

# Deliberately no S3/DynamoDB (Terraform state) access: the state file holds
# the Redis auth token in plaintext. deploy.sh derives what it needs from the
# account id, fixed names and DescribeLoadBalancers instead of `terraform output`.
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
      # PassRole is what lets RegisterTaskDefinition + UpdateService run code as
      # the execution/task roles; the condition stops the same grant being used
      # to hand those roles to any other service.
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.execution.arn, aws_iam_role.task.arn],
      Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } },
      # deploy.sh resolves the ALB DNS name for its final "done" line
      # (sts:GetCallerIdentity needs no policy).
      { Effect = "Allow", Action = ["elasticloadbalancing:DescribeLoadBalancers"], Resource = "*" },
    ]
  })
}
