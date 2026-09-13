terraform {
  required_version = ">= 1.9"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.80" } }
}
provider "aws" {
  region  = var.region
  profile = var.aws_profile
  default_tags { tags = { Project = "nextagency-demo", Environment = "bootstrap", ManagedBy = "terraform" } }
}
