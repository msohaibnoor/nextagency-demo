locals {
  name = "nextagency-demo"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
  apps = toset(["api", "worker", "web"])
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}
