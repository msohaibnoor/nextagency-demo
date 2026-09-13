# AWS, ECS Fargate & Terraform — the guide to read alongside Phases 8–13

This is the "I have never used ECS" companion to the implementation plan. It explains, in order,
what you'll click in the AWS console, what each AWS thing *is*, what Terraform will create for you,
what to look at after every step, and how to get out of trouble. Read §0–§3 before Phase 8; read
each later section when you reach that phase.

You have deployed to EC2 with Nginx before. Keep that mental model handy — every concept below is
introduced as "what this replaces from the EC2 world".

---

## 0. What you are building, in one picture

```
                    Internet
                       │
                       ▼  http://nextagency-demo-xxxx.us-east-1.elb.amazonaws.com
              ┌────────────────────┐
              │  Application Load  │  public subnets (2 AZs)
              │  Balancer (ALB)    │  listens on :80
              └───────┬────────────┘
        /api/*        │        everything else
     ┌────────────────┴────────────────┐
     ▼                                 ▼
┌──────────┐                     ┌──────────┐        ┌──────────┐
│ api task │ :4000               │ web task │ :3000  │ worker   │ (no port)
│ NestJS   │                     │ Next.js  │        │ task     │
└────┬─────┘                     └──────────┘        └────┬─────┘
     │      private-app subnets (2 AZs) — no public IPs   │
     │      egress to internet only via the NAT gateway   │
     └──────────────────┬──────────────────────────────────┘
                        ▼  rediss:// (TLS + password)
               ┌──────────────────┐
               │ ElastiCache Redis│  private-data subnets (no internet route at all)
               └──────────────────┘

Supporting cast:  ECR (3 image repos) · Secrets Manager (REDIS_URL) · CloudWatch Logs (3 groups)
                  IAM (execution role, task role, github-deploy role) · S3+DynamoDB (Terraform state)
                  AWS Budgets ($20 alarm)
```

**In EC2 terms:** the ALB is your Nginx (but managed and multi-AZ), each ECS *task* is a container
that would have run on your EC2 box, Fargate is "AWS owns the EC2 box so you never SSH into it",
ECR is Docker Hub but private, and Terraform is the script that creates all of it from text files.

### What it costs

| Resource | ≈ per day | Why it exists |
|---|---|---|
| NAT gateway | $1.10 | Lets private tasks reach the internet (pull nothing — images come from ECR via NAT too) |
| ALB | $0.60 | Public entry point |
| ElastiCache `cache.t4g.micro` | $0.40 | Redis for BullMQ |
| 3 Fargate tasks (0.25 vCPU / 0.5 GB, x86) | $1.10 | Your apps |
| ECR, logs, Secrets Manager, S3 | ~$0.20 | |
| **Total** | **≈ $3.40/day** | Destroy after 2–3 days → **≈ $10** |

The budget alarm in Phase 8 e-mails you at $10 and $20 of monthly spend. If you ever see that
e-mail unexpectedly, something is still running — go to §11.

### Safety rules for a personal account

1. Never leave the stack running overnight "just in case". `terraform destroy` takes 8 minutes;
   re-creating takes 12. It is cheaper to re-create.
2. The IAM user you create has **AdministratorAccess**. Never commit its keys. The access key lives
   only in `~/.aws/credentials`. Delete the user at the end (§11).
3. Everything Terraform creates is tagged `Project=nextagency-demo`. If in doubt what's yours, filter
   by that tag (§11 shows how).

---

## 1. One-time AWS account setup (do this now)

### 1.1 Create the IAM user and access key (console)

IAM = "Identity and Access Management" = users, roles and permissions. You need one *user* with
programmatic keys for the CLI and Terraform.

1. Sign in to https://console.aws.amazon.com with your personal account.
2. Top-right, set the region to **N. Virginia (us-east-1)**. Most things you'll look at are
   region-scoped; if the console looks empty later, check this first.
3. Search bar → **IAM** → left menu **Users** → **Create user**.
   - User name: `nextagency-demo-admin`
   - Leave "Provide user access to the AWS Management Console" **unchecked** (CLI only).
   - Next → **Attach policies directly** → search `AdministratorAccess` → tick it → Next → Create user.
4. Click the user → **Security credentials** tab → **Access keys** → **Create access key** →
   choose **Command Line Interface (CLI)** → tick the confirmation → Next → Create.
5. You see *Access key* and *Secret access key* **once**. Keep this page open for the next step.
   (If you lose the secret, delete the key and create a new one — there's no "show again".)

### 1.2 Configure the CLI profile (terminal)

Open a normal terminal (not the Claude prompt — this command is interactive):

```bash
~/.local/bin/aws configure --profile personal
```
Answer:
```
AWS Access Key ID:     <paste>
AWS Secret Access Key: <paste>
Default region name:   us-east-1
Default output format: json
```
This writes `~/.aws/credentials` and `~/.aws/config`. Verify:

```bash
aws sts get-caller-identity --profile personal
```
Expected:
```json
{ "UserId": "AIDA...", "Account": "123456789012", "Arn": "arn:aws:iam::123456789012:user/nextagency-demo-admin" }
```
Write down the 12-digit **Account** number — you'll type it into two Terraform files.

Why a *profile*? So `AWS_PROFILE=personal` (or `--profile personal`) is an explicit choice every time,
and you can never accidentally run a command against a work account. The Rails repo uses the same
pattern (`aws_profile = "nextagency-admin"`).

### 1.3 Enable cost allocation tags (console, once)

Billing → **Cost allocation tags** → find `Project` under *User-defined cost allocation tags* →
**Activate**. This lets `scripts/cost-check.sh` (Phase 13) report what the demo actually cost. It
takes up to 24 h to start collecting, which is why you do it now.

---

## 2. The vocabulary (read once, refer back)

### Networking

| Term | Plain meaning | EC2-world equivalent |
|---|---|---|
| **Region** | A geographic cluster of data centres (`us-east-1`). Everything below lives in one region. | Same |
| **Availability Zone (AZ)** | One data centre within a region (`us-east-1a`, `us-east-1b`). We use two so an AZ outage doesn't take everything down. | Where your EC2 instance physically was |
| **VPC** | Your private network, a block of IPs (`10.40.0.0/16` = 65k addresses). Nothing inside is reachable from the internet unless you explicitly allow it. | The default VPC your EC2 lived in — you just never had to think about it |
| **Subnet** | A slice of the VPC in one AZ (`10.40.0.0/24` = 256 IPs). A subnet is "public" or "private" purely by what its route table says. | — |
| **Route table** | "For traffic to X, send it via Y." Public subnets route `0.0.0.0/0` → Internet Gateway. Private-app subnets route it → NAT gateway. Private-data subnets have **no** default route: Redis can't reach the internet and the internet can't reach it. | — |
| **Internet Gateway (IGW)** | The VPC's door to the internet. Free. | Your EC2's public IP relied on one |
| **NAT gateway** | Lets *private* things make *outbound* connections (pull an image, call an API) without having a public IP. Inbound is impossible. Costs ~$1/day, which is why the Rails team documents it. | Nothing — your EC2 had a public IP and talked out directly |
| **Security group (SG)** | A firewall attached to a thing (ALB, task, Redis). Rules say "allow port P from source S", where the source can be *another security group*. Ours chain: internet → `sg_alb`:80 → `sg_app`:3000/4000 → `sg_redis`:6379. Anything not listed is denied. | The EC2 security group where you opened 22/80/443 |
| **Elastic IP (EIP)** | A fixed public IPv4 address. The NAT gateway needs one. | Same |

### Load balancing

| Term | Plain meaning |
|---|---|
| **Application Load Balancer (ALB)** | A managed HTTP reverse proxy across two AZs. It has a DNS name (`…elb.amazonaws.com`) and that's the only public address in the whole stack. |
| **Listener** | "On port 80, do this." Ours forwards to the `web` target group by default. |
| **Listener rule** | "But if the path matches `/api/*`, forward to the `api` target group instead." Rules have priorities; lower number wins. |
| **Target group (TG)** | A list of IPs the ALB sends traffic to, plus a **health check** (`GET /api/health` every 15 s must return 200). ECS registers each task's private IP into the TG automatically when it starts and removes it when it stops. A task that fails the health check is taken out of rotation *and* ECS replaces it. |

### Containers

| Term | Plain meaning | EC2-world equivalent |
|---|---|---|
| **ECR** | Private Docker registry. One *repository* per image (`nextagency-demo/api`, `/worker`, `/web`). You `docker push` to it; Fargate pulls from it. | Docker Hub / building on the box |
| **ECS** | The orchestrator: "keep N copies of this container running, wire them into the load balancer, replace them if they die." | You + `pm2` + a deploy script |
| **Cluster** | A named grouping of services. Just a folder, essentially. With Fargate there are no machines in it to manage. | — |
| **Task definition** | The *recipe*: which image, how much CPU/RAM, env vars, which secret to inject, where to send logs, which IAM roles. Immutable and **versioned** (`nextagency-demo-api:1`, `:2`, …). Every deploy registers a new revision. | `docker run …` flags + `.env` written down |
| **Task** | One running instance of a task definition — a container (or several) with its own private IP (an ENI in your subnet). Tasks are cattle: they get killed and replaced. | One running container on your EC2 |
| **Service** | "Keep `desired_count` tasks of task-definition X running in these subnets with these SGs, registered in this TG." Handles rolling deployments and replacement. `web` and `api` are attached to the ALB; `worker` is not (nothing connects *to* it). | `pm2 start --instances` + your Nginx upstream list |
| **Fargate** | The launch type where AWS supplies the underlying compute. You pay per vCPU-second and GB-second; you never see or patch a host. | The EC2 instance itself — gone |
| **Execution role** | IAM role the *ECS agent* uses to **start** your task: pull from ECR, read the secret, write logs. Your code never uses it. | The IAM instance profile your EC2 had, but only for bootstrapping |
| **Task role** | IAM role your **application code** assumes at runtime (if it calls AWS APIs). Ours only grants ECS Exec (SSM) permissions because the app talks to Redis, not AWS. | The instance profile again, but for the app. Separating the two is the point. |
| **ECS Exec** | `aws ecs execute-command` → an interactive shell inside a running task, tunnelled through SSM. | `ssh` into the box + `docker exec` |
| **Deployment circuit breaker** | If a new task definition's tasks keep failing health checks, ECS gives up and rolls the service back to the previous revision automatically — except on a service's very first deployment, where there is no previous revision to roll back to and a tripped breaker just leaves the service at 0 running tasks. | Your manual "oh no, redeploy the old one" |

### Data & secrets

| Term | Plain meaning |
|---|---|
| **ElastiCache** | Managed Redis. A *replication group* with one node (`cache.t4g.micro`). Ours has TLS in transit and a password (AUTH token), hence `rediss://`. Lives in private-data subnets, reachable only from `sg_app`. |
| **Secrets Manager** | Encrypted key/value store. We store one secret, `nextagency-demo/production/redis-url`, containing the full `rediss://:password@host:6379` URL. The task definition says `REDIS_URL` = *that secret*, and ECS injects it as an env var at start — the password never appears in Terraform outputs, task definition JSON, or logs. |
| **CloudWatch Logs** | Where container stdout/stderr goes. One *log group* per app; one *log stream* per task. 7-day retention here. |

### Deployment plumbing

| Term | Plain meaning |
|---|---|
| **Terraform state** | Terraform's record of what it created and their IDs. Stored in an S3 bucket so it's not on your laptop alone; a DynamoDB table holds a lock so two `apply`s can't run at once. |
| **Terraform root** | A directory you run `terraform apply` in; it owns one state file. We have two: `infra/bootstrap` (state bucket, budget, OIDC provider — apply once, keep) and `infra/production` (everything else — destroy after the demo). Same convention as the Rails repo. |
| **OIDC provider + `github-deploy` role** | How GitHub Actions gets AWS access **without stored keys**: GitHub signs a short-lived token saying "this is repo X on branch main"; AWS trusts GitHub's signature and lets the workflow assume a role limited to pushing images and updating the three services. |
| **AWS Budgets** | A monthly spend threshold with e-mail alerts. Free. First thing we create. |

---

## 3. How Terraform works (5-minute version)

You write `.tf` files describing the end state. Terraform compares them to its state file and to
reality, prints a diff (*plan*), and on confirmation makes the changes (*apply*).

```bash
cd infra/production
terraform init            # download the AWS provider, connect to the S3 state backend (once per dir)
terraform validate        # syntax + type check, no AWS calls
terraform plan -out tfplan   # "I will add 52, change 0, destroy 0" — read this every time
terraform apply tfplan    # do exactly what the plan said
terraform output          # print the values marked as outputs (ALB DNS name, ECR URLs, …)
terraform destroy         # delete everything in this root's state (asks for "yes")
```

Rules that will save you:

- **Always `plan -out` then `apply tfplan`.** Applying a saved plan guarantees what you read is what
  runs. The Rails README says the same.
- **Read the plan's first line.** `Plan: 52 to add, 0 to change, 0 to destroy` is what a first apply
  should say. If a later plan says `destroy` on something you didn't expect (an ElastiCache group, the
  ALB), stop and ask before applying.
- **`terraform.tfvars` is your personal input** (e-mail, account id, repo name). It is git-ignored.
  `terraform.tfvars.example` is the template you copy.
- **State is precious.** Never delete the S3 state bucket while `production/` still has resources,
  or Terraform forgets they exist and you'll have to delete ~50 things by hand.
- **Never edit resources in the console** that Terraform manages. The next `apply` reverts your
  change silently. Console is for *looking*.
- `-target=…` applies one resource. We use it exactly once (Task 9.6) to create ECR repos before
  pushing images. Don't make it a habit.
- The `PATH` for Terraform and the AWS CLI is `~/.local/bin`. New terminals pick it up from
  `~/.bashrc`; if a command says "not found", run `export PATH=$HOME/.local/bin:$PATH`.

---

## 4. Phase 8 — bootstrap root, and what to look at afterwards

**Inputs you provide** in `infra/bootstrap/terraform.tfvars`:
```hcl
alert_email       = "iamsohaibnoor@gmail.com"
state_bucket_name = "nextagency-demo-tfstate-123456789012"   # your account id; bucket names are global
```

**What `terraform apply` creates** (4 things, ~1 minute):

| Resource | Console location | What to check |
|---|---|---|
| S3 bucket `nextagency-demo-tfstate-…` | S3 → Buckets | Exists; Properties → *Bucket Versioning: Enabled*; Permissions → *Block all public access: On* |
| DynamoDB table `nextagency-demo-tflock` | DynamoDB → Tables | Exists, capacity *On-demand*. It'll have 0 items until an apply is running |
| Budget `nextagency-demo-monthly` | Billing and Cost Management → Budgets | `$20.00`, alerts at 50 % and 100 %. **Check your inbox** — AWS sends a "confirm subscription" e-mail; click it or the alerts never arrive |
| OIDC identity provider `token.actions.githubusercontent.com` | IAM → Identity providers | Present. This is account-global; one per account, which is why it lives here and not in `production/` (the Rails team learned that by destroying theirs) |

`terraform output` prints three values. Copy `github_oidc_provider_arn` — Phase 9 needs it.

Bootstrap uses **local state** (`infra/bootstrap/terraform.tfstate`, git-ignored). That's the one
state file that lives on your laptop, because the bucket it would go in doesn't exist yet. Back it
up if you like; losing it only means re-importing four resources.

---

## 5. Phase 9 — production root, file by file, and the console tour

**Inputs** in `infra/production/terraform.tfvars`:
```hcl
github_repo              = "msohaibnoor/nextagency-demo"
github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
```
and in `versions.tf`, the backend block needs your bucket name (the plan marks it `<ACCOUNT_ID>`).

### 5.1 The order matters (Task 9.6)

Services point at `…/api:bootstrap` etc. If those image tags don't exist in ECR when the services
start, every task fails with `CannotPullContainerError` and ECS keeps retrying forever. So:

1. `terraform apply -target=aws_ecr_repository.app` — only the three repos.
2. Build and push the three images with the `bootstrap` tag (§7 explains the push).
3. `terraform plan -out tfplan && terraform apply tfplan` — everything else, ~10 minutes.
   ElastiCache takes 6–8 of those; the console shows it as *creating*.

### 5.2 What each file creates, and where to see it

| File | Creates | Console: where to look | What "good" looks like |
|---|---|---|---|
| `network.tf` | VPC, 6 subnets, IGW, EIP, NAT, 3 route tables | **VPC → Your VPCs** → `nextagency-demo` → *Resource map* tab | The map shows 6 subnets in 2 AZs; public ones route to `igw-…`, private-app to `nat-…`, private-data to nothing |
| `security.tf` | 3 SGs | VPC → Security groups | `…-app-…` inbound: 3000 & 4000 *from* `sg-alb`; `…-redis-…` inbound: 6379 *from* `sg-app`. Sources are SG ids, not IPs — that's the chaining |
| `data_stores.tf` | Redis subnet group + replication group | **ElastiCache → Redis OSS caches** | Status *Available*; Encryption in transit *Enabled*; in the private-data subnets |
| `secrets.tf` | one secret | **Secrets Manager** → `nextagency-demo/production/redis-url` | *Retrieve secret value* shows `rediss://:…@….cache.amazonaws.com:6379`. This is the only place the password is readable |
| `ecr.tf` | 3 repos + lifecycle policy | **ECR → Repositories** | After the push: each has a `bootstrap` tag; *Scan on push* enabled; Lifecycle policy: keep 10 |
| `logs.tf` | 3 log groups | **CloudWatch → Log groups** | `/ecs/nextagency-demo/{api,worker,web}`, retention 1 week |
| `iam.tf` | 2 roles | **IAM → Roles** | `…-ecs-execution` has `AmazonECSTaskExecutionRolePolicy` + inline `read-redis-url`; `…-ecs-task` has only the inline `ecs-exec` policy |
| `compute.tf` | cluster, 3 task definitions, ALB, 2 TGs, listener + rule, 3 services | **ECS → Clusters** → `nextagency-demo`; **EC2 → Load Balancers / Target groups** | See §5.3 |
| `cicd.tf` | `github-deploy` role | IAM → Roles | Trust policy mentions `token.actions.githubusercontent.com` and your repo |

### 5.3 The console tour after apply (do this — it's the whole point)

**ECS → Clusters → `nextagency-demo`**

- **Services** tab: three rows, each `1/1 Tasks running`, *Deployment status: Completed*. If a row
  shows `0/1` or *In progress* for more than 3 minutes, click it → **Events** tab: ECS writes one
  line per thing it did or failed to do. This is your first stop for every problem.
- Click `api` → **Tasks** tab → click the task id. You see: *Last status RUNNING*, *Health status
  HEALTHY* (that's the ALB health check), the private IP, the task definition revision, and the
  **Containers** section with the image digest and the CloudWatch log link.
- **Logs** tab on the task: your app's stdout. For `api` you should see the `{"msg":"api listening","port":4000}` line.
- **Task definitions** (left menu) → `nextagency-demo-api` → revision 1 → **JSON**: this is the
  recipe. Find `"secrets": [{"name":"REDIS_URL","valueFrom":"arn:aws:secretsmanager:…"}]` — the
  secret reference — and `"runtimePlatform": {"cpuArchitecture":"X86_64"}`.

**EC2 → Target groups**

- `nextagency-demo-api` → **Targets** tab: one registered target (the task's private IP:4000) with
  *Health status: healthy*. `nextagency-demo-web` likewise on :3000. **Unhealthy** here = the ALB
  can't get a 200 from the health check path, and ECS will keep killing and replacing the task.

**EC2 → Load balancers** → `nextagency-demo` → **Listeners and rules**: port 80, default → web TG,
rule priority 10: `/api/*` → api TG. Copy the **DNS name** — that's your URL.

**Now open it:** `http://<dns-name>` renders the dashboard; `http://<dns-name>/api/health` returns
`{"ok":true,"redis":"up"}`; `http://<dns-name>/api/admin/queues` is Bull Board. Click *Seed* on the
dashboard and watch the worker's log stream in CloudWatch fill with `completed` lines.

### 5.4 How a request actually travels (trace it once)

1. Browser resolves the ALB DNS name → two public IPs (one per AZ).
2. ALB listener :80 receives `GET /api/jobs/stats`, rule 10 matches `/api/*`, picks a healthy target
   from the api TG (a private IP like `10.40.10.37`).
3. Traffic crosses from the public subnet to the private-app subnet inside the VPC; the `sg_app`
   rule allows it because the source is `sg_alb`.
4. The api container answers; it talks to Redis at the ElastiCache endpoint in the private-data
   subnet (allowed by `sg_redis` because the source is `sg_app`).
5. The worker task, with no inbound path at all, is doing the same thing to Redis from another
   private-app IP. If it needs to call an external API it would leave via the NAT gateway's EIP.

Nothing in steps 3–5 has a public IP. That's the entire security argument of the Rails
`NETWORK_ARCHITECTURE.md`, reproduced.

---

## 6. Phase 10 — deploying, and what a rolling deployment looks like

### 6.1 Pushing an image to ECR (what `deploy.sh` does)

```bash
aws ecr get-login-password --profile personal --region us-east-1 \
  | docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com
docker buildx build --platform linux/amd64 -f docker/Dockerfile.api \
  -t 123456789012.dkr.ecr.us-east-1.amazonaws.com/nextagency-demo/api:<git-sha> --push .
```
The login token is valid for 12 hours. The image name *is* the repository URL; the tag is the git
SHA so you can always tell what's running. ECR → repository → you'll see the new tag, its size, and
the vulnerability scan result a minute later.

### 6.2 Registering a new task definition revision and rolling the service

`deploy.sh` copies the current task definition JSON, swaps the image tag, registers it as revision
N+1, then `aws ecs update-service --task-definition <new arn>`. Watch **ECS → service → Deployments**
tab while it runs:

1. A second deployment appears (*PRIMARY* = new, *ACTIVE* = old). Because `minimum_healthy = 100 %`
   and `maximum = 200 %`, ECS starts the new task *before* stopping the old one.
2. The new task goes PROVISIONING → PENDING → RUNNING (pulling the image is the slow part, ~30 s).
3. The ALB health check must pass twice (2 × 15 s) → target *healthy*.
4. The old task is *draining* for `deregistration_delay` (10 s) so in-flight requests finish, then
   STOPPED. The worker gets `SIGTERM` and up to `stopTimeout` (60 s) to finish its jobs — that's the
   graceful-shutdown code path from `docs/02-bullmq.md`.
5. The old deployment disappears; **Events** shows `service api has reached a steady state`.

`aws ecs wait services-stable` returns at step 5. Total: 1–2 minutes.

Terraform is **not** involved in deploys — `ignore_changes = [task_definition]` on the service tells
it to leave the revision alone. Terraform owns the *shape*; CI owns the *image*. That's the same
split the Rails `cicd.tf` implements.

### 6.3 Getting a shell inside a task (ECS Exec)

```bash
TASK=$(aws ecs list-tasks --profile personal --cluster nextagency-demo --service-name worker --query 'taskArns[0]' --output text)
aws ecs execute-command --profile personal --cluster nextagency-demo --task "$TASK" --container worker --interactive --command /bin/sh
```
Needs the *Session Manager plugin* (the plan installs it — no sudo needed if you unpack the `.deb`
into `~/.local`; ask if it fails). Inside: `env | grep REDIS_URL` shows the injected secret; `ps`
shows just `node apps/worker/dist/main.js` as PID 1's child. `exit` to leave. This is the Rails
`SSM_ACCESS_RUNBOOK.md` equivalent — no SSH, no bastion, audited in CloudTrail.

### 6.4 Reading logs

- Live tail: `aws logs tail /ecs/nextagency-demo/worker --profile personal --follow`
- Console: CloudWatch → Log groups → `/ecs/nextagency-demo/worker` → the stream named `ecs/worker/<task id>`.
- Search across everything: CloudWatch → **Logs Insights** → select the three groups → query:
  ```
  fields @timestamp, event, queue, jobId, error
  | filter event = "failed"
  | sort @timestamp desc
  ```
  This works because the worker logs one JSON object per line — CloudWatch parses the fields.

---

## 7. Phase 11 — GitHub Actions with OIDC (why there are no AWS keys in GitHub)

Flow, in order:

1. You push to `main`. GitHub starts the workflow with `permissions: id-token: write`.
2. `aws-actions/configure-aws-credentials` asks GitHub for an OIDC token — a signed JWT containing
   `sub: repo:msohaibnoor/nextagency-demo:ref:refs/heads/main`.
3. It calls `sts:AssumeRoleWithWebIdentity` with that token and the role ARN from the repo secret
   `AWS_DEPLOY_ROLE_ARN`.
4. AWS checks the role's **trust policy**: is the token signed by the provider registered in Phase 8?
   Is `aud` = `sts.amazonaws.com`? Does `sub` match `repo:<your repo>:ref:refs/heads/main`? All yes →
   temporary credentials (1 hour) for the `github-deploy` role.
5. That role can *only* push to the three ECR repos, register task definitions, update the three
   services, and read Terraform state. It cannot create a VPC, read the Redis secret, or touch
   anything tagged differently. Check it: IAM → Roles → `nextagency-demo-github-deploy` → Permissions.
6. The workflow runs the same `deploy.sh` you ran by hand. Actions tab shows three matrix jobs.

Where to see it happened: IAM → Roles → the role → **Last activity**; CloudTrail → Event history →
filter *Event name* = `AssumeRoleWithWebIdentity`.

---

## 8. Phase 12 — the failure drills, as you'll see them in the console

| Drill | What you do | What the console shows | What you learn |
|---|---|---|---|
| Bad deployment | Deploy an api image whose `/api/health` returns 500 | Service → Deployments: new deployment stuck; TG target *unhealthy*; Events: `(service api) (task …) failed container health checks` ×N, then `deployment circuit breaker: rolling back to …:<old revision>`; the old task never stopped, so the site never went down | The circuit breaker + `minimum_healthy 100 %` is your safety net; the ALB never routed to the bad task |
| Kill the worker mid-batch | `aws ecs stop-task` on the worker task while 200 jobs are queued | Tasks tab: one STOPPED (*reason: drill*), a new one PROVISIONING within seconds; Bull Board: `active` drops to 0 then climbs; some jobs show a `stalled` event and are retried | ECS replaces tasks; BullMQ's stalled-job detection (30 s) re-queues work the dead task held |
| Scale worker to 2 | `update-service --desired-count 2` | Two RUNNING worker tasks in different AZs (ECS spreads them); the rate-limited queue still drains at 5 per 10 s in total | Horizontal scaling is a number; the limiter lives in Redis, so it's global |

---

## 9. Troubleshooting — symptom → where to look → usual cause

| Symptom | Look at | Usual cause |
|---|---|---|
| Service `0/1`, tasks cycle PENDING → STOPPED | Task → *Stopped reason* | `CannotPullContainerError`: image tag doesn't exist in ECR (Task 9.6 order) or execution role lacks ECR pull. `ResourceInitializationError: unable to pull secrets`: execution role can't read the secret, or the task has no route to Secrets Manager (NAT missing / private-data subnet by mistake) |
| Task RUNNING but TG target *unhealthy*, task replaced every ~1 min | Task **Logs** | App crashed or listens on the wrong port/interface (`HOSTNAME=0.0.0.0` for Next); `/api/health` returning non-200 because Redis is down (see next row) |
| `/api/health` → `"redis":"down"`; worker logs `ECONNREFUSED` or TLS errors | ElastiCache status; `sg_redis` inbound; the secret's value | SG doesn't allow 6379 from `sg_app`; wrong endpoint in the secret; `redis://` instead of `rediss://` when transit encryption is on |
| ALB returns `503 Service Unavailable` | Target group → Targets | No healthy targets. Either tasks are unhealthy (rows above) or the listener rule points at the wrong TG |
| ALB returns `502 Bad Gateway` | Task logs | App closed the connection / crashed mid-request |
| `terraform apply` hangs at `aws_elasticache_replication_group` | Nothing — wait | Normal: 6–8 min to create, ~5 to destroy |
| `terraform apply` error `Error acquiring the state lock` | DynamoDB table → Explore items | A previous run died. `terraform force-unlock <ID>` (the ID is in the error) |
| `terraform plan` wants to destroy the ALB / Redis unexpectedly | Stop | Usually a renamed resource or a changed immutable attribute. Ask before applying |
| `aws … --profile personal` → `Unable to locate credentials` | `~/.aws/credentials` | Profile not configured, or the terminal doesn't have `~/.local/bin` in PATH and is running a different `aws` |
| Console shows nothing | Region selector top-right | You're not in us-east-1 |
| `execute-command` → `TargetNotConnectedException` | Task definition; task role | `enable_execute_command` false on the service, task role lacks `ssmmessages:*`, or the task started before the setting changed (redeploy it) |
| Budget e-mail arrives after you thought you destroyed | §11 checklist | NAT gateway or ElastiCache left behind (they're the money) |

The universal first move: **ECS → cluster → service → Events**, then **task → Stopped reason**, then
**task → Logs**. Ninety percent of problems announce themselves there.

---

## 10. CLI cheat sheet (all with `--profile personal --region us-east-1`, or `export AWS_PROFILE=personal AWS_REGION=us-east-1` once)

```bash
# who am I
aws sts get-caller-identity

# ECS
aws ecs list-clusters
aws ecs describe-services --cluster nextagency-demo --services api worker web --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount,status:deployments[0].rolloutState}'
aws ecs describe-services --cluster nextagency-demo --services api --query 'services[0].events[:10]'
aws ecs list-tasks --cluster nextagency-demo --service-name worker
aws ecs describe-tasks --cluster nextagency-demo --tasks <arn> --query 'tasks[0].{status:lastStatus,health:healthStatus,stopped:stoppedReason}'
aws ecs update-service --cluster nextagency-demo --service worker --desired-count 2
aws ecs update-service --cluster nextagency-demo --service api --force-new-deployment   # redeploy same revision
aws ecs stop-task --cluster nextagency-demo --task <arn> --reason drill

# logs
aws logs tail /ecs/nextagency-demo/api --follow --since 10m

# load balancer health
aws elbv2 describe-target-health --target-group-arn $(aws elbv2 describe-target-groups --names nextagency-demo-api --query 'TargetGroups[0].TargetGroupArn' --output text)

# ECR
aws ecr describe-images --repository-name nextagency-demo/api --query 'imageDetails[].{tags:imageTags,pushed:imagePushedAt,size:imageSizeInBytes}'

# secrets (only you can do this; the app never needs to)
aws secretsmanager get-secret-value --secret-id nextagency-demo/production/redis-url --query SecretString --output text

# what's still running / costing money
aws ec2 describe-nat-gateways --filter Name=state,Values=available --query 'NatGateways[].NatGatewayId'
aws elasticache describe-replication-groups --query 'ReplicationGroups[].ReplicationGroupId'
aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName'
```

---

## 11. Phase 13 — teardown, and proving nothing is left

1. `cd infra/production && AWS_PROFILE=personal terraform destroy` → type `yes`. ~8 minutes. Watch
   the count: it should destroy the same number the first apply added.
2. Verify with the three "still running" commands in §10 — all should print `[]`.
3. Console double-check, region us-east-1: **ECS → Clusters** empty; **VPC → Your VPCs** shows only
   the default VPC (or none); **EC2 → Load balancers** empty; **ElastiCache** empty; **Secrets
   Manager** empty (`recovery_window_in_days = 0` means it's gone immediately, not "scheduled").
4. **Tag search for stragglers:** Resource Groups & Tag Editor → Regions: us-east-1 → Resource types:
   All → Tags: `Project` = `nextagency-demo` → Search. Expect only the bootstrap items (state bucket,
   lock table) if you kept `bootstrap/`.
5. Decide on `bootstrap/`: keep it (≈ $0.05/month, lets you re-run the demo with one `apply`) or
   `cd infra/bootstrap && terraform destroy` for zero footprint.
6. **Delete the IAM user** `nextagency-demo-admin` (IAM → Users → select → Delete) once you're fully
   done, and remove the `[personal]` block from `~/.aws/credentials`.
7. 24 h later: `scripts/cost-check.sh` (or Billing → Cost Explorer, filter tag `Project`) shows the
   real total. Write it into `docs/10-teardown-and-cost.md` next to the estimate.

---

## 12. Mapping back to NextAgency's real Terraform

When you open `terraform/production/` in the Rails repo after this demo, everything will look
familiar — it's the same stack with production concerns added:

| Demo | NextAgency production | The difference |
|---|---|---|
| `network.tf` 2 AZ, 1 NAT | 3 AZ, NAT per AZ, VPC endpoints, flow logs | Availability + not paying NAT for AWS-internal traffic |
| `data_stores.tf` one Redis node | Aurora PostgreSQL cluster + Redis replication group + OpenSearch | The data tier is where the money and the compliance are |
| `secrets.tf` one secret | Several, plus a KMS customer-managed key | HIPAA encryption requirements |
| `compute.tf` 3 services, 1 task each | web + Sidekiq worker services, autoscaling, multiple queues' worth of workers | Same shape, bigger numbers |
| `cicd.tf` | Identical pattern, branch-pinned OIDC trust | You've now done the hard part |
| no WAF, no alarms | `waf.tf`, `alarms.tf` (19 CloudWatch alarms), New Relic | Production observability |
| ALB :80 | ACM certificate, HTTPS listener, HTTP→HTTPS redirect, Route 53 | You skipped this only because there's no domain |

The runbooks in that directory (`SSM_ACCESS_RUNBOOK.md`, `DB_SNAPSHOT_RESTORE_RUNBOOK.md`,
`REDIS_SNAPSHOT_RESTORE_RUNBOOK.md`) are the operational layer this demo doesn't have — worth reading
after Phase 12, when the words in them will all mean something.
