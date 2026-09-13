#!/usr/bin/env bash
# Usage: scripts/deploy.sh <api|worker|web> [tag]
set -euo pipefail
APP="${1:?app name required}"
case "$APP" in
  api|worker|web) ;;
  *) echo "unknown app: $APP (expected api|worker|web)" >&2; exit 2 ;;
esac
TAG="${2:-$(git rev-parse --short HEAD)}"
PROFILE_ARG=${AWS_PROFILE:+--profile "$AWS_PROFILE"}
REGION="${AWS_REGION:-us-east-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# No Terraform here: the deploy role must not read Terraform state (it holds
# the Redis auth token in plaintext). Everything the deploy needs is either a
# fixed name from infra/production (cluster, service, ECR repo path) or
# derivable from the AWS API.
ACCOUNT=$(aws sts get-caller-identity $PROFILE_ARG --query Account --output text)
REPO="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/nextagency-demo/$APP"
CLUSTER=nextagency-demo
SERVICE=$APP
ALB=$(aws elbv2 describe-load-balancers $PROFILE_ARG --region "$REGION" --names nextagency-demo --query 'LoadBalancers[0].DNSName' --output text)

echo ">> login to ECR"
aws ecr get-login-password $PROFILE_ARG --region "$REGION" | docker login --username AWS --password-stdin "${REPO%%/*}"

echo ">> build + push $REPO:$TAG (and :latest)"
# NOTE: the task brief specified --platform linux/arm64, but this stack's build/dev
# host and the live ECS tasks run x86_64 (see controller ruling for Task 10.1), so we
# build for linux/amd64 to match what ECS actually runs.
docker buildx build --platform linux/amd64 -f "docker/Dockerfile.$APP" -t "$REPO:$TAG" -t "$REPO:latest" --push .

echo ">> point the task definition at :$TAG and roll the service"
TD_JSON=$(mktemp)
trap 'rm -f "$TD_JSON"' EXIT
TD_ARN=$(aws ecs describe-services $PROFILE_ARG --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
# describe-task-definition returns server-assigned metadata that
# register-task-definition rejects as input, so strip it. enableFaultInjection
# is a newer read-only echo field (defaults to false) that ECS returns on
# describe but does not accept on register — same treatment.
aws ecs describe-task-definition $PROFILE_ARG --region "$REGION" --task-definition "$TD_ARN" --query 'taskDefinition' \
  | jq --arg img "$REPO:$TAG" '.containerDefinitions[0].image = $img
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .enableFaultInjection)' \
  > "$TD_JSON"
NEW_TD=$(aws ecs register-task-definition $PROFILE_ARG --region "$REGION" --cli-input-json "file://$TD_JSON" --query 'taskDefinition.taskDefinitionArn' --output text)
aws ecs update-service $PROFILE_ARG --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEW_TD" >/dev/null

echo ">> waiting for $SERVICE to stabilise"
aws ecs wait services-stable $PROFILE_ARG --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"

# "services-stable" only means the service reached a steady state — after a
# circuit-breaker rollback that steady state is the OLD revision. Check that
# the PRIMARY deployment is ours and completed before claiming success.
PRIMARY=$(aws ecs describe-services $PROFILE_ARG --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].deployments[?status==`PRIMARY`] | [0].[taskDefinition, rolloutState]' --output text)
read -r PRIMARY_TD PRIMARY_STATE <<< "$PRIMARY"
if [[ "$PRIMARY_TD" != "$NEW_TD" || "$PRIMARY_STATE" != "COMPLETED" ]]; then
  echo "!! $SERVICE did not settle on $NEW_TD (PRIMARY=$PRIMARY_TD state=$PRIMARY_STATE); last events:" >&2
  aws ecs describe-services $PROFILE_ARG --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].events[:5].[createdAt, message]' --output text >&2
  exit 1
fi
echo ">> done: http://$ALB  ($APP @ $TAG, $NEW_TD)"
