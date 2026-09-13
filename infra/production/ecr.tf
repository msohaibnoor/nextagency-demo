resource "aws_ecr_repository" "app" {
  for_each             = local.apps
  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "MUTABLE" # we move :latest
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = local.apps
  repository = aws_ecr_repository.app[each.key].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 10"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
