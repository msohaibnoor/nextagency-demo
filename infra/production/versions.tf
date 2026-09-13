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

provider "aws" {
  region  = var.region
  profile = var.aws_profile
  default_tags {
    tags = {
      Project     = "nextagency-demo"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}
