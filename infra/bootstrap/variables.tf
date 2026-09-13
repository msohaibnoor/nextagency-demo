variable "region" {
  type    = string
  default = "us-east-1"
}
variable "aws_profile" {
  type    = string
  default = "personal"
}
variable "alert_email" {
  type = string
}
variable "state_bucket_name" {
  type        = string
  description = "Globally unique, e.g. nextagency-demo-tfstate-<accountid>"
}
