terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true

  endpoints {
    s3 = var.localstack_endpoint
  }
}

resource "aws_s3_bucket" "dead_letter" {
  bucket        = "gridwatch-dead-letter"
  force_destroy = true
}

output "bucket_name" {
  value = aws_s3_bucket.dead_letter.bucket
}
