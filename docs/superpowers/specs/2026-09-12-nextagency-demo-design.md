# NextAgency Demo — Design Spec

**Date:** 2026-09-12
**Status:** approved in conversation; amended 2026-09-13 after the final whole-branch review to match what was built (changes marked *(as built)*)
**Purpose:** a throwaway-quality but production-shaped learning project that rehearses the
NextAgency V3 platform decisions — pnpm + Turborepo monorepo, NestJS API + separate BullMQ worker,
Next.js front end, Terraform-managed AWS (ECS Fargate, ALB, ElastiCache), and GitHub-OIDC CI/CD —
in a personal AWS account, for 2–3 days, then destroyed.

This is a learning project. It carries no real data. Decisions below prefer *the pattern V3 will
use* over the simplest thing that works.

---

## 1. Decisions already made

| Topic | Decision | Reason |
|---|---|---|
| Location | `~/nextagency-demo`, own git repo, pushed to GitHub as `nextagency-demo` | Separate from the Rails checkout |
| Package manager | pnpm 10 workspaces + Turborepo | What V3 will use |
| Runtime | Node 22 (`.nvmrc`, `engines`) | Current LTS |
| Region | `us-east-1` | User's choice |
| Domain / TLS | None. Plain HTTP on the ALB's DNS name | No hosted zone in the personal account |
| Database | None. Redis only (BullMQ + a results sorted set per queue, *as built*) | User's choice; keeps AWS surface small |
| Services | Three Fargate services: `web`, `api`, `worker` (approach A) | Mirrors Rails `web` + Sidekiq split |
| CPU arch | `linux/amd64` images, Fargate `X86_64` | arm64 via QEMU measured at ~77 min per image on the dev laptop (2026-09-13); x86 costs ≈ $0.20/day more for this demo |
| NAT | One NAT gateway in one AZ | Keeps the private-subnet pattern; ~$1.10/day |
| Deploy path | Phase 1 local `scripts/deploy.sh`; Phase 2 GitHub Actions with OIDC | Learn each step, then automate it |
| Budget | ≈ $3.70/day; `terraform destroy` after 2–3 days | Budget alarm is the first resource created |

Out of scope (deliberately): RDS/Aurora, OpenSearch, WAF, KMS CMK, VPC endpoints, flow logs,
CloudWatch alarms, New Relic, multi-AZ NAT, HTTPS, authentication on any route, Turborepo remote
cache, sandboxed BullMQ processors.

---

## 2. Repository layout

```
nextagency-demo/
├── apps/
│   ├── web/                Next.js 15, App Router, one page, output: 'standalone'
│   ├── api/                NestJS 11 — HTTP :4000, BullMQ producers, Bull Board
│   └── worker/             NestJS 11 — application context only, BullMQ consumers
├── packages/
│   ├── queue/              @demo/queue: queue names, payload types, Redis connection factory
│   ├── tsconfig/           @demo/tsconfig: base.json, nest.json, next.json
│   └── eslint-config/      @demo/eslint-config
├── infra/
│   ├── bootstrap/          Terraform root 1 (local state)
│   └── production/         Terraform root 2 (S3 backend)
├── docker/
│   ├── Dockerfile.api
│   ├── Dockerfile.worker
│   ├── Dockerfile.web
│   └── docker-compose.yml  redis (default profile); api+worker+web images (--profile full)
├── scripts/
│   ├── deploy.sh           build → ECR push → ecs update-service → wait
│   ├── seed-queue.ts       CLI producer (count, fail-rate, queue)
│   └── cost-check.sh       Cost Explorer for tag Project=nextagency-demo
├── docs/                   NN-<topic>.md learning notes, one per phase
├── .github/workflows/deploy.yml
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
└── .nvmrc
```

### Turborepo

- `turbo.json` tasks: `build` (`dependsOn: ["^build"]`, `outputs: [".next/**", "!.next/cache/**", "dist/**"]`),
  `dev` (`cache: false`, `persistent: true`), `lint`, `typecheck`, `test`.
- Filtering is used by every Dockerfile: `turbo prune <app> --docker` produces `out/json`,
  `out/pnpm-lock.yaml`, `out/full`, so the worker image never installs or builds Next.js.
- Verification: a second `turbo build` reports `FULL TURBO`; `turbo build --filter=worker...`
  builds `@demo/queue` and `worker` only.

---

## 3. Queue design (`packages/queue`)

```ts
export const QUEUES = {
  renewalReminders: 'renewal-reminders',
  reports:          'reports',
  nightlySweep:     'nightly-sweep',
  rateLimitedSync:  'rate-limited-sync',
} as const;

export interface RenewalReminderJob { policyId: string; agencyId: string; renewalDate: string; failRate?: number }
export interface ReportJob          { agencyId: string; month: string }          // parent
export interface ReportStepJob      { agencyId: string; month: string; step: 'gather' | 'render' | 'email' }
export interface RateLimitedSyncJob { carrierId: string }
export interface JobResult          { jobId: string; queue: string; finishedAt: string; summary: string }

export function redisConnectionOptions(env: NodeJS.ProcessEnv): ConnectionOptions
// parses REDIS_URL; 'rediss://' → { tls: {} }; supports password from the URL
```

| Queue | Producer | Worker behaviour | Concepts |
|---|---|---|---|
| `renewal-reminders` | `POST /api/jobs/seed` body `{count, failRate, queue}` (bounded: `count` 0–5000, `failRate` 0–1, `queue` must be seedable, *as built*); `scripts/seed-queue.ts` | Sleeps 100–500 ms, throws with probability `failRate`, writes `JobResult` to sorted set `results:renewal-reminders` (ZADD scored by time, trimmed to 1,000 in a MULTI, *as built*) | `attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }`, `removeOnComplete: 100`, `removeOnFail: 500`, `failed` event as DLQ |
| `reports` | `POST /api/jobs/report` | `FlowProducer` adds parent `report` with **nested** children `email` ← `render` ← `gather` (deepest runs first, so the order is gather → render → email → parent); each step reads the previous step's return value via `getChildrenValues()` (keys are full job keys `bull:reports:<id>`); every node carries `removeOnComplete: 20` (*as built*) | Flows, `getChildrenValues()` |
| `nightly-sweep` | `api` registers on startup with `queue.upsertJobScheduler('nightly-sweep', { pattern: '*/5 * * * *' }, { name, data, opts: { removeOnComplete: 20 } })` (*as built* — the v5 job-scheduler API, idempotent by scheduler id) | Logs a line, `ZCARD`s each results sorted set | Job schedulers, de-duplication |
| `rate-limited-sync` | seed with `queue=rate-limited-sync` | `limiter: { max: 5, duration: 10_000 }` | Rate limiting |

Worker-side, every processor has `concurrency` set (5 for reminders, 2 for reports, 1 for sweep,
5 for sync) so parallelism is visible in Bull Board. Each processor logs its own `completed` /
`failed` events through `@OnWorkerEvent` handlers (*as built* — no separate `QueueEvents`
listener) as `{ ts, event, queue, jobId, ... }` JSON lines to stdout.

Graceful shutdown (*as built*): `main.ts` calls `app.enableShutdownHooks()`; on `SIGTERM` Nest runs
`onApplicationShutdown`, `@nestjs/bullmq` calls `Worker.close()` on every processor (waits for
in-flight jobs), and a `RedisClient` provider `quit()`s the plain ioredis connection; the process
exits 0. Fargate `stopTimeout` on the worker container is set to 60 s.

---

## 4. `apps/api`

- `@nestjs/bullmq` `BullModule.forRoot({ connection: redisConnectionOptions(process.env) })`;
  `BullModule.registerQueue` for the four queues; `BullModule.registerFlowProducer` for reports.
- Routes (global prefix `api`):
  - `GET /api/health` → `{ ok: true, redis: 'up' }` or `{ ok: false, redis: 'down' }` — always
    HTTP 200 (Redis state is reported, not used to condemn the task); `ping()` is raced against a
    1 s timeout (*as built*). ALB health check target for `api`.
  - `POST /api/jobs/seed` (`count`, `failRate`, `queue`) → enqueues, returns job ids. Inputs are
    bounded (*as built*): `count` clamped to 0–5000, `failRate` to 0–1, `queue` must be
    `renewal-reminders` or `rate-limited-sync` (400 otherwise).
  - `POST /api/jobs/report` (`agencyId`, `month`) → adds a flow, returns parent id.
  - `GET /api/jobs/stats` → `queue.getJobCounts()` for every queue.
  - `GET /api/jobs/:queue/:id` → job state, attempts, return value / failed reason.
  - `GET /api/admin/queues` → Bull Board (`@bull-board/nestjs`, `@bull-board/express`). No auth — noted gap.
- Listens on `PORT` (4000). `CORS` off (same-origin via ALB).
- Tests: one e2e test (`supertest` + local Redis) that seeds 5 jobs and polls `/api/jobs/stats`
  until `completed === 5` — requires the worker to be running in the same test process
  (test boots both Nest apps).

## 5. `apps/worker`

- `NestFactory.createApplicationContext(WorkerModule)`; no HTTP.
- One `@Processor(QUEUES.x)` class per queue extending `WorkerHost`.
- `ResultsStore` service writes to Redis sorted set `results:<queue>` (`ZADD` scored by
  `Date.now()`, `ZREMRANGEBYRANK` in the same `MULTI`) and trims to the last 1,000 entries
  (*as built* — a hash's `HKEYS` order is not insertion order, so "oldest first" needs a ZSET).
- Unit tests for processor logic as pure functions (fail-rate decision, report step composition).

## 6. `apps/web`

- One route `/`: server component fetches `${API_URL}/api/jobs/stats` with `cache: 'no-store'`,
  renders a table (queue × waiting/active/completed/failed/delayed), and a client component with
  two buttons (`Seed 50 reminders (20% fail)`, `Run report flow`) that `POST` to `/api/...` and
  `router.refresh()`. Link to `/api/admin/queues`.
- `API_URL`: server-side only. Local `http://localhost:4000`; on Fargate `http://<alb-dns>`.
  Browser-side calls use relative `/api/...` so the ALB routes them.
- `next.config.js`: `output: 'standalone'`, plus a `/api/:path*` rewrite to `API_URL` for local
  `next dev`. Next resolves `rewrites()` at build time, so `Dockerfile.web` takes `API_URL` as a
  build `ARG` (*as built*); on Fargate the rewrite is never hit because the ALB routes `/api/*`
  to the api target group first.
- `GET /healthz` → `{ ok: true }` (`force-dynamic`) — the web target group's health check, so a
  web task is not condemned when the api is mid-rollout (*as built*).

---

## 7. Docker

Each Dockerfile is the same four-stage pattern:

1. `pruner` — `node:22-alpine`, `pnpm dlx turbo prune <app> --docker`.
2. `installer` — copy `out/json` + lockfile, `pnpm install --frozen-lockfile`.
3. `builder` — copy `out/full`, `pnpm turbo build --filter=<app>...`.
4. `runner` — `node:22-alpine`, non-root `node` user. web copies `apps/web/.next/standalone` +
   `.next/static`; api/worker copy the whole `/app` from the installer stage (*as built* —
   `pnpm prune --prod` is skipped because on pnpm 10 it breaks the pruned, symlinked workspace
   layout; images are ~500 MB). `HEALTHCHECK` on api only, `CMD ["node", "..."]`.

`docker-compose.yml`: service `redis` (`redis:7-alpine`, port 6379) in the default profile;
`api`, `worker`, `web` built from the Dockerfiles in profile `full`, wired with
`REDIS_URL=redis://redis:6379`, `API_URL=http://api:4000`.

---

## 8. Terraform

### `infra/bootstrap/` (local state, applied once, kept after demo)

| Resource | Notes |
|---|---|
| `aws_s3_bucket` state bucket | versioning, SSE-S3, public access block |
| `aws_dynamodb_table` lock table | `LockID` hash key, on-demand billing |
| `aws_budgets_budget` | `$20` monthly, `COST`, notifications at 50 % and 100 % actual to `var.alert_email` |
| `aws_iam_openid_connect_provider` GitHub | `token.actions.githubusercontent.com`; account-global, so it lives here, not in `production/` |
| outputs | bucket name, table name, OIDC provider ARN |

### `infra/production/` (S3 backend)

`default_tags`: `Project=nextagency-demo`, `Environment=production`, `ManagedBy=terraform`.

| File | Contents |
|---|---|
| `versions.tf` | Terraform ≥ 1.9, AWS provider ~> 5.80, `random` provider ~> 3.6 (for the Redis auth token), S3 backend (bucket/table from bootstrap outputs, hard-coded after first apply); no `profile` on the provider — credentials come from `AWS_PROFILE` / the CI session (*as built*); `.terraform.lock.hcl` committed |
| `variables.tf` | `region`, `vpc_cidr = "10.40.0.0/16"`, `image_tag` (default `"bootstrap"`), `github_repo` (`owner/nextagency-demo`), `github_branch = "main"`, `task_cpu = 256`, `task_memory = 512`, `github_oidc_provider_arn` (from bootstrap output), `github_owner_id = "73883272"`, `github_repo_id = "1367206627"` (*as built*) |
| `network.tf` | VPC; 2 AZs; subnets via `cidrsubnet(var.vpc_cidr, 8, i)` with offsets 0/10/20 for public / private-app / private-data; IGW; one EIP + NAT in public-a; public RT → IGW; private RT → NAT; data subnets get no default route |
| `security.tf` | `sg_alb` (ingress 80/tcp from 0.0.0.0/0), `sg_app` (ingress 3000 & 4000 from `sg_alb`), `sg_redis` (ingress 6379 from `sg_app`); all egress open |
| `data_stores.tf` | `aws_elasticache_subnet_group` (data subnets); `aws_elasticache_replication_group`: engine redis 7.1, `cache.t4g.micro`, 1 node, `transit_encryption_enabled`, `at_rest_encryption_enabled`, `auth_token = random_password.redis.result`, `automatic_failover_enabled = false` |
| `secrets.tf` | `aws_secretsmanager_secret` `nextagency-demo/production/redis-url` with version `rediss://:<token>@<primary-endpoint>:6379`; `recovery_window_in_days = 0` so destroy is immediate |
| `ecr.tf` | 3 × `aws_ecr_repository` (`force_delete = true`, scan on push) + lifecycle policy keep last 10 |
| `logs.tf` | 3 × `aws_cloudwatch_log_group` `/ecs/nextagency-demo/<app>`, 7-day retention |
| `iam.tf` | `ecs_execution` role: `AmazonECSTaskExecutionRolePolicy` + `secretsmanager:GetSecretValue` on the one secret. `ecs_task` role: `ssmmessages:*` for ECS Exec only |
| `compute.tf` | `aws_ecs_cluster` (containerInsights enabled); 3 `aws_ecs_task_definition` (Fargate, `X86_64`, `LINUX`, 256/512, `awslogs`, `secrets: [{name: REDIS_URL, valueFrom: secret ARN}]`, web gets `API_URL = "http://${aws_lb.this.dns_name}"`, per-container `stopTimeout` 30/60/30); `aws_lb` (application, public subnets, `sg_alb`); 2 `aws_lb_target_group` (ip type, `deregistration_delay = 10`, web :3000 health `/healthz`, api :4000 health `/api/health`); listener :80 default → web TG, rule priority 10 `path_pattern ["/api/*"]` → api TG; 3 `aws_ecs_service` (`desired_count = 1`, private-app subnets, `sg_app`, `assign_public_ip = false`, `enable_execute_command = true`, `deployment_circuit_breaker { enable = true, rollback = true }`, min/max healthy 100/200 %, `health_check_grace_period_seconds = 60` on web/api, `propagate_tags = "SERVICE"` + `enable_ecs_managed_tags = true` so Fargate tasks carry the `Project` tag, `web`/`api` with `load_balancer` block, `worker` without); `depends_on` listener + rule, the execution role's secrets policy/managed attachment, and `aws_secretsmanager_secret_version.redis_url`; `lifecycle { ignore_changes = [task_definition] }` (*as built*) |
| `cicd.tf` | `aws_iam_role` `github-deploy` trusting the bootstrap OIDC provider with `sub` `StringLike` a **list**: `repo:<owner>@<github_owner_id>/<name>@<github_repo_id>:ref:refs/heads/<branch>` (GitHub's 2026 id-pinned claim) plus the classic `repo:<owner>/<name>:ref:…`; inline policy: `ecr:GetAuthorizationToken` (*), ECR push actions on the 3 repos, `ecs:UpdateService`/`DescribeServices` on the 3 services, `ecs:DescribeTaskDefinition`/`RegisterTaskDefinition`, `iam:PassRole` on the two roles conditioned on `iam:PassedToService = ecs-tasks.amazonaws.com`, `elasticloadbalancing:DescribeLoadBalancers`; **no** Terraform-state (S3/DynamoDB) grants — state holds the Redis token (*as built*) |
| `outputs.tf` | `alb_dns_name`, `ecr_repository_urls` (map), `cluster_name`, `service_names` (map), `github_deploy_role_arn`, `redis_secret_arn` |

Image lifecycle: task definitions reference `"${repo}:${var.image_tag}"`. First `apply` uses
`image_tag = "bootstrap"`, so **images must be pushed before the first apply** (otherwise services
sit in a pull-failure loop; the plan orders this correctly). Subsequent app deploys register a
**new task-definition revision** pinned to the git-SHA tag (`:latest` is pushed too but never
referenced by a revision) and `update-service` to it — traceable and rollback-able by revision
(*as built*, see §9); Terraform is not re-run for app releases (`ignore_changes = [task_definition]`).

---

## 9. Deployment

### `scripts/deploy.sh <api|worker|web> [tag]`

1. `TAG=${2:-$(git rev-parse --short HEAD)}`; reject any app other than `api|worker|web`; derive
   the ECR URL from `sts get-caller-identity` + fixed names, `CLUSTER=nextagency-demo`,
   `SERVICE=$APP`, and the ALB DNS from `elbv2 describe-load-balancers` — **no Terraform**
   (*as built*; `terraform output` was dropped so the CI role needs no state access).
2. `docker buildx build --platform linux/amd64 -f docker/Dockerfile.$APP -t $REPO:$TAG -t $REPO:latest --push .`
   (after `aws ecr get-login-password | docker login`).
3. `describe-task-definition` the service's current revision, `jq` in the new image, strip the
   server-assigned fields, `register-task-definition` → `$NEW_TD`; `update-service --task-definition $NEW_TD`.
4. `aws ecs wait services-stable`, then verify the PRIMARY deployment is `$NEW_TD` with
   `rolloutState == COMPLETED` (exit 1 with the last 5 service events otherwise — a circuit-breaker
   rollback also reads as "stable"); print the ALB URL.

### `.github/workflows/deploy.yml`

- Trigger: `push` to `main` (`paths-ignore: docs/**, **.md`), plus `workflow_dispatch`.
- `permissions: { id-token: write, contents: read }`; `concurrency: deploy-${{ github.ref }}`,
  `cancel-in-progress: false` (pushes queue rather than race).
- `aws-actions/configure-aws-credentials@v4` with `role-to-assume: <github_deploy_role_arn>`, region.
- Matrix over `[api, worker, web]`, each running `scripts/deploy.sh $APP ${GITHUB_SHA::7}`.
- Uses `setup-buildx-action` for native amd64 builds. No Terraform is installed or run in CI
  (*as built*).

---

## 10. Verification ladder

| # | Phase | Done when |
|---|---|---|
| 1 | Monorepo | `pnpm turbo build` twice → second prints `FULL TURBO`; `--filter=worker...` skips `web` |
| 2 | BullMQ local | Seed 50 @ 20 % fail → Bull Board: all 50 eventually complete bar ≈ 0.2³ ≈ 0.8 % (the fail roll is per attempt, so ≈ 10 first-attempt failures retry and ≈ 0–1 exhaust 3 attempts); report parent completes after 3 children; sweep fires every 5 min; rate-limited queue drains 5 per 10 s |
| 3 | Images | `docker compose --profile full up` → `localhost:3000` renders stats; seed button changes them |
| 4 | Bootstrap | Budget confirmation e-mail received; state bucket + lock table exist; OIDC provider exists |
| 5 | Production apply | `terraform apply` clean; `curl http://$ALB/api/health` → 200; landing page renders via ALB |
| 6 | Deploy | `scripts/deploy.sh api` rolls the service; `aws ecs execute-command` into worker succeeds; `aws logs tail /ecs/nextagency-demo/worker --follow` shows job JSON lines |
| 7 | CI/CD | Push to `main` → workflow green → new task revision live; no AWS keys anywhere |
| 8 | Failure drills | Bad image (health check 500) → circuit breaker rolls back; stop the worker task mid-seed → graceful drain (SIGTERM → `Worker.close()` finishes in-flight jobs, no `stalled` events) and the replacement task drains the queue; scale to 2 → limiter still global |
| 9 | Teardown | `terraform destroy` in `production/` completes; `scripts/cost-check.sh` shows the bill |

## 11. Learning notes

One `docs/NN-<topic>.md` per phase, written when the phase is verified, each ≤ 1 page:
`01-turborepo`, `02-bullmq`, `03-docker-monorepo`, `04-terraform-state-and-roots`,
`05-vpc-three-tier`, `06-ecs-fargate-roles-and-tasks`, `07-alb-routing`, `08-deploy-and-oidc`,
`09-failure-drills`, `10-teardown-and-cost`.

## 12. Risks & known gaps

- Bull Board and every API route are unauthenticated and internet-reachable via the ALB for the
  demo's lifetime. Acceptable for 2–3 days with dummy data; must not be copied to V3. The seed
  endpoint is at least bounded (`count` ≤ 5000, `failRate` ∈ [0, 1], seedable queues only) so an
  anonymous caller cannot enqueue unbounded work (*as built*).
- Native amd64 builds; no QEMU emulation needed for CI or local Fargate images.
- ElastiCache creation ≈ 6–8 min; destroy ≈ 5 min. Total apply ≈ 10 min.
- Terraform, AWS CLI and `gh` are not yet installed locally; the plan starts there.
- No HTTPS: browsers may warn; irrelevant for the demo.
