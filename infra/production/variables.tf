variable "region" {
  type    = string
  default = "us-east-1"
}

variable "aws_profile" {
  type    = string
  default = "personal"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "image_tag" {
  type    = string
  default = "bootstrap"
}

variable "github_repo" {
  type        = string
  description = "owner/repo, e.g. msohaibnoor/nextagency-demo"
}

variable "github_branch" {
  type    = string
  default = "main"
}

variable "task_cpu" {
  type    = number
  default = 256
}

variable "task_memory" {
  type    = number
  default = 512
}

variable "github_oidc_provider_arn" {
  type        = string
  description = "from bootstrap output"
}
