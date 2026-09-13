variable "region" {
  type    = string
  default = "us-east-1"
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

# Numeric GitHub ids embedded in the OIDC `sub` claim (`repo:owner@<id>/name@<id>:ref:…`),
# read from CloudTrail's AssumeRoleWithWebIdentity event for this repo.
variable "github_owner_id" {
  type    = string
  default = "73883272"
}

variable "github_repo_id" {
  type    = string
  default = "1367206627"
}
