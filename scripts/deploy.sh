#!/usr/bin/env bash
# Usage: scripts/deploy.sh <api|worker|web> [tag]
set -euo pipefail
APP="${1:?app name required}"
TAG="${2:-$(git rev-parse --short HEAD)}"
PROFILE_ARG=${AWS_PROFILE:+--profile "$AWS_PROFILE"}
REGION="${AWS_REGION:-us-east-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT/infra/production"
REPO=$(terraform output -json ecr_repository_urls | jq -r ".$APP")
CLUSTER=$(terraform output -raw cluster_name)
SERVICE=$(terraform output -json service_names | jq -r ".$APP")
ALB=$(terraform output -raw alb_dns_name)
cd "$ROOT"

echo ">> login to ECR"
aws ecr get-login-password $PROFILE_ARG --region "$REGION" | docker login --username AWS --password-stdin "${REPO%%/*}"

echo ">> build + push $REPO:$TAG (and :latest)"
# NOTE: the task brief specified --platform linux/arm64, but this stack's build/dev
# host and the live ECS tasks run x86_64 (see controller ruling for Task 10.1), so we
# build for linux/amd64 to match what ECS actually runs.
docker buildx build --platform linux/amd64 -f "docker/Dockerfile.$APP" -t "$REPO:$TAG" -t "$REPO:latest" --push .

echo ">> point the task definition at :$TAG and roll the service"
TD_ARN=$(aws ecs describe-services $PROFILE_ARG --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
aws ecs describe-task-definition $PROFILE_ARG --region "$REGION" --task-definition "$TD_ARN" --query 'taskDefinition' \
  | jq --arg img "$REPO:$TAG" '.containerDefinitions[0].image = $img
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .enableFaultInjection)' \
  > /tmp/td-$APP.json
NEW_TD=$(aws ecs register-task-definition $PROFILE_ARG --region "$REGION" --cli-input-json file:///tmp/td-$APP.json --query 'taskDefinition.taskDefinitionArn' --output text)
aws ecs update-service $PROFILE_ARG --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEW_TD" >/dev/null

echo ">> waiting for $SERVICE to stabilise"
aws ecs wait services-stable $PROFILE_ARG --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
echo ">> done: http://$ALB  ($APP @ $TAG)"
