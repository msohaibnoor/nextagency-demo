terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  backend "s3" {
    bucket         = "nextagency-demo-tfstate-472408435328"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "nextagency-demo-tflock"
    encrypt        = true
  }
}

# No `profile` here: credentials come from the environment (AWS_PROFILE locally,
# the OIDC session in CI), so the same root works in both places.
provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "nextagency-demo"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}
