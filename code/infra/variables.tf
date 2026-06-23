variable "localstack_endpoint" {
  description = "LocalStack endpoint URL (reachable from within the Terraform container)"
  type        = string
  default     = "http://localstack:4566"
}
