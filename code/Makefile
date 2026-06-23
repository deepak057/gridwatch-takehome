up:
	docker compose up --build

test:
	npm test

down:
	docker compose down -v

iac:
	docker compose -f docker-compose.localstack.yml up -d --wait --wait-timeout 120
	docker run --rm \
		--network localstack-net \
		-v "$(CURDIR)/infra:/infra" \
		-w /infra \
		hashicorp/terraform:latest \
		init -input=false
	docker run --rm \
		--network localstack-net \
		-v "$(CURDIR)/infra:/infra" \
		-w /infra \
		hashicorp/terraform:latest \
		apply -auto-approve -input=false
	@echo ""
	@echo "=== Bucket list (via LocalStack) ==="
	docker compose -f docker-compose.localstack.yml exec -T localstack awslocal s3 ls

iac-down:
	docker compose -f docker-compose.localstack.yml down -v
