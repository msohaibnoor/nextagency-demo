#!/usr/bin/env bash
# Daily cost of everything tagged Project=nextagency-demo for the last 7 days (Cost Explorer lags ~24h).
# Optional --untagged mode shows total account cost by service instead (before Project tag is activated).
set -euo pipefail

UNTAGGED_MODE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --untagged)
      UNTAGGED_MODE=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

START=$(date -u -d '7 days ago' +%F)
END=$(date -u -d 'tomorrow' +%F)

PROFILE="${AWS_PROFILE:-personal}"

if [ "$UNTAGGED_MODE" = true ]; then
  echo "📊 Total account cost by service (last 7 days)"
  echo "Use this before the Project=nextagency-demo tag is activated in Billing."
  echo ""
  aws ce get-cost-and-usage --profile "$PROFILE" \
    --time-period Start=$START,End=$END --granularity DAILY --metrics UnblendedCost \
    --group-by Type=DIMENSION,Key=SERVICE \
    --query 'ResultsByTime[].{day:TimePeriod.Start,services:Groups[].{service:Keys[0],cost:Metrics.UnblendedCost.Amount}}' --output table
else
  echo "💰 Daily cost tagged Project=nextagency-demo (last 7 days)"
  echo ""
  echo "⚠️  Tip: If you see an error or empty results:"
  echo "   1. Cost allocation tags must be activated once: Billing → Cost allocation tags → Find 'Project' → Activate"
  echo "   2. Cost Explorer must be enabled once: Billing → Cost Explorer → (click 'Enable Cost Explorer' if shown)"
  echo "   3. Tags take ~24h to start collecting data after activation."
  echo "   4. Use --untagged mode to see total account cost by service in the meantime."
  echo ""
  aws ce get-cost-and-usage --profile "$PROFILE" \
    --time-period Start=$START,End=$END --granularity DAILY --metrics UnblendedCost \
    --filter '{"Tags":{"Key":"Project","Values":["nextagency-demo"]}}' \
    --query 'ResultsByTime[].{day:TimePeriod.Start,usd:Total.UnblendedCost.Amount}' --output table
fi
