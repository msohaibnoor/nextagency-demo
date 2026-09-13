# Guide 3 — The AWS console tour: where to see every piece of this stack

A click-path checklist. Every section says: *where to go*, *what you're looking at*, *what "correct"
looks like right now*, and *the file that created it*. Do it top to bottom once while the stack is
up — it takes about 40 minutes — and tick the boxes. After that you'll be able to find anything.

Before you start: console region = **N. Virginia (us-east-1)** (top-right). Wrong region = empty
screens everywhere. Account `472408435328`, signed in as `nextagency-demo-admin`.

Real identifiers from this deployment (yours will differ only if you rebuilt):

| Thing | Name / id |
|---|---|
| VPC | `nextagency-demo` (`vpc-0ca6b4412755c9ffe`) |
| ALB | `nextagency-demo` → `nextagency-demo-668835763.us-east-1.elb.amazonaws.com` |
| ECS cluster / services | `nextagency-demo` / `api`, `worker`, `web` |
| Task definitions (current) | `nextagency-demo-api:6`, `-worker:4`, `-web:6` |
| Redis | `nextagency-demo-redis` |
| Secret | `nextagency-demo/production/redis-url` |
| Roles | `nextagency-demo-ecs-execution`, `nextagency-demo-ecs-task`, `nextagency-demo-github-deploy` |
| State bucket / lock table | `nextagency-demo-tfstate-472408435328` / `nextagency-demo-tflock` |

Tip: in the top search bar type the service name (ECS, VPC, EC2, IAM…) — faster than the menus.

---

## 1. Billing first — the safety net (5 min)

**Billing and Cost Management → Budgets**
- [ ] `nextagency-demo-monthly`, $20, two alert thresholds. Created by `infra/bootstrap/main.tf`.
- [ ] Click it → *Alerts* → both show "Confirmed" (if "Pending", find the AWS e-mail and confirm).

**Billing → Cost allocation tags**
- [ ] `Project` under *User-defined* — status **Active**. If not, activate it now (it takes hours to
      start counting; without it `scripts/cost-check.sh` can't attribute spend).

**Billing → Cost Explorer** (enable it if prompted; free)
- [ ] Filter: Tag `Project` = `nextagency-demo`, group by *Service*, last 7 days. You should see
      NAT Gateway, Load Balancing, ElastiCache, ECS/Fargate. Yesterday's bar ≈ $3–4.

---

## 2. Networking — VPC (10 min)

**VPC → Your VPCs → `nextagency-demo`**
- [ ] CIDR `10.40.0.0/16`, DNS hostnames enabled. → `network.tf` `aws_vpc.this`.
- [ ] **Resource map** tab: 6 subnets, 3 route tables, 1 IGW, 1 NAT. This one picture *is*
      `network.tf`.

**VPC → Subnets** (filter by VPC)
- [ ] `nextagency-demo-public-us-east-1a/b` — `10.40.0.0/24`, `10.40.1.0/24`, *Auto-assign public IP: Yes*.
- [ ] `…-private-app-…` — `10.40.10.0/24`, `10.40.11.0/24`, auto-assign **No**.
- [ ] `…-private-data-…` — `10.40.20.0/24`, `10.40.21.0/24`.

**VPC → Route tables** (filter by VPC) — click each, **Routes** tab:
- [ ] `…-public`: `0.0.0.0/0 → igw-…`
- [ ] `…-private-app`: `0.0.0.0/0 → nat-…`
- [ ] `…-private-data`: **only** the local `10.40.0.0/16` route. No way out. This is the line that
      makes Redis unreachable from the internet regardless of any other mistake.

**VPC → NAT gateways**
- [ ] One, *Available*, in the public-a subnet, with an Elastic IP. ≈ $1.10/day — the single most
      expensive line item, and the first thing to check if a bill surprises you.

**VPC → Security groups** (filter by VPC) — **Inbound rules** tab on each:
- [ ] `nextagency-demo-alb-…`: TCP 80 from `0.0.0.0/0`.
- [ ] `nextagency-demo-app-…`: TCP 3000 and 4000 from **`sg-… (alb)`** — source is a security
      group, not an IP.
- [ ] `nextagency-demo-redis-…`: TCP 6379 from **`sg-… (app)`**.
      → `security.tf`. Nothing else is open inbound anywhere.

---

## 3. The front door — Load balancer (5 min)

**EC2 → Load balancers → `nextagency-demo`**
- [ ] *State: Active*, scheme *internet-facing*, the two **public** subnets, security group = alb.
- [ ] **DNS name** — copy it; this is the app's only public address. → `compute.tf` `aws_lb.this`.
- [ ] **Listeners and rules** tab → HTTP:80 → *Default*: forward to `nextagency-demo-web`;
      rule **priority 10**: `Path is /api/*` → forward to `nextagency-demo-api`.

**EC2 → Target groups**
- [ ] `nextagency-demo-web` → **Targets**: one target, a `10.40.10.x`/`10.40.11.x` IP on port 3000,
      *Healthy*. **Health checks** tab: path `/healthz`, interval 15 s, thresholds 2/3.
- [ ] `nextagency-demo-api` → one target on port 4000, *Healthy*; health path `/api/health`.
- [ ] **Monitoring** tab on either: request count and target response time graphs — click *Seed*
      on the dashboard and watch them tick.

What "unhealthy" here would mean: the ALB can't get a 200 from the health path → it stops routing to
that task → ECS kills and replaces it. This tab is the first place to look when the site is down.

---

## 4. The containers — ECS (15 min, the important one)

**ECS → Clusters → `nextagency-demo`**
- [ ] *Container Insights: Enabled*. **Services** tab: three rows, each *1/1 tasks running*,
      *Deployment status: Completed*, *Last deployment* within the last day.

**Click service `api`:**
- [ ] **Health and metrics**: CPU/memory graphs (Container Insights). Idle ≈ 1–2 % CPU.
- [ ] **Tasks** tab → one task, *Last status RUNNING*, *Health status HEALTHY*, *Started by:
      ecs-svc/…*. Click the task id:
  - **Configuration**: launch type FARGATE, platform, CPU 0.25 vCPU, memory 0.5 GB, *Task role*
    and *Task execution role* (the two from `iam.tf`), **private IP** (matches the target group).
  - **Networking**: subnet = a private-app subnet, security group = app, *Public IP: none*.
  - **Containers** → `api`: image `…/nextagency-demo/api:<sha>` — the git SHA CI deployed;
    *Environment variables* shows `PORT`, `NODE_ENV` — and `REDIS_URL` listed under **secrets**
    with its ARN, value hidden. That's the `valueFrom` injection from `compute.tf`.
  - **Logs** tab: the container's stdout, straight from CloudWatch. For api you'll see the
    `api listening` line and one health-check hit every 15 s.
  - **Tags** tab: `Project=nextagency-demo` etc. — propagated from the service; this is what makes
    Fargate cost visible under the tag.
- [ ] **Deployments** tab: one *PRIMARY / Completed* deployment on revision `:6`. Under
      **Deployment history** you'll see every rollout so far — the drills' failed one shows as
      *Failed / rolled back*.
- [ ] **Events** tab: read the last 20 lines. This is ECS narrating what it did: `has started 1
      tasks`, `registered 1 targets`, `has reached a steady state`. **Whenever anything is wrong,
      read this tab first.**

**Click service `worker`:**
- [ ] Same task view, but: no load balancer, no port mappings, *Health status: UNKNOWN* (nothing
      probes it — normal). **Logs** tab is the interesting one: JSON lines `completed` / `failed` /
      `sweep`. Click *Seed* on the dashboard and refresh.
- [ ] **Configuration** → *Stop timeout* on the container: 60 s (api/web: 30). That's the graceful
      shutdown window BullMQ uses to finish in-flight jobs.

**ECS → Task definitions** (left menu)
- [ ] `nextagency-demo-api` → several revisions (`:1` bootstrap … `:6` now). Open the latest →
      **JSON** tab. Find `"image"`, `"secrets"`, `"logConfiguration"`, `"runtimePlatform":
      {"cpuArchitecture":"X86_64"}`. Compare `:1` vs `:6`: **only the image tag differs** — every
      deploy is "same recipe, new image".
- [ ] Revision `:4` of api is the one the circuit breaker rejected in drill 1 (its image tag is
      `drill-bad`). Revisions are immutable and never deleted; ECS just points the service at a
      different one.

**ECS Exec (from your terminal, not the console):**
```bash
aws ecs execute-command --profile personal --cluster nextagency-demo \
  --task $(aws ecs list-tasks --profile personal --cluster nextagency-demo --service-name worker --query 'taskArns[0]' --output text) \
  --container worker --interactive --command /bin/sh
```
- [ ] You're inside the running worker. `env | grep REDIS_URL` → the injected `rediss://` secret.
      `exit`. No SSH key, no bastion; **CloudTrail** records that you did this (§8).

---

## 5. Images — ECR (3 min)

**ECR → Repositories** (private)
- [ ] `nextagency-demo/api`, `/worker`, `/web`. Open `api`: 18 images (bootstrap + one per deploy),
      tags = git SHAs plus `latest`, each ~180–200 MB compressed, *Scan status: Complete* with a
      vulnerability count. → `ecr.tf`.
- [ ] **Lifecycle policy** (left of the image list): "expire images beyond the last 10". You'll see
      the count drop as CI keeps deploying.
- [ ] Click an image → *Image URI*. That exact string is what the task definition's `image` field
      contains.

---

## 6. Data and secrets (5 min)

**ElastiCache → Redis OSS caches → `nextagency-demo-redis`**
- [ ] *Status Available*, node type `cache.t4g.micro`, 1 node, engine 7.1. **Encryption in transit:
      Enabled**, at rest: Enabled. Subnet group = the private-data subnets. → `data_stores.tf`.
- [ ] **Primary endpoint**: `master.nextagency-demo-redis.….use1.cache.amazonaws.com:6379`. You
      cannot connect to this from your laptop (no route, no SG rule) — try it if you like:
      `redis-cli -h master.… ping` hangs. That's the design working.
- [ ] **Metrics** tab: *CurrConnections* a handful (api + worker connections), *CurrItems* = the
      BullMQ keys + results sets.

**Secrets Manager → `nextagency-demo/production/redis-url`**
- [ ] **Retrieve secret value** → `rediss://:<32-char password>@master.…:6379`. This is the *only*
      place a human can read the password. → `secrets.tf`.
- [ ] **Resource permissions**: none — access is granted on the *role* side (`iam.tf`), not here.

---

## 7. Identity — IAM (7 min)

**IAM → Roles** (search `nextagency-demo`)
- [ ] `nextagency-demo-ecs-execution` → **Permissions**: `AmazonECSTaskExecutionRolePolicy`
      (managed) + inline `read-redis-url` scoped to the one secret ARN. **Trust relationships**:
      `ecs-tasks.amazonaws.com`. → `iam.tf` execution role.
- [ ] `nextagency-demo-ecs-task` → Permissions: only the inline `ecs-exec` policy
      (`ssmmessages:*`). This is everything your *application code* may do in AWS: nothing, plus
      accept a shell. → `iam.tf` task role.
- [ ] `nextagency-demo-github-deploy` → **Trust relationships**: principal = the GitHub OIDC
      provider; conditions `aud = sts.amazonaws.com` and `sub` = your repo on `main` (id-pinned form
      and classic form). **Permissions**: inline `deploy` — ECR push on 3 repos, `ecs:UpdateService`
      on 3 services, `RegisterTaskDefinition`, `PassRole` (conditioned to `ecs-tasks`),
      `DescribeLoadBalancers`. **Note what's absent**: no S3, no Secrets Manager, no `*`. →
      `cicd.tf`. **Last activity** column shows when CI last assumed it.

**IAM → Identity providers**
- [ ] `token.actions.githubusercontent.com` — the account-global trust anchor from bootstrap.

**IAM → Users → `nextagency-demo-admin`**
- [ ] Your CLI user. One access key, *Last used* = a few minutes ago. Delete this user at the very
      end (`docs/10-teardown-and-cost.md`).

---

## 8. Observability — CloudWatch and CloudTrail (7 min)

**CloudWatch → Log groups**
- [ ] `/ecs/nextagency-demo/api`, `/worker`, `/web`, retention *1 week*. → `logs.tf`.
- [ ] Open `/worker` → one **log stream** per task that has ever run (`ecs/worker/<task id>`); the
      newest is the live one. Open it, click *Resume* at the bottom to tail.

**CloudWatch → Logs Insights**
- [ ] Select the worker group, run:
  ```
  fields @timestamp, event, queue, jobId, error
  | filter event = "failed"
  | sort @timestamp desc | limit 50
  ```
  Then `stats count() by event, queue`. This works because the worker logs one JSON object per
  line — CloudWatch parses the fields for you.

**CloudWatch → Container Insights → Performance monitoring** → ECS Services
- [ ] CPU/memory/network per service. Container Insights is the `setting { containerInsights }`
      line in `compute.tf` and costs a little; NextAgency uses the same.

**CloudTrail → Event history**
- [ ] Filter *Event name* = `AssumeRoleWithWebIdentity`: every GitHub Actions run, with the OIDC
      subject in the *User name* column — including the failed first attempt (`AccessDenied`) that
      revealed the `owner@id/repo@id` format.
- [ ] Filter *Event name* = `ExecuteCommand`: your ECS Exec sessions. Everything an operator does
      leaves a record.

---

## 9. Terraform's own footprint (3 min)

**S3 → `nextagency-demo-tfstate-472408435328`**
- [ ] Object `production/terraform.tfstate`; **Show versions** → one version per apply (a free
      history of your infrastructure). *Block all public access: On*. Bucket versioning: Enabled.
- [ ] Open the object → it's JSON; it **contains the Redis password** — which is why CI's read
      access to it was removed and why this bucket must stay private.

**DynamoDB → Tables → `nextagency-demo-tflock`**
- [ ] *Explore table items*: normally 1 item (the digest) — a second `LockID` row appears only
      while an apply is running.

---

## 10. The "prove it's all connected" exercise (5 min)

1. Dashboard → click **Seed 50 reminders**.
2. EC2 → Target groups → `nextagency-demo-api` → Monitoring: request spike.
3. ECS → `worker` task → Logs: 50 `completed`/`failed` lines appear.
4. ElastiCache → Metrics: CurrItems bump.
5. CloudWatch Logs Insights → `stats count() by event` → the counts match the dashboard's stats.

One user click touched five services in two AZs across three network tiers, and you can see every
hop. That's the whole point of the demo.

---

## 11. When something's wrong — the order to look

1. **ECS → service → Events** (what ECS tried and what failed).
2. **ECS → task → Stopped reason** (why a task died: pull error, secret error, health check).
3. **ECS → task → Logs** (what the app said).
4. **EC2 → Target group → Targets** (is anyone healthy from the ALB's point of view).
5. **CloudTrail** (who/what was denied, if it smells like permissions).

Full symptom → cause table: `docs/AWS-ECS-FARGATE-GUIDE.md` §9.

---

## 12. Teardown check (after `terraform destroy`)

Region us-east-1. All of these should be empty / absent:
- [ ] ECS → Clusters
- [ ] EC2 → Load balancers, Target groups
- [ ] VPC → Your VPCs (only the default VPC, if any) · NAT gateways (none *available*)
- [ ] ElastiCache → Redis caches
- [ ] Secrets Manager (gone immediately — `recovery_window_in_days = 0`)
- [ ] ECR → Repositories
- [ ] CloudWatch → Log groups `/ecs/nextagency-demo/*`
- [ ] IAM → Roles: the three `nextagency-demo-*` roles gone; the OIDC provider **stays** (bootstrap)
- [ ] Resource Groups & Tag Editor → search tag `Project=nextagency-demo` → only bootstrap items
- [ ] 24 h later: Cost Explorer shows the tag's daily cost drop to ≈ $0.
