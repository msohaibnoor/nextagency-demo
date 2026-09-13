# Guide 2 — Terraform: what actually happened, file by file

You ran (or watched run) `terraform apply` and 55 things appeared in AWS. This guide walks through
`infra/` the way Terraform itself reads it, so you can open any `.tf` file and know what it made,
why it's there, and how it connects to the next one. Do it with the files open — every section
names the file and the resource block.

Read `docs/04-terraform-state-and-roots.md` first if "state" and "root" are still fuzzy. The plain-
language vocabulary for the AWS pieces is in `docs/AWS-ECS-FARGATE-GUIDE.md` §2; this guide is
about *the Terraform*.

---

## 0. How to read a Terraform root

```
infra/production/
  versions.tf     which Terraform + providers, and WHERE STATE LIVES (S3 backend)
  variables.tf    inputs you can set (defaults for most)
  terraform.tfvars   YOUR values for the inputs with no default   (git-ignored)
  locals.tf       computed values reused across files
  network.tf, security.tf, data_stores.tf, secrets.tf, ecr.tf, logs.tf, iam.tf, compute.tf, cicd.tf
                  the resources — one file per concern (same convention as NextAgency's Rails repo)
  outputs.tf      values printed after apply for humans and scripts
```

Terraform doesn't care about file names or order — it loads every `.tf` in the directory into one
graph and works out the order from *references*. When `compute.tf` says
`subnets = aws_subnet.private_app[*].id`, that reference is what makes the subnets get created before
the service. So the way to understand the stack is to follow references. That's what the rest of this
guide does.

Three commands you'll use while reading:
```bash
cd ~/nextagency-demo/infra/production
export PATH=$HOME/.local/bin:$PATH AWS_PROFILE=personal
terraform state list                     # every resource Terraform manages, by address
terraform state show aws_vpc.this        # the live attributes of one resource (ids, ARNs, IPs)
terraform graph | head -40               # the dependency graph (dot format)
```
`terraform state list` should print 55 addresses. Compare it with the sections below as you go.

---

## 1. The two roots, and why bootstrap exists (`infra/bootstrap/`)

Chicken-and-egg: `production/` keeps its state in an S3 bucket, but something has to create that
bucket. That something is `bootstrap/`, which uses *local* state (`infra/bootstrap/terraform.tfstate`
on your disk — the only state file not in S3).

`infra/bootstrap/main.tf` creates:

| Resource | What | Why here and not in production |
|---|---|---|
| `aws_s3_bucket.state` + versioning + encryption + public-access-block | The state bucket `nextagency-demo-tfstate-472408435328` | Must exist before `production/` can `init` |
| `aws_dynamodb_table.lock` | `nextagency-demo-tflock` — one row while an apply runs | Stops two applies colliding |
| `aws_budgets_budget.monthly` | $20/month, e-mail at 50 % and 100 % | First safety net, created before anything that costs money |
| `aws_iam_openid_connect_provider.github` | Tells IAM to trust tokens signed by GitHub | **Account-global**: only one per account can exist, so it must not be in a root you'll destroy |

`bootstrap/outputs.tf` prints the three values `production/` needs. You typed one of them
(`github_oidc_provider_arn`) into `production/terraform.tfvars`; the other two went into
`production/versions.tf`'s backend block.

**Look:** `cat infra/bootstrap/terraform.tfstate | jq '.resources[].type'` — this is what a state
file is: a JSON record of every resource and its real AWS ids.

---

## 2. `versions.tf` — providers and the backend

```hcl
terraform { required_version = ">= 1.9"; required_providers { aws = "~> 5.80", random = "~> 3.6" } }
backend "s3" { bucket = "nextagency-demo-tfstate-472408435328", key = "production/terraform.tfstate", dynamodb_table = "nextagency-demo-tflock", … }
provider "aws" { region = var.region; default_tags { … Project=nextagency-demo … } }
```

- **providers** are plugins. `aws` knows how to call AWS APIs; `random` generates the Redis password.
  `terraform init` downloads them and pins exact versions in `.terraform.lock.hcl` (committed, so CI
  and you get identical plugins).
- **backend "s3"** is the one block that isn't a resource: it tells Terraform *where its own memory
  is*. Every `plan` reads `s3://…/production/terraform.tfstate`; every `apply` writes it back and
  holds the DynamoDB lock meanwhile. **Look:** S3 console → the bucket → `production/` → you'll see
  the state file and its versions (one per apply).
- **default_tags** stamps `Project / Environment / ManagedBy` on every resource this provider creates.
  That's how the cost report and the "is this mine?" tag search work.
- No `profile` anywhere: credentials come from `AWS_PROFILE=personal` in your shell (or from the OIDC
  role in CI). That's deliberate — the same files work in both places.

---

## 3. `variables.tf`, `terraform.tfvars`, `locals.tf` — inputs

| Variable | Value | Used by |
|---|---|---|
| `region` | `us-east-1` | provider |
| `vpc_cidr` | `10.40.0.0/16` | network.tf |
| `image_tag` | `bootstrap` | compute.tf — the tag the *first* task definitions pointed at (later deploys register new revisions outside Terraform) |
| `task_cpu` / `task_memory` | 256 / 512 | compute.tf |
| `github_repo`, `github_branch`, `github_owner_id`, `github_repo_id` | your repo, `main`, `73883272`, `1367206627` | cicd.tf — the OIDC trust policy |
| `github_oidc_provider_arn` | from bootstrap | cicd.tf |

`terraform.tfvars` holds the two values without defaults. It's git-ignored because it's *your*
account's wiring; `terraform.tfvars.example` shows the shape.

`locals.tf` computes three things everything else reuses: `local.name = "nextagency-demo"` (every
resource name starts with it), `local.azs` (the first two availability zones in the region, looked up
live via `data "aws_availability_zones"`), and `local.apps = toset(["api","worker","web"])` — the set
that `for_each` loops over in ecr/logs/compute. **Add a fourth app and three files grow by one
resource each with no code change.** That's what `for_each` over a set buys you.

---

## 4. `network.tf` — the VPC (19 resources)

Read it top to bottom; this is the layout from NextAgency's `NETWORK_ARCHITECTURE.md`, reduced to
two AZs.

```
aws_vpc.this                       10.40.0.0/16
├── aws_internet_gateway.this      the VPC's door to the internet
├── aws_subnet.public[0..1]        10.40.0.0/24, 10.40.1.0/24      cidrsubnet(cidr, 8, 0|1)
├── aws_subnet.private_app[0..1]   10.40.10.0/24, 10.40.11.0/24    cidrsubnet(cidr, 8, 10|11)
├── aws_subnet.private_data[0..1]  10.40.20.0/24, 10.40.21.0/24    cidrsubnet(cidr, 8, 20|21)
├── aws_eip.nat + aws_nat_gateway.this   one NAT, in public[0]
├── aws_route_table.public         0.0.0.0/0 → internet gateway
├── aws_route_table.private        0.0.0.0/0 → NAT gateway
├── aws_route_table.data           (no routes at all)
└── aws_route_table_association.*  6 of them — which subnet uses which table
```

The only thing that makes a subnet "public" is its route table pointing at the IGW
(plus `map_public_ip_on_launch = true`). "Private-app" subnets can reach out through the NAT (to
pull images from ECR, to call any external API) but nothing can reach in. "Private-data" subnets have
**no default route** — Redis in there can't talk to the internet even if it wanted to.

`cidrsubnet("10.40.0.0/16", 8, N)` means "carve /24s (16+8 bits) and take the N-th one". The offsets
0 / 10 / 20 leave gaps so you could add more subnets per tier later without renumbering.

`count = 2` with `local.azs[count.index]` is what spreads each tier across two AZs. `count` is the
older sibling of `for_each` — fine for "N identical things", worse when you delete one from the middle.

**Look:** VPC console → Your VPCs → `nextagency-demo` → **Resource map**. You'll see this exact tree.
`terraform state show aws_nat_gateway.this` gives you its id and the EIP.

---

## 5. `security.tf` — three firewalls chained (3 resources)

```
internet ──80──▶ sg_alb ──3000/4000──▶ sg_app ──6379──▶ sg_redis
```
The trick to notice: the *source* of a rule is another security group's id, not an IP range:
```hcl
ingress { from_port = 4000, to_port = 4000, protocol = "tcp", security_groups = [aws_security_group.alb.id] }
```
"Allow 4000 from anything that wears `sg_alb`." Tasks get new private IPs every deploy; SG-to-SG
rules don't care. Egress is open everywhere (`0.0.0.0/0`) — outbound isn't the threat model here.

There is no rule anywhere allowing the internet to reach a task or Redis. Combined with the route
tables in §4, that's two independent layers saying the same thing.

---

## 6. `data_stores.tf` + `secrets.tf` — Redis and its password (5 resources)

```hcl
resource "random_password" "redis_auth" { length = 32, special = false }
resource "aws_elasticache_subnet_group" "redis" { subnet_ids = aws_subnet.private_data[*].id }
resource "aws_elasticache_replication_group" "redis" {
  engine = "redis", engine_version = "7.1", node_type = "cache.t4g.micro", num_cache_clusters = 1
  transit_encryption_enabled = true, at_rest_encryption_enabled = true, auth_token = random_password.redis_auth.result
  security_group_ids = [aws_security_group.redis.id] }
```
- `random_password` is a resource like any other: generated once, stored in state, stable across
  applies. `special = false` so the password can sit in a URL unescaped.
- "Replication group with one node" is how ElastiCache spells "a single Redis". The subnet group
  pins it to the private-data subnets. Transit encryption → clients must use `rediss://`.

`secrets.tf` then packages the connection string:
```hcl
resource "aws_secretsmanager_secret" "redis_url" { name = "nextagency-demo/production/redis-url", recovery_window_in_days = 0 }
resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_string = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379" }
```
Follow the references: the secret *value* depends on the password *and* on the Redis endpoint, so
Terraform necessarily builds Redis before writing the secret. That's the ~7 minutes of the apply.
`recovery_window_in_days = 0` means "when destroyed, delete now" (the default 30-day recovery would
block re-creating the same name tomorrow).

**Two places hold the password:** Secrets Manager (which the app reads) and **Terraform state**
(which is why the state bucket is private and why we later *removed* CI's permission to read it —
§10).

---

## 7. `ecr.tf` + `logs.tf` — one repo and one log group per app (9 resources)

```hcl
resource "aws_ecr_repository" "app" { for_each = local.apps; name = "nextagency-demo/${each.key}"; force_delete = true; image_scanning_configuration { scan_on_push = true } }
resource "aws_ecr_lifecycle_policy" "app" { for_each = local.apps; … keep the last 10 images … }
resource "aws_cloudwatch_log_group" "app" { for_each = local.apps; name = "/ecs/nextagency-demo/${each.key}"; retention_in_days = 7 }
```
`for_each = local.apps` → addresses like `aws_ecr_repository.app["api"]`. `force_delete = true` lets
`terraform destroy` remove a repo that still has images in it (otherwise destroy fails). The
lifecycle policy is why old SHA-tagged images don't pile up.

---

## 8. `iam.tf` — the two roles a task wears (6 resources)

This is the part everyone confuses, so read it twice.

```hcl
resource "aws_iam_role" "execution" { … assume by ecs-tasks.amazonaws.com … }
  + AmazonECSTaskExecutionRolePolicy   (pull from ECR, write CloudWatch logs)
  + inline: secretsmanager:GetSecretValue on aws_secretsmanager_secret.redis_url.arn ONLY

resource "aws_iam_role" "task" { … assume by ecs-tasks.amazonaws.com … }
  + inline: ssmmessages:* (what `aws ecs execute-command` needs)
```

- The **execution role** is used by the ECS agent *to start your container*: pull the image, fetch
  the one secret, open the log stream. Your code never sees these credentials.
- The **task role** is what your code gets if it calls AWS. Ours calls nothing (it talks to Redis),
  so the task role holds only the ECS-Exec plumbing.

Why two? If the app were compromised, it could not pull other images or read other secrets — those
powers belong to a role the app doesn't hold. NextAgency's Rails stack uses the same split.

`data "aws_iam_policy_document" "ecs_tasks_assume"` is a helper that renders the trust JSON ("who
may assume this role") — both roles share it.

---

## 9. `compute.tf` — the ALB, the cluster, three task definitions, three services (12 resources)

This is the heart. Read it as three layers.

### 9a. Load balancer layer
```
aws_lb.this                    public subnets, sg_alb, listens on :80
├── aws_lb_target_group.web    port 3000, target_type "ip", health check GET /healthz every 15 s
├── aws_lb_target_group.api    port 4000, target_type "ip", health check GET /api/health
├── aws_lb_listener.http       default action → web target group
└── aws_lb_listener_rule.api   priority 10: path /api/* → api target group
```
`target_type = "ip"` is required for Fargate: targets are task private IPs, not instances. ECS
registers/deregisters them for you. `deregistration_delay = 10` — an old task keeps serving for 10 s
after it's removed so in-flight requests finish.

### 9b. Task definitions — the recipe
```hcl
resource "aws_ecs_task_definition" "app" {
  for_each = local.apps
  requires_compatibilities = ["FARGATE"], network_mode = "awsvpc", cpu = 256, memory = 512
  execution_role_arn = aws_iam_role.execution.arn, task_role_arn = aws_iam_role.task.arn
  runtime_platform { cpu_architecture = "X86_64" }
  container_definitions = jsonencode([{
    image       = "${aws_ecr_repository.app[each.key].repository_url}:${var.image_tag}"
    portMappings = …3000/4000 or none for worker…
    environment = …PORT, HOSTNAME, API_URL (web only)…
    secrets     = [{ name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn }]   # api + worker
    stopTimeout = 60 for worker, 30 otherwise
    logConfiguration = { awslogs → /ecs/nextagency-demo/<app> }
  }])
}
```
The `locals { container = { api = {…}, worker = {…}, web = {…} } }` block just above holds the
per-app differences so the resource itself is written once. `secrets.valueFrom` is the line that
makes ECS inject the Redis URL as an environment variable at start — the password never appears in
this file, in state outputs, or in the console's task-definition view.

`API_URL = "http://${aws_lb.this.dns_name}"` for web: a reference to the ALB, so the web task
definition depends on the ALB. That's fine — follow the arrows and there's no cycle.

### 9c. Services — "keep one running"
```hcl
resource "aws_ecs_service" "app" {
  for_each = local.apps
  desired_count = 1, launch_type = "FARGATE", enable_execute_command = true
  network_configuration { subnets = private_app, security_groups = [sg_app], assign_public_ip = false }
  deployment_circuit_breaker { enable = true, rollback = true }
  deployment_minimum_healthy_percent = 100, deployment_maximum_percent = 200
  health_check_grace_period_seconds = 60          # web/api only
  propagate_tags = "SERVICE", enable_ecs_managed_tags = true
  dynamic "load_balancer" { … only for web and api … }
  depends_on = [listener, rule, execution-role policies, the secret version]
  lifecycle { ignore_changes = [task_definition] }
}
```
Three lines carry most of the behaviour you saw in the drills:
- `minimum 100 / maximum 200`: start the new task *before* stopping the old one → zero-downtime.
- `deployment_circuit_breaker { rollback = true }`: if the new tasks keep failing health checks,
  give up and go back — drill 1.
- `lifecycle { ignore_changes = [task_definition] }`: **deploys register new task-definition
  revisions outside Terraform** (`scripts/deploy.sh`, CI). Without this line, the next `terraform
  plan` would see "task definition drifted" and try to revert your deploy to `:bootstrap`. Terraform
  owns the shape of the service; CI owns which image is running.

The `dynamic "load_balancer"` block is how one resource definition serves both the two web-facing
services (attached to a target group) and the worker (not attached). `for_each` + `dynamic` is the
idiom that keeps `compute.tf` at 180 lines instead of 500.

---

## 10. `cicd.tf` — the role GitHub Actions assumes (2 resources)

```hcl
resource "aws_iam_role" "github_deploy" {
  assume_role_policy = … Federated = var.github_oidc_provider_arn,
    Condition: aud == "sts.amazonaws.com"
               sub LIKE "repo:msohaibnoor@73883272/nextagency-demo@1367206627:ref:refs/heads/main"  (or the classic form) …
}
resource "aws_iam_role_policy" "github_deploy" {
  ecr:GetAuthorizationToken (*), ecr push/pull on the 3 repos,
  ecs:UpdateService/DescribeServices on the 3 services, ecs:Register/DescribeTaskDefinition (*),
  iam:PassRole on the two task roles (only to ecs-tasks.amazonaws.com), elasticloadbalancing:DescribeLoadBalancers
}
```
The trust policy is the security boundary: only a token that GitHub signed *for this repo's `main`
branch* can assume the role. The permission policy is deliberately small — enough to push an image
and roll a service, nothing else. It went through three iterations while you watched:
1. First run failed: GitHub's `sub` now includes the owner and repo **ids**; CloudTrail showed the
   real subject; the trust policy was widened, then pinned to the ids.
2. CI needed to read Terraform state for `terraform output` → we granted S3/DynamoDB read.
3. Realised **state contains the Redis password** → removed that grant and made `deploy.sh` derive
   what it needs from fixed names + `describe-load-balancers` instead.
That history is in `docs/08-deploy-and-oidc.md` and is the single best lesson in this repo about
least privilege.

---

## 11. `outputs.tf` — what apply hands back

`alb_dns_name`, `cluster_name`, `service_names`, `ecr_repository_urls`, `github_deploy_role_arn`,
`redis_secret_arn`. Run `terraform output` — these are the only values a human needs after an apply.
Note there's no output for the password: state has it, outputs don't.

---

## 12. What actually happened when you applied (the sequence)

1. `terraform apply -target=aws_ecr_repository.app` — only the 3 ECR repos. Because…
2. …the services reference `image:bootstrap`, which must exist in ECR before a service can start
   (otherwise tasks loop on `CannotPullContainerError`). So: build, push `:bootstrap` ×3.
3. `terraform plan -out tfplan` → `55 to add`. `terraform apply tfplan`, ~5–10 min. Order Terraform
   chose (from references): VPC → subnets/IGW/NAT/routes → SGs → Redis (slow) → secret → roles →
   log groups → ALB + target groups + listener → task definitions → services.
4. Services started their first tasks; the worker's first two attempts hit a Secrets Manager
   propagation race (the secret's `AWSCURRENT` label wasn't visible yet) and ECS's own retry
   succeeded a minute later. The later `depends_on` on the secret version narrows that window.
5. Every later change was an **in-place update** (`~` in the plan): health path to `/healthz`, tag
   propagation, role policies. `0 to destroy` every time — you should read that line before every
   apply, and stop if it isn't 0 unless you meant it.

---

## 13. Exercises (do at least the first two)

1. `terraform plan` right now. Expected: `No changes.` That means state == reality == code. Then
   change `retention_in_days` in `logs.tf` from 7 to 3, `plan` again — read the `~` diff — and put it
   back **without applying**.
2. `terraform state show 'aws_ecs_service.app["worker"]'` — find `task_definition`. It points at a
   revision Terraform didn't create (`:4`, from CI). That's `ignore_changes` in action.
3. `terraform graph | grep -c '\->'` — count the dependency edges. Then find the edge from the secret
   version to the services.
4. Console: IAM → Roles → `nextagency-demo-ecs-execution` → Permissions. Match every statement to a
   line in `iam.tf`.
5. Read `terraform/production/compute.tf` in the NextAgency Rails repo. You'll recognise every
   block; note what's added (autoscaling, several worker services, ACM/HTTPS).

## When you're done: `docs/10-teardown-and-cost.md` → `terraform destroy`. Read the destroy plan's
count: it should say `55 to destroy` (plus nothing else). Bootstrap stays.
