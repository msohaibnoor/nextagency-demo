# 10. Teardown and Cost

## Pre-estimate

Before teardown, review what the demo costs:

| Resource | ≈ per day |
|---|---|
| NAT gateway | $1.10 |
| ALB | $0.60 |
| ElastiCache `cache.t4g.micro` | $0.40 |
| 3 Fargate tasks (0.25 vCPU / 0.5 GB, x86) | $1.10 |
| ECR, logs, Secrets Manager, S3 | ~$0.20 |
| **Total** | **≈ $3.40/day** |

For context and detailed explanation of each component, see [AWS-ECS-FARGATE-GUIDE.md §0](./AWS-ECS-FARGATE-GUIDE.md#0-what-you-are-building-in-one-picture).

## How to read the cost script

After destroy, run:

```bash
scripts/cost-check.sh        # tagged mode (after Project tag is activated in Billing)
scripts/cost-check.sh --untagged  # total account cost by service (works before tag activation)
```

**Before first run:** Enable Cost Explorer once (Billing → Cost Explorer → click "Enable Cost Explorer" if prompted) and activate the Project cost allocation tag (Billing → Cost allocation tags → find `Project` → **Activate**). Tags take ~24 h to start collecting data.

**Why Fargate only shows under the tag after the final wave:** ECS tasks are billed as their own resources and carry no tags unless the service copies them. `compute.tf` now sets `propagate_tags = "SERVICE"` and `enable_ecs_managed_tags = true` on every `aws_ecs_service`, so tasks launched after that change inherit `Project=nextagency-demo` from the service (which gets it from the provider's `default_tags`). Tasks that were already running keep their empty tag set until they are replaced (`update-service --force-new-deployment`); Fargate hours before that point appear only in `--untagged` mode.

## Destroy order

1. **Destroy production infrastructure first**

   ```bash
   cd infra/production && AWS_PROFILE=personal terraform destroy
   ```

   Expected: ~50 resources destroyed in 6–8 minutes. NAT gateway and ElastiCache are slowest.

2. **(Optional) Destroy bootstrap infrastructure**

   Keep `infra/bootstrap` (≈ $0.05/month) to re-run the demo later with a single `terraform apply` in `production/`. Or destroy it for zero footprint:

   ```bash
   cd infra/bootstrap && AWS_PROFILE=personal terraform destroy
   ```

## What survives `terraform destroy` of production

After destroying `infra/production/`, these do **not** get deleted:

- **Bootstrap resources** (if you kept `infra/bootstrap`): S3 state bucket, DynamoDB lock table, AWS Budgets alert, OIDC GitHub provider
- (If bootstrap is also destroyed: these are all gone)

These **do** get deleted even though they appear separate:

- **ECR images** → deleted immediately because `force_delete = true` on each repository
- **CloudWatch log groups** → deleted immediately (managed by Terraform)
- **Secrets Manager secrets** → deleted immediately (`recovery_window_in_days = 0`)
- **ElastiCache data** → deleted immediately (no `final_snapshot_identifier` on the replication group, so destroy takes no snapshot)
- **ECS task-definition revisions** → survive: `terraform destroy` deregisters only the revisions it created (`:1`); the ones `deploy.sh` registered stay `ACTIVE` in the account. They are metadata, cost nothing, and can be deregistered by hand (`aws ecs deregister-task-definition`) or left alone

For explanation of what survives in the real NextAgency production stack, see [AWS-ECS-FARGATE-GUIDE.md §12](./AWS-ECS-FARGATE-GUIDE.md#12-mapping-back-to-nextagencys-real-terraform).

## Prove nothing is left: verification checklist

After `terraform destroy`, run these three CLI checks (`list-clusters` prints `{"clusterArns": []}`; the other two print `[]`):

```bash
export AWS_PROFILE=personal AWS_REGION=us-east-1

aws ecs list-clusters
aws ec2 describe-nat-gateways --filter Name=state,Values=available --query 'NatGateways[].NatGatewayId'
aws elasticache describe-replication-groups --query 'ReplicationGroups[].ReplicationGroupId'
```

Then verify via the console (region: **us-east-1**):

- ECS → **Clusters** — empty
- VPC → **Your VPCs** — only the default VPC (or none)
- EC2 → **Load balancers** — empty
- ElastiCache → empty
- Secrets Manager → empty

Finally, search for stragglers by tag:

Resource Groups & Tag Editor → **Regions:** us-east-1 → **Resource types:** All → **Tags:** `Project` = `nextagency-demo` → **Search**

- If you kept `bootstrap/`: expect only the state bucket and lock table
- If you destroyed `bootstrap/`: expect no results

For the complete walkthrough with context, see [AWS-ECS-FARGATE-GUIDE.md §11](./AWS-ECS-FARGATE-GUIDE.md#11-phase-13--teardown-and-proving-nothing-is-left).

## Delete the IAM user

Once you're fully done and have confirmed nothing is running:

1. IAM → **Users** → select `nextagency-demo-admin` → **Delete user**
2. Remove the `[personal]` block from `~/.aws/credentials`

## Actual cost (24 hours after destroy)

Record the real cost here after running `scripts/cost-check.sh` a day after destroy:

| Estimate | Actual | Notes |
|---|---|---|
| ≈ $3.40/day × runtime | *(fill in ~2026-09-16 with `scripts/cost-check.sh`)* | Stack ran 2026-09-13 ≈ 10:00 → 2026-09-15 (≈ 2 days) → expect ≈ $7–8. At destroy time the tag-filtered report still showed $0 (Cost Explorer lag + `Project` tag activated late); the untagged same-day view showed EC2-Other (NAT) $0.18, ECS $0.15, ELB $0.09, VPC $0.06, ElastiCache $0.03 for the partial final day |

### What the destroy actually looked like (2026-09-15)

- `terraform plan -destroy` → `Plan: 0 to add, 0 to change, 55 to destroy` (same 55 the first apply added).
- `terraform apply destroy.tfplan` → **8 min 28 s**. ElastiCache and the NAT gateway were the slow ones.
- Verified afterwards: `terraform state list` → 0 entries; no NAT gateways *available*, no replication groups, no load balancers, no ECS clusters, no VPC tagged `Project`, no ECR repos, no secrets, no `/ecs/nextagency-demo/*` log groups, no `nextagency-demo-*` roles.
- The Resource Groups tag search still listed a handful of ARNs for ~an hour: the NAT (state `deleted`), the cluster/services/tasks (`INACTIVE`), and task-definition revisions (`INACTIVE`, kept forever, free). That index lags; the direct `describe-*` calls are the truth.
- Two things `terraform destroy` cannot remove because Terraform never created them — clean them by hand:
  - task-definition revisions registered by `deploy.sh`/CI (`:2`…`:6`) stay `ACTIVE` (free):
    `for td in $(aws ecs list-task-definitions --status ACTIVE --query taskDefinitionArns --output text); do aws ecs deregister-task-definition --task-definition $td; done`
  - the Container Insights log group ECS creates on its own: `aws logs delete-log-group --log-group-name /aws/ecs/containerinsights/nextagency-demo/performance`
- Bootstrap (state bucket, lock table, budget, OIDC provider) was **kept**, so a rebuild is `terraform apply` in `production/` plus the image pushes in Task 9.6's order.
