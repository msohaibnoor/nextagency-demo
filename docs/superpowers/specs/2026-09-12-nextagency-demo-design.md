# NextAgency Demo — Design Spec

**Date:** 2026-09-12
**Status:** approved in conversation, pending written review
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
| Database | None. Redis only (BullMQ + a results hash) | User's choice; keeps AWS surface small |
| Services | Three Fargate services: `web`, `api`, `worker` (approach A) | Mirrors Rails `web` + Sidekiq split |
| CPU arch | `linux/arm64` images, Fargate `ARM64` | Cheaper; matches `t4g` sizing |
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
| `renewal-reminders` | `POST /api/jobs/seed?count=50&failRate=0.2`; `scripts/seed-queue.ts` | Sleeps 100–500 ms, throws with probability `failRate`, writes `JobResult` to hash `results:renewal-reminders` | `attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }`, `removeOnComplete: 100`, `removeOnFail: 500`, `failed` event as DLQ |
| `reports` | `POST /api/jobs/report` | `FlowProducer` adds parent `report` with **nested** children `email` ← `render` ← `gather` (deepest runs first, so the order is gather → render → email → parent); each step reads the previous step's return value via `getChildrenValues()` | Flows, `getChildrenValues()` |
| `nightly-sweep` | `api` registers on startup with `repeat: { pattern: '*/5 * * * *' }`, fixed `jobId: 'nightly-sweep'` | Logs a line, counts keys in the results hashes | Repeatable jobs, de-duplication |
| `rate-limited-sync` | seed with `queue=rate-limited-sync` | `limiter: { max: 5, duration: 10_000 }` | Rate limiting |

Worker-side, every processor has `concurrency` set (5 for reminders, 1 for sweep, 5 for sync) so
parallelism is visible in Bull Board. A `QueueEvents` listener per queue logs
`{ event, queue, jobId, ts, ... }` as JSON lines to stdout.

Graceful shutdown: `worker` traps `SIGTERM`, calls `await worker.close()` on every processor, exits 0.
Fargate `stopTimeout` on the worker container is set to 60 s.

---

## 4. `apps/api`

- `@nestjs/bullmq` `BullModule.forRoot({ connection: redisConnectionOptions(process.env) })`;
  `BullModule.registerQueue` for the four queues; `BullModule.registerFlowProducer` for reports.
- Routes (global prefix `api`):
  - `GET /api/health` → `{ ok: true, redis: 'up' | 'down' }` — ALB health check target.
  - `POST /api/jobs/seed` (`count`, `failRate`, `queue`) → enqueues, returns job ids.
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
- `ResultsStore` service writes to Redis hash `results:<queue>` (`HSET jobId JSON`) and trims to
  the last 1,000 entries.
- Unit tests for processor logic as pure functions (fail-rate decision, report step composition).

## 6. `apps/web`

- One route `/`: server component fetches `${API_URL}/api/jobs/stats` with `cache: 'no-store'`,
  renders a table (queue × waiting/active/completed/failed/delayed), and a client component with
  two buttons (`Seed 50 reminders (20% fail)`, `Run report flow`) that `POST` to `/api/...` and
  `router.refresh()`. Link to `/api/admin/queues`.
- `API_URL`: server-side only. Local `http://localhost:4000`; on Fargate `http://<alb-dns>`.
  Browser-side calls use relative `/api/...` so the ALB routes them.
- `next.config.js`: `output: 'standalone'`.

---

## 7. Docker

Each Dockerfile is the same four-stage pattern:

1. `pruner` — `node:22-alpine`, `pnpm dlx turbo prune <app> --docker`.
2. `installer` — copy `out/json` + lockfile, `pnpm install --frozen-lockfile`.
3. `builder` — copy `out/full`, `pnpm turbo build --filter=<app>...`.
4. `runner` — `node:22-alpine`, non-root `node` user, copy only built output
   (`apps/web/.next/standalone` for web; `apps/<app>/dist` + pruned `node_modules` for api/worker),
   `HEALTHCHECK` on api only, `CMD ["node", "..."]`.

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
| `versions.tf` | Terraform ≥ 1.9, AWS provider ~> 5.x, S3 backend (bucket/table from bootstrap outputs, hard-coded after first apply) |
| `variables.tf` | `region`, `vpc_cidr = "10.40.0.0/16"`, `image_tag` (default `"bootstrap"`), `github_repo` (`owner/nextagency-demo`), `github_branch = "main"`, `task_cpu = 256`, `task_memory = 512` |
| `network.tf` | VPC; 2 AZs; subnets via `cidrsubnet(var.vpc_cidr, 8, i)` with offsets 0/10/20 for public / private-app / private-data; IGW; one EIP + NAT in public-a; public RT → IGW; private RT → NAT; data subnets get no default route |
| `security.tf` | `sg_alb` (ingress 80/tcp from 0.0.0.0/0), `sg_app` (ingress 3000 & 4000 from `sg_alb`), `sg_redis` (ingress 6379 from `sg_app`); all egress open |
| `data_stores.tf` | `aws_elasticache_subnet_group` (data subnets); `aws_elasticache_replication_group`: engine redis 7.1, `cache.t4g.micro`, 1 node, `transit_encryption_enabled`, `at_rest_encryption_enabled`, `auth_token = random_password.redis.result`, `automatic_failover_enabled = false` |
| `secrets.tf` | `aws_secretsmanager_secret` `nextagency-demo/production/redis-url` with version `rediss://:<token>@<primary-endpoint>:6379`; `recovery_window_in_days = 0` so destroy is immediate |
| `ecr.tf` | 3 × `aws_ecr_repository` (`force_delete = true`, scan on push) + lifecycle policy keep last 10 |
| `logs.tf` | 3 × `aws_cloudwatch_log_group` `/ecs/nextagency-demo/<app>`, 7-day retention |
| `iam.tf` | `ecs_execution` role: `AmazonECSTaskExecutionRolePolicy` + `secretsmanager:GetSecretValue` on the one secret. `ecs_task` role: `ssmmessages:*` for ECS Exec only |
| `compute.tf` | `aws_ecs_cluster` (containerInsights enabled); 3 `aws_ecs_task_definition` (Fargate, `ARM64`, `LINUX`, 256/512, `awslogs`, `secrets: [{name: REDIS_URL, valueFrom: secret ARN}]`, web gets `API_URL = "http://${aws_lb.this.dns_name}"`); `aws_lb` (application, public subnets, `sg_alb`); 2 `aws_lb_target_group` (ip type, web :3000 health `/`, api :4000 health `/api/health`); listener :80 default → web TG, rule priority 10 `path_pattern ["/api/*"]` → api TG; 3 `aws_ecs_service` (`desired_count = 1`, private-app subnets, `sg_app`, `assign_public_ip = false`, `enable_execute_command = true`, `deployment_circuit_breaker { enable = true, rollback = true }`, `web`/`api` with `load_balancer` block, `worker` without); `depends_on` listener |
| `cicd.tf` | `aws_iam_role` `github-deploy` trusting the bootstrap OIDC provider with `sub` = `repo:${var.github_repo}:ref:refs/heads/${var.github_branch}`; inline policy: `ecr:GetAuthorizationToken` (*), ECR push actions on the 3 repos, `ecs:UpdateService`/`DescribeServices` on the 3 services, `ecs:RegisterTaskDefinition`, `iam:PassRole` on the two roles |
| `outputs.tf` | `alb_dns_name`, `ecr_repository_urls` (map), `cluster_name`, `service_names` (map), `github_deploy_role_arn` |

Image lifecycle: task definitions reference `"${repo}:${var.image_tag}"`. First `apply` uses
`image_tag = "bootstrap"`, so **images must be pushed before the first apply** (otherwise services
sit in a pull-failure loop; the plan orders this correctly). Subsequent app deploys call
`ecs update-service --force-new-deployment` with a `:latest`-style moving tag **plus** a git-SHA
tag for traceability; Terraform is not re-run for app releases.

---

## 9. Deployment

### `scripts/deploy.sh <api|worker|web> [tag]`

1. `TAG=${2:-$(git rev-parse --short HEAD)}`; read ECR URL, cluster, service from `terraform output -json`.
2. `docker buildx build --platform linux/arm64 -f docker/Dockerfile.$APP -t $REPO:$TAG -t $REPO:latest --push .`
   (after `aws ecr get-login-password | docker login`).
3. `aws ecs update-service --cluster $CLUSTER --service $SERVICE --force-new-deployment`.
4. `aws ecs wait services-stable`; print the ALB URL.

### `.github/workflows/deploy.yml`

- Trigger: `push` to `main`, plus `workflow_dispatch`.
- `permissions: { id-token: write, contents: read }`.
- `aws-actions/configure-aws-credentials@v4` with `role-to-assume: <github_deploy_role_arn>`, region.
- Matrix over `[api, worker, web]`, each running `scripts/deploy.sh $APP $GITHUB_SHA`.
- Uses `docker/setup-qemu-action` + `setup-buildx-action` for arm64.

---

## 10. Verification ladder

| # | Phase | Done when |
|---|---|---|
| 1 | Monorepo | `pnpm turbo build` twice → second prints `FULL TURBO`; `--filter=worker...` skips `web` |
| 2 | BullMQ local | Seed 50 @ 20 % fail → Bull Board ≈ 40 completed / ≈ 10 failed after 3 attempts; report parent completes after 3 children; sweep fires every 5 min; rate-limited queue drains 5 per 10 s |
| 3 | Images | `docker compose --profile full up` → `localhost:3000` renders stats; seed button changes them |
| 4 | Bootstrap | Budget confirmation e-mail received; state bucket + lock table exist; OIDC provider exists |
| 5 | Production apply | `terraform apply` clean; `curl http://$ALB/api/health` → 200; landing page renders via ALB |
| 6 | Deploy | `scripts/deploy.sh api` rolls the service; `aws ecs execute-command` into worker succeeds; `aws logs tail /ecs/nextagency-demo/worker --follow` shows job JSON lines |
| 7 | CI/CD | Push to `main` → workflow green → new task revision live; no AWS keys anywhere |
| 8 | Failure drills | Bad image (health check 500) → circuit breaker rolls back; stop the worker task mid-seed → replacement task drains the queue (stalled recovery) |
| 9 | Teardown | `terraform destroy` in `production/` completes; `scripts/cost-check.sh` shows the bill |

## 11. Learning notes

One `docs/NN-<topic>.md` per phase, written when the phase is verified, each ≤ 1 page:
`01-turborepo`, `02-bullmq`, `03-docker-monorepo`, `04-terraform-state-and-roots`,
`05-vpc-three-tier`, `06-ecs-fargate-roles-and-tasks`, `07-alb-routing`, `08-deploy-and-oidc`,
`09-failure-drills`, `10-teardown-and-cost`.

## 12. Risks & known gaps

- Bull Board and every API route are unauthenticated and internet-reachable via the ALB for the
  demo's lifetime. Acceptable for 2–3 days with dummy data; must not be copied to V3.
- arm64 builds on an x86 laptop use QEMU; first build ≈ 5–10 min.
- ElastiCache creation ≈ 6–8 min; destroy ≈ 5 min. Total apply ≈ 10 min.
- Terraform, AWS CLI and `gh` are not yet installed locally; the plan starts there.
- No HTTPS: browsers may warn; irrelevant for the demo.
