# NextAgency Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a pnpm + Turborepo monorepo (Next.js web, NestJS API, NestJS BullMQ worker) to ECS Fargate in a personal AWS account with Terraform and GitHub-OIDC CI/CD, as a learning rehearsal for NextAgency V3.

**Architecture:** Three apps share one `@demo/queue` package that owns queue names, payload types and the Redis connection factory. `api` produces jobs and serves stats + Bull Board; `worker` consumes them and writes results to Redis hashes; `web` renders stats and triggers producers. AWS is two Terraform roots: `bootstrap` (state bucket, budget, OIDC provider) and `production` (VPC, ALB, ECS, ElastiCache, ECR, IAM, Secrets Manager). Images are built with `turbo prune` multi-stage Dockerfiles, pushed by a script first and by GitHub Actions later.

**Tech Stack:** Node 22, pnpm 10, Turborepo 2, NestJS 11, `@nestjs/bullmq` 11, BullMQ 5, ioredis 5, Bull Board 6, Next.js 15 / React 19, TypeScript 5, Jest 29, Docker buildx (arm64), Terraform ≥ 1.9, AWS provider 5.x, AWS CLI v2, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-12-nextagency-demo-design.md`

## Global Constraints

- Repo root: `~/nextagency-demo`. All paths below are relative to it. GitHub remote: `git@github-soh:msohaibnoor/nextagency-demo.git` (the `github-soh` SSH alias authenticates as `msohaibnoor`).
- Node `22`, pnpm `10` (`packageManager: "pnpm@10.30.2"` in root `package.json` — required by `turbo prune`).
- Workspace package scope: `@demo/*`. App names: `web`, `api`, `worker`.
- Ports: web `3000`, api `4000`. Redis: `REDIS_URL` (local `redis://localhost:6379`; AWS `rediss://…`).
- AWS: region `us-east-1`, CLI profile `personal`, tags `Project=nextagency-demo`, `Environment=production`, `ManagedBy=terraform`. VPC CIDR `10.40.0.0/16`. Fargate `ARM64`, 256 CPU / 512 MiB. One NAT gateway.
- Queue names: `renewal-reminders`, `reports`, `nightly-sweep`, `rate-limited-sync`.
- No database. No HTTPS. No auth on any route (demo only).
- Commit after every task; conventional-commit style messages.
- Never commit `.env`, `*.tfstate`, `*.tfvars` (except `*.tfvars.example`), `.terraform/`.

---

## File map

| Path | Responsibility |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.gitignore`, `.npmrc` | Workspace + task runner |
| `packages/tsconfig/{base,nest,next}.json` | Shared TS config |
| `packages/eslint-config/index.js` | Shared ESLint flat config |
| `packages/queue/src/{index,queues,types,connection}.ts` + tests | Queue contract shared by api and worker |
| `apps/api/src/{main,app.module}.ts`, `health/`, `jobs/`, `admin/` | HTTP + producers + Bull Board |
| `apps/worker/src/{main,worker.module}.ts`, `processors/*.processor.ts`, `results/results.store.ts` | Consumers |
| `apps/web/app/{layout,page}.tsx`, `app/actions.tsx` | Landing page |
| `scripts/seed-queue.ts`, `scripts/deploy.sh`, `scripts/cost-check.sh` | CLI helpers |
| `docker/Dockerfile.{api,worker,web}`, `docker/docker-compose.yml` | Images + local Redis |
| `infra/bootstrap/*.tf` | State bucket, lock table, budget, OIDC provider |
| `infra/production/*.tf` | Everything else, file per concern |
| `.github/workflows/deploy.yml` | OIDC deploy |
| `docs/NN-*.md` | Learning notes |

---

## Phase 0 — Tooling

### Task 0.1: Install Terraform, AWS CLI, and configure the `personal` profile

**Files:** none in repo.

- [ ] **Step 1: Install Terraform (official apt repo)**

```bash
sudo apt-get update && sudo apt-get install -y gnupg software-properties-common curl unzip
curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt-get update && sudo apt-get install -y terraform
terraform -version
```
Expected: `Terraform v1.9.x` or newer.

- [ ] **Step 2: Install AWS CLI v2**

```bash
cd /tmp && curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip && unzip -q awscliv2.zip && sudo ./aws/install && aws --version
```
Expected: `aws-cli/2.x`.

- [ ] **Step 3: Create an IAM user for the demo and configure the profile**

In the AWS console of your **personal** account: IAM → Users → Create `nextagency-demo-admin` → attach `AdministratorAccess` (demo only; delete the user at teardown) → Security credentials → Create access key (CLI). Then:

```bash
aws configure --profile personal
# paste key id, secret, region: us-east-1, output: json
aws sts get-caller-identity --profile personal
```
Expected: JSON with your account id. Note the `Account` value — you'll need it in Task 8.2.

- [ ] **Step 4: Enable Docker buildx arm64 emulation**

```bash
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker buildx create --name demo --use 2>/dev/null || docker buildx use demo
docker buildx inspect --bootstrap | grep -i platforms
```
Expected: platforms list includes `linux/arm64`.

---

## Phase 1 — Monorepo skeleton

### Task 1.1: Workspace, Turborepo, shared configs, first push

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.npmrc`, `.gitignore`, `README.md`
- Create: `packages/tsconfig/package.json`, `packages/tsconfig/base.json`, `packages/tsconfig/nest.json`, `packages/tsconfig/next.json`
- Create: `packages/eslint-config/package.json`, `packages/eslint-config/index.js`

**Interfaces:**
- Produces: workspace names `@demo/tsconfig`, `@demo/eslint-config`; turbo tasks `build`, `dev`, `lint`, `typecheck`, `test`.

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "nextagency-demo",
  "private": true,
  "packageManager": "pnpm@10.30.2",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "redis": "docker compose -f docker/docker-compose.yml up -d redis",
    "redis:down": "docker compose -f docker/docker-compose.yml down"
  },
  "devDependencies": {
    "turbo": "^2.3.3",
    "typescript": "^5.7.2"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalEnv": ["REDIS_URL", "PORT", "API_URL"],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "!.next/cache/**", "dist/**"]
    },
    "dev": { "cache": false, "persistent": true },
    "lint": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

`.nvmrc`: `22`

`.npmrc`:
```
auto-install-peers=true
```

`.gitignore`:
```
node_modules
dist
.next
.turbo
.env
.env.*
!.env.example
*.tfstate
*.tfstate.*
*.tfvars
!*.tfvars.example
.terraform/
.terraform.lock.hcl
tfplan
coverage
```

`README.md`:
```markdown
# nextagency-demo
Learning monorepo: Next.js + NestJS + BullMQ on ECS Fargate via Terraform. See `docs/`.
```

- [ ] **Step 2: Shared tsconfig package**

`packages/tsconfig/package.json`:
```json
{ "name": "@demo/tsconfig", "version": "0.0.0", "private": true, "files": ["*.json"] }
```
`packages/tsconfig/base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true, "declaration": true, "sourceMap": true
  }
}
```
`packages/tsconfig/nest.json`:
```json
{
  "extends": "./base.json",
  "compilerOptions": {
    "module": "CommonJS", "moduleResolution": "Node", "target": "ES2021",
    "emitDecoratorMetadata": true, "experimentalDecorators": true, "outDir": "dist"
  }
}
```
`packages/tsconfig/next.json`:
```json
{
  "extends": "./base.json",
  "compilerOptions": {
    "module": "ESNext", "moduleResolution": "Bundler", "jsx": "preserve", "noEmit": true,
    "lib": ["dom", "dom.iterable", "esnext"], "allowJs": true, "incremental": true,
    "plugins": [{ "name": "next" }]
  }
}
```

- [ ] **Step 3: Shared ESLint config**

`packages/eslint-config/package.json`:
```json
{
  "name": "@demo/eslint-config", "version": "0.0.0", "private": true, "main": "index.js",
  "dependencies": { "@eslint/js": "^9.17.0", "typescript-eslint": "^8.19.0" }
}
```
`packages/eslint-config/index.js`:
```js
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ["dist/**", ".next/**", "node_modules/**"] },
);
```

- [ ] **Step 4: Install and verify turbo runs with an empty graph**

```bash
cd ~/nextagency-demo && pnpm install && pnpm turbo run build
```
Expected: `No tasks were executed` (nothing to build yet) with no errors.

- [ ] **Step 5: Commit and push**

```bash
git add -A && git commit -m "chore: pnpm workspace + turborepo skeleton"
git remote add origin git@github-soh:msohaibnoor/nextagency-demo.git
git push -u origin main
```
Expected: branch visible at github.com/msohaibnoor/nextagency-demo. (Create the empty repo on GitHub first — no README, no .gitignore.)

---

## Phase 2 — Shared queue package

### Task 2.1: `@demo/queue` — names, types, Redis connection parser

**Files:**
- Create: `packages/queue/package.json`, `packages/queue/tsconfig.json`, `packages/queue/jest.config.js`
- Create: `packages/queue/src/queues.ts`, `packages/queue/src/types.ts`, `packages/queue/src/connection.ts`, `packages/queue/src/index.ts`
- Test: `packages/queue/src/connection.test.ts`

**Interfaces:**
- Produces:
  - `QUEUES = { renewalReminders: 'renewal-reminders', reports: 'reports', nightlySweep: 'nightly-sweep', rateLimitedSync: 'rate-limited-sync' } as const`, `type QueueName = (typeof QUEUES)[keyof typeof QUEUES]`, `ALL_QUEUES: QueueName[]`
  - `RenewalReminderJob`, `ReportJob`, `ReportStepJob`, `RateLimitedSyncJob`, `SweepJob`, `JobResult`
  - `redisConnectionOptions(env: NodeJS.ProcessEnv): ConnectionOptions`
  - `resultsKey(queue: QueueName): string` → `results:<queue>`

- [ ] **Step 1: Package scaffolding**

`packages/queue/package.json`:
```json
{
  "name": "@demo/queue", "version": "0.0.0", "private": true,
  "main": "dist/index.js", "types": "dist/index.d.ts",
  "scripts": { "build": "tsc -p tsconfig.json", "test": "jest", "typecheck": "tsc --noEmit -p tsconfig.json" },
  "dependencies": { "bullmq": "^5.34.0", "ioredis": "^5.4.2" },
  "devDependencies": {
    "@demo/tsconfig": "workspace:*", "@types/jest": "^29.5.14", "@types/node": "^22.10.2",
    "jest": "^29.7.0", "ts-jest": "^29.2.5", "typescript": "^5.7.2"
  }
}
```
`packages/queue/tsconfig.json`:
```json
{ "extends": "@demo/tsconfig/nest.json", "compilerOptions": { "rootDir": "src", "outDir": "dist" }, "include": ["src"], "exclude": ["src/**/*.test.ts"] }
```
`packages/queue/jest.config.js`:
```js
module.exports = { preset: "ts-jest", testEnvironment: "node", roots: ["<rootDir>/src"] };
```

- [ ] **Step 2: Write the failing test for the connection parser**

`packages/queue/src/connection.test.ts`:
```ts
import { redisConnectionOptions } from "./connection";

describe("redisConnectionOptions", () => {
  it("parses a plain redis:// url", () => {
    expect(redisConnectionOptions({ REDIS_URL: "redis://localhost:6379" })).toEqual({
      host: "localhost", port: 6379, maxRetriesPerRequest: null,
    });
  });
  it("adds tls and password for rediss://", () => {
    expect(redisConnectionOptions({ REDIS_URL: "rediss://:s3cret@cache.example.com:6379" })).toEqual({
      host: "cache.example.com", port: 6379, password: "s3cret", tls: {}, maxRetriesPerRequest: null,
    });
  });
  it("throws when REDIS_URL is missing", () => {
    expect(() => redisConnectionOptions({})).toThrow("REDIS_URL is required");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
pnpm install && pnpm --filter @demo/queue test
```
Expected: FAIL — `Cannot find module './connection'`.

- [ ] **Step 4: Implement**

`packages/queue/src/queues.ts`:
```ts
export const QUEUES = {
  renewalReminders: "renewal-reminders",
  reports: "reports",
  nightlySweep: "nightly-sweep",
  rateLimitedSync: "rate-limited-sync",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const ALL_QUEUES: QueueName[] = Object.values(QUEUES);
export const resultsKey = (queue: QueueName) => `results:${queue}`;
```
`packages/queue/src/types.ts`:
```ts
export interface RenewalReminderJob { policyId: string; agencyId: string; renewalDate: string; failRate?: number }
export interface ReportJob { agencyId: string; month: string }
export type ReportStep = "gather" | "render" | "email";
export interface ReportStepJob extends ReportJob { step: ReportStep }
export interface RateLimitedSyncJob { carrierId: string }
export type SweepJob = Record<string, never>;
export interface JobResult { jobId: string; queue: string; finishedAt: string; summary: string }
```
`packages/queue/src/connection.ts`:
```ts
import type { ConnectionOptions } from "bullmq";

export function redisConnectionOptions(env: NodeJS.ProcessEnv): ConnectionOptions {
  const raw = env.REDIS_URL;
  if (!raw) throw new Error("REDIS_URL is required");
  const url = new URL(raw);
  const opts: ConnectionOptions = {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null, // required by BullMQ workers
  };
  if (url.password) opts.password = decodeURIComponent(url.password);
  if (url.protocol === "rediss:") opts.tls = {};
  return opts;
}
```
`packages/queue/src/index.ts`:
```ts
export * from "./queues";
export * from "./types";
export * from "./connection";
```

- [ ] **Step 5: Run tests and build**

```bash
pnpm --filter @demo/queue test && pnpm turbo run build --filter=@demo/queue
```
Expected: 3 tests pass; `dist/index.js` exists.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(queue): shared queue names, payload types, redis connection parser"
```

---

## Phase 3 — NestJS API

### Task 3.1: API skeleton with health route

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json`, `apps/api/jest.config.js`, `apps/api/.env.example`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/health/health.controller.ts`
- Test: `apps/api/src/health/health.controller.spec.ts`

**Interfaces:**
- Produces: `GET /api/health` → `{ ok: boolean, redis: 'up' | 'down' }`.
- Consumes: `redisConnectionOptions` from `@demo/queue`.

- [ ] **Step 1: Package files**

`apps/api/package.json`:
```json
{
  "name": "api", "version": "0.0.0", "private": true,
  "scripts": {
    "build": "nest build", "dev": "nest start --watch", "start": "node dist/main.js",
    "lint": "eslint src", "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "jest", "test:e2e": "jest --config jest.e2e.config.js --runInBand"
  },
  "dependencies": {
    "@bull-board/api": "^6.5.3", "@bull-board/express": "^6.5.3", "@bull-board/nestjs": "^6.5.3",
    "@demo/queue": "workspace:*",
    "@nestjs/bullmq": "^11.0.1", "@nestjs/common": "^11.0.1", "@nestjs/core": "^11.0.1",
    "@nestjs/platform-express": "^11.0.1", "bullmq": "^5.34.0", "ioredis": "^5.4.2",
    "reflect-metadata": "^0.2.2", "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@demo/eslint-config": "workspace:*", "@demo/tsconfig": "workspace:*",
    "@nestjs/cli": "^11.0.0", "@nestjs/testing": "^11.0.1", "@types/express": "^5.0.0",
    "@types/jest": "^29.5.14", "@types/node": "^22.10.2", "@types/supertest": "^6.0.2",
    "eslint": "^9.17.0", "jest": "^29.7.0", "supertest": "^7.0.0", "ts-jest": "^29.2.5",
    "ts-node": "^10.9.2", "typescript": "^5.7.2"
  }
}
```
`apps/api/tsconfig.json`:
```json
{ "extends": "@demo/tsconfig/nest.json", "compilerOptions": { "outDir": "dist", "baseUrl": "./" }, "include": ["src"] }
```
`apps/api/tsconfig.build.json`:
```json
{ "extends": "./tsconfig.json", "exclude": ["node_modules", "dist", "src/**/*.spec.ts", "test"] }
```
`apps/api/nest-cli.json`:
```json
{ "$schema": "https://json.schemastore.org/nest-cli", "collection": "@nestjs/schematics", "sourceRoot": "src", "compilerOptions": { "deleteOutDir": true, "tsConfigPath": "tsconfig.build.json" } }
```
`apps/api/jest.config.js`:
```js
module.exports = { preset: "ts-jest", testEnvironment: "node", rootDir: "src", testRegex: ".*\\.spec\\.ts$" };
```
`apps/api/.env.example`:
```
PORT=4000
REDIS_URL=redis://localhost:6379
```
`apps/api/eslint.config.js`:
```js
module.exports = require("@demo/eslint-config");
```

- [ ] **Step 2: Failing test for the health controller**

`apps/api/src/health/health.controller.spec.ts`:
```ts
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("reports redis up when ping succeeds", async () => {
    const redis = { ping: jest.fn().mockResolvedValue("PONG") };
    const c = new HealthController(redis as never);
    await expect(c.check()).resolves.toEqual({ ok: true, redis: "up" });
  });
  it("reports redis down when ping throws", async () => {
    const redis = { ping: jest.fn().mockRejectedValue(new Error("nope")) };
    const c = new HealthController(redis as never);
    await expect(c.check()).resolves.toEqual({ ok: false, redis: "down" });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
pnpm install && pnpm --filter api test
```
Expected: FAIL — cannot find `./health.controller`.

- [ ] **Step 4: Implement**

`apps/api/src/health/health.controller.ts`:
```ts
import { Controller, Get, Inject } from "@nestjs/common";
import type Redis from "ioredis";

export const REDIS = "REDIS_CLIENT";

@Controller("api/health")
export class HealthController {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  @Get()
  async check() {
    try {
      await this.redis.ping();
      return { ok: true, redis: "up" as const };
    } catch {
      return { ok: false, redis: "down" as const };
    }
  }
}
```
`apps/api/src/app.module.ts`:
```ts
import { Module } from "@nestjs/common";
import Redis from "ioredis";
import { redisConnectionOptions } from "@demo/queue";
import { HealthController, REDIS } from "./health/health.controller";

@Module({
  controllers: [HealthController],
  providers: [
    { provide: REDIS, useFactory: () => new Redis(redisConnectionOptions(process.env)) },
  ],
})
export class AppModule {}
```
`apps/api/src/main.ts`:
```ts
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(JSON.stringify({ msg: "api listening", port }));
}
bootstrap();
```

- [ ] **Step 5: Test, build, smoke-run**

```bash
pnpm --filter api test && pnpm turbo run build --filter=api...
pnpm redis
cd apps/api && cp .env.example .env && REDIS_URL=redis://localhost:6379 node dist/main.js &
sleep 2 && curl -s localhost:4000/api/health; kill %1; cd ../..
```
Expected: tests pass; `{"ok":true,"redis":"up"}`.

(`docker/docker-compose.yml` doesn't exist yet — create the minimal version now so `pnpm redis` works; it is completed in Task 7.1.)

`docker/docker-compose.yml`:
```yaml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(api): nest skeleton with redis-backed health route"
```

### Task 3.2: Jobs module — producers, stats, job lookup

**Files:**
- Create: `apps/api/src/jobs/jobs.module.ts`, `apps/api/src/jobs/jobs.service.ts`, `apps/api/src/jobs/jobs.controller.ts`, `apps/api/src/jobs/seed.dto.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/src/jobs/jobs.service.spec.ts`

**Interfaces:**
- Produces:
  - `JobsService.seed({ count, failRate, queue }): Promise<string[]>` (job ids)
  - `JobsService.report({ agencyId, month }): Promise<string>` (parent job id)
  - `JobsService.stats(): Promise<Record<QueueName, JobCounts>>`
  - `JobsService.get(queue, id): Promise<{ id, name, state, attemptsMade, returnvalue, failedReason, data } | null>`
  - `JobsService.ensureSweepScheduler(): Promise<void>` (job scheduler `nightly-sweep`, `*/5 * * * *`)
  - Routes `POST /api/jobs/seed`, `POST /api/jobs/report`, `GET /api/jobs/stats`, `GET /api/jobs/:queue/:id`.

- [ ] **Step 1: Failing service test**

`apps/api/src/jobs/jobs.service.spec.ts`:
```ts
import { JobsService } from "./jobs.service";

const mkQueue = () => ({
  addBulk: jest.fn(async (jobs: unknown[]) => jobs.map((_, i) => ({ id: String(i + 1) }))),
  getJobCounts: jest.fn(async () => ({ waiting: 1, active: 0, completed: 2, failed: 0, delayed: 0 })),
  getJob: jest.fn(),
  upsertJobScheduler: jest.fn(),
  name: "q",
});

describe("JobsService", () => {
  const reminders = mkQueue(), reports = mkQueue(), sweep = mkQueue(), sync = mkQueue();
  const flow = { add: jest.fn(async () => ({ job: { id: "parent-1" } })) };
  const svc = new JobsService(reminders as never, reports as never, sweep as never, sync as never, flow as never);

  it("seeds N reminder jobs with retry options", async () => {
    const ids = await svc.seed({ count: 3, failRate: 0.5 });
    expect(ids).toEqual(["1", "2", "3"]);
    const [jobs] = reminders.addBulk.mock.calls[0];
    expect(jobs).toHaveLength(3);
    expect(jobs[0].opts).toMatchObject({ attempts: 3, backoff: { type: "exponential", delay: 1000 } });
    expect(jobs[0].data.failRate).toBe(0.5);
  });

  it("seeds the rate-limited queue when asked", async () => {
    await svc.seed({ count: 2, queue: "rate-limited-sync" });
    expect(sync.addBulk).toHaveBeenCalled();
  });

  it("builds a nested report flow gather -> render -> email -> parent", async () => {
    const id = await svc.report({ agencyId: "a1", month: "2026-09" });
    expect(id).toBe("parent-1");
    const tree = flow.add.mock.calls[0][0];
    expect(tree.name).toBe("report");
    expect(tree.children[0].name).toBe("email");
    expect(tree.children[0].children[0].name).toBe("render");
    expect(tree.children[0].children[0].children[0].name).toBe("gather");
  });

  it("returns stats keyed by queue name", async () => {
    const s = await svc.stats();
    expect(Object.keys(s).sort()).toEqual(["nightly-sweep", "rate-limited-sync", "renewal-reminders", "reports"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter api test
```
Expected: FAIL — cannot find `./jobs.service`.

- [ ] **Step 3: Implement**

`apps/api/src/jobs/seed.dto.ts`:
```ts
import type { QueueName } from "@demo/queue";
export interface SeedDto { count?: number; failRate?: number; queue?: QueueName }
export interface ReportDto { agencyId?: string; month?: string }
```
`apps/api/src/jobs/jobs.service.ts`:
```ts
import { Injectable } from "@nestjs/common";
import { InjectFlowProducer, InjectQueue } from "@nestjs/bullmq";
import { FlowProducer, Queue } from "bullmq";
import {
  ALL_QUEUES, QUEUES, type QueueName, type RateLimitedSyncJob, type RenewalReminderJob, type ReportJob,
} from "@demo/queue";
import type { ReportDto, SeedDto } from "./seed.dto";

export const REPORT_FLOW = "report-flow";

@Injectable()
export class JobsService {
  constructor(
    @InjectQueue(QUEUES.renewalReminders) private readonly reminders: Queue<RenewalReminderJob>,
    @InjectQueue(QUEUES.reports) private readonly reports: Queue,
    @InjectQueue(QUEUES.nightlySweep) private readonly sweep: Queue,
    @InjectQueue(QUEUES.rateLimitedSync) private readonly sync: Queue<RateLimitedSyncJob>,
    @InjectFlowProducer(REPORT_FLOW) private readonly flow: FlowProducer,
  ) {}

  private byName(): Record<QueueName, Queue> {
    return {
      [QUEUES.renewalReminders]: this.reminders as Queue,
      [QUEUES.reports]: this.reports,
      [QUEUES.nightlySweep]: this.sweep,
      [QUEUES.rateLimitedSync]: this.sync as Queue,
    };
  }

  async seed({ count = 50, failRate = 0.2, queue = QUEUES.renewalReminders }: SeedDto): Promise<string[]> {
    const opts = { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 100, removeOnFail: 500 };
    if (queue === QUEUES.rateLimitedSync) {
      const jobs = Array.from({ length: count }, (_, i) => ({
        name: "sync", data: { carrierId: `carrier-${i + 1}` }, opts,
      }));
      return (await this.sync.addBulk(jobs)).map((j) => String(j.id));
    }
    const jobs = Array.from({ length: count }, (_, i) => ({
      name: "remind",
      data: {
        policyId: `pol-${i + 1}`, agencyId: `agency-${(i % 5) + 1}`,
        renewalDate: new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10), failRate,
      },
      opts,
    }));
    return (await this.reminders.addBulk(jobs)).map((j) => String(j.id));
  }

  async report({ agencyId = "agency-1", month = new Date().toISOString().slice(0, 7) }: ReportDto): Promise<string> {
    const base: ReportJob = { agencyId, month };
    const q = QUEUES.reports;
    const tree = await this.flow.add({
      name: "report", queueName: q, data: base,
      children: [{
        name: "email", queueName: q, data: { ...base, step: "email" },
        children: [{
          name: "render", queueName: q, data: { ...base, step: "render" },
          children: [{ name: "gather", queueName: q, data: { ...base, step: "gather" } }],
        }],
      }],
    });
    return String(tree.job.id);
  }

  async stats() {
    const entries = await Promise.all(
      ALL_QUEUES.map(async (name) => [name, await this.byName()[name].getJobCounts()] as const),
    );
    return Object.fromEntries(entries) as Record<QueueName, Awaited<ReturnType<Queue["getJobCounts"]>>>;
  }

  async get(queue: QueueName, id: string) {
    const q = this.byName()[queue];
    if (!q) return null;
    const job = await q.getJob(id);
    if (!job) return null;
    return {
      id: job.id, name: job.name, state: await job.getState(), attemptsMade: job.attemptsMade,
      returnvalue: job.returnvalue, failedReason: job.failedReason, data: job.data,
    };
  }

  async ensureSweepScheduler() {
    await this.sweep.upsertJobScheduler("nightly-sweep", { pattern: "*/5 * * * *" }, { name: "sweep", data: {} });
  }
}
```
`apps/api/src/jobs/jobs.controller.ts`:
```ts
import { Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import type { QueueName } from "@demo/queue";
import { JobsService } from "./jobs.service";
import type { ReportDto, SeedDto } from "./seed.dto";

@Controller("api/jobs")
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post("seed")
  async seed(@Body() body: SeedDto) {
    const ids = await this.jobs.seed({
      count: body.count !== undefined ? Number(body.count) : undefined,
      failRate: body.failRate !== undefined ? Number(body.failRate) : undefined,
      queue: body.queue,
    });
    return { enqueued: ids.length, ids };
  }

  @Post("report")
  async report(@Body() body: ReportDto) {
    return { parentId: await this.jobs.report(body) };
  }

  @Get("stats")
  stats() {
    return this.jobs.stats();
  }

  @Get(":queue/:id")
  async get(@Param("queue") queue: QueueName, @Param("id") id: string) {
    const job = await this.jobs.get(queue, id);
    if (!job) throw new NotFoundException();
    return job;
  }
}
```
`apps/api/src/jobs/jobs.module.ts`:
```ts
import { Module, OnModuleInit } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ALL_QUEUES } from "@demo/queue";
import { JobsController } from "./jobs.controller";
import { JobsService, REPORT_FLOW } from "./jobs.service";

@Module({
  imports: [
    BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
    BullModule.registerFlowProducer({ name: REPORT_FLOW }),
  ],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [BullModule],
})
export class JobsModule implements OnModuleInit {
  constructor(private readonly jobs: JobsService) {}
  onModuleInit() {
    return this.jobs.ensureSweepScheduler();
  }
}
```
Modify `apps/api/src/app.module.ts` to:
```ts
import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import Redis from "ioredis";
import { redisConnectionOptions } from "@demo/queue";
import { HealthController, REDIS } from "./health/health.controller";
import { JobsModule } from "./jobs/jobs.module";

@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnectionOptions(process.env) }),
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: REDIS, useFactory: () => new Redis(redisConnectionOptions(process.env)) }],
})
export class AppModule {}
```

- [ ] **Step 4: Run tests, then smoke-test the routes**

```bash
pnpm --filter api test && pnpm turbo run build --filter=api...
(cd apps/api && node dist/main.js &) ; sleep 2
curl -s -XPOST localhost:4000/api/jobs/seed -H 'content-type: application/json' -d '{"count":3}'
curl -s localhost:4000/api/jobs/stats
curl -s -XPOST localhost:4000/api/jobs/report -H 'content-type: application/json' -d '{}'
pkill -f "apps/api/dist/main.js"
```
Expected: 4 tests pass; seed returns 3 ids; stats shows `renewal-reminders.waiting: 3`, `nightly-sweep.delayed: 1` (the scheduler), `reports.waiting: 1` (gather, the only runnable child).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(api): jobs producers, flow, scheduler, stats and lookup routes"
```

### Task 3.3: Bull Board at `/api/admin/queues`

**Files:**
- Create: `apps/api/src/admin/admin.module.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Implement**

`apps/api/src/admin/admin.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { BullBoardModule } from "@bull-board/nestjs";
import { ExpressAdapter } from "@bull-board/express";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ALL_QUEUES } from "@demo/queue";
import { JobsModule } from "../jobs/jobs.module";

@Module({
  imports: [
    JobsModule,
    BullBoardModule.forRoot({ route: "/api/admin/queues", adapter: ExpressAdapter }),
    ...ALL_QUEUES.map((name) => BullBoardModule.forFeature({ name, adapter: BullMQAdapter })),
  ],
})
export class AdminModule {}
```
Add `AdminModule` to `AppModule.imports`.

- [ ] **Step 2: Verify in a browser**

```bash
pnpm turbo run build --filter=api... && (cd apps/api && node dist/main.js &)
```
Open http://localhost:4000/api/admin/queues — four queues listed, the seeded jobs from Task 3.2 are in *Waiting*. Then `pkill -f "apps/api/dist/main.js"`.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(api): bull board ui"
```

---

## Phase 4 — Worker

### Task 4.1: Worker app, results store, reminder processor

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/tsconfig.build.json`, `apps/worker/nest-cli.json`, `apps/worker/jest.config.js`, `apps/worker/.env.example`, `apps/worker/eslint.config.js`
- Create: `apps/worker/src/main.ts`, `apps/worker/src/worker.module.ts`, `apps/worker/src/results/results.store.ts`, `apps/worker/src/processors/reminders.logic.ts`, `apps/worker/src/processors/reminders.processor.ts`, `apps/worker/src/log.ts`
- Test: `apps/worker/src/processors/reminders.logic.spec.ts`

**Interfaces:**
- Produces:
  - `ResultsStore.record(queue: QueueName, result: JobResult): Promise<void>` — `HSET results:<queue> <jobId> <json>`, trims to 1000 entries.
  - `shouldFail(failRate: number | undefined, random: () => number): boolean`
  - `log(event: string, fields: Record<string, unknown>): void` — JSON line to stdout.
  - Note: the spec mentions a `QueueEvents` listener; this plan uses `@OnWorkerEvent` on each processor instead — same log lines, one fewer Redis connection per queue. Explain the difference in `docs/02-bullmq.md`.

- [ ] **Step 1: Package files** (same shape as api)

`apps/worker/package.json`:
```json
{
  "name": "worker", "version": "0.0.0", "private": true,
  "scripts": {
    "build": "nest build", "dev": "nest start --watch", "start": "node dist/main.js",
    "lint": "eslint src", "typecheck": "tsc --noEmit -p tsconfig.json", "test": "jest"
  },
  "dependencies": {
    "@demo/queue": "workspace:*", "@nestjs/bullmq": "^11.0.1", "@nestjs/common": "^11.0.1",
    "@nestjs/core": "^11.0.1", "bullmq": "^5.34.0", "ioredis": "^5.4.2",
    "reflect-metadata": "^0.2.2", "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@demo/eslint-config": "workspace:*", "@demo/tsconfig": "workspace:*", "@nestjs/cli": "^11.0.0",
    "@nestjs/testing": "^11.0.1", "@types/jest": "^29.5.14", "@types/node": "^22.10.2",
    "eslint": "^9.17.0", "jest": "^29.7.0", "ts-jest": "^29.2.5", "typescript": "^5.7.2"
  }
}
```
`tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `jest.config.js`, `eslint.config.js`: identical to `apps/api`'s (copy them). `.env.example`: `REDIS_URL=redis://localhost:6379`.

- [ ] **Step 2: Failing test for the pure decision function**

`apps/worker/src/processors/reminders.logic.spec.ts`:
```ts
import { shouldFail, summarize } from "./reminders.logic";

describe("reminders logic", () => {
  it("never fails when failRate is undefined or 0", () => {
    expect(shouldFail(undefined, () => 0.01)).toBe(false);
    expect(shouldFail(0, () => 0.0)).toBe(false);
  });
  it("fails when the random draw is below failRate", () => {
    expect(shouldFail(0.2, () => 0.1)).toBe(true);
    expect(shouldFail(0.2, () => 0.3)).toBe(false);
  });
  it("summarizes a reminder", () => {
    expect(summarize({ policyId: "pol-1", agencyId: "agency-2", renewalDate: "2026-10-01" }))
      .toBe("Reminder sent for pol-1 (agency-2) renewing 2026-10-01");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
pnpm install && pnpm --filter worker test
```
Expected: FAIL — cannot find `./reminders.logic`.

- [ ] **Step 4: Implement**

`apps/worker/src/processors/reminders.logic.ts`:
```ts
import type { RenewalReminderJob } from "@demo/queue";
export const shouldFail = (failRate: number | undefined, random: () => number = Math.random) =>
  !!failRate && random() < failRate;
export const summarize = (j: RenewalReminderJob) =>
  `Reminder sent for ${j.policyId} (${j.agencyId}) renewing ${j.renewalDate}`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```
`apps/worker/src/log.ts`:
```ts
export const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
```
`apps/worker/src/results/results.store.ts`:
```ts
import { Inject, Injectable } from "@nestjs/common";
import Redis from "ioredis";
import { resultsKey, type JobResult, type QueueName } from "@demo/queue";

export const REDIS = "REDIS_CLIENT";
const MAX = 1000;

@Injectable()
export class ResultsStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async record(queue: QueueName, result: JobResult) {
    const key = resultsKey(queue);
    await this.redis.hset(key, result.jobId, JSON.stringify(result));
    const n = await this.redis.hlen(key);
    if (n > MAX) {
      const fields = await this.redis.hkeys(key);
      await this.redis.hdel(key, ...fields.slice(0, n - MAX));
    }
  }

  count(queue: QueueName) {
    return this.redis.hlen(resultsKey(queue));
  }
}
```
`apps/worker/src/processors/reminders.processor.ts`:
```ts
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { QUEUES, type RenewalReminderJob } from "@demo/queue";
import { ResultsStore } from "../results/results.store";
import { log } from "../log";
import { shouldFail, sleep, summarize } from "./reminders.logic";

@Processor(QUEUES.renewalReminders, { concurrency: 5 })
export class RemindersProcessor extends WorkerHost {
  constructor(private readonly results: ResultsStore) { super(); }

  async process(job: Job<RenewalReminderJob>) {
    await sleep(100 + Math.random() * 400);
    if (shouldFail(job.data.failRate)) throw new Error(`simulated failure for ${job.data.policyId}`);
    const summary = summarize(job.data);
    await this.results.record(QUEUES.renewalReminders, {
      jobId: String(job.id), queue: QUEUES.renewalReminders, finishedAt: new Date().toISOString(), summary,
    });
    return summary;
  }

  @OnWorkerEvent("completed") onCompleted(job: Job) { log("completed", { queue: QUEUES.renewalReminders, jobId: job.id }); }
  @OnWorkerEvent("failed") onFailed(job: Job | undefined, err: Error) {
    log("failed", { queue: QUEUES.renewalReminders, jobId: job?.id, attemptsMade: job?.attemptsMade, error: err.message });
  }
}
```
`apps/worker/src/worker.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import Redis from "ioredis";
import { redisConnectionOptions } from "@demo/queue";
import { REDIS, ResultsStore } from "./results/results.store";
import { RemindersProcessor } from "./processors/reminders.processor";

@Module({
  imports: [BullModule.forRoot({ connection: redisConnectionOptions(process.env) })],
  providers: [
    { provide: REDIS, useFactory: () => new Redis(redisConnectionOptions(process.env)) },
    ResultsStore,
    RemindersProcessor,
  ],
})
export class WorkerModule {}
```
`apps/worker/src/main.ts`:
```ts
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";
import { log } from "./log";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks(); // SIGTERM -> @nestjs/bullmq closes workers gracefully
  log("worker started", { pid: process.pid });
}
bootstrap();
```

- [ ] **Step 5: Run tests, then drain the jobs seeded in Task 3.2**

```bash
pnpm --filter worker test && pnpm turbo run build --filter=worker...
(cd apps/worker && REDIS_URL=redis://localhost:6379 node dist/main.js &) ; sleep 5
(cd apps/api && node dist/main.js &) ; sleep 2 ; curl -s localhost:4000/api/jobs/stats
pkill -f "dist/main.js"
```
Expected: 3 tests pass; worker prints `completed`/`failed` JSON lines; stats show `renewal-reminders.completed: 3` (or some failed, since failRate defaulted to 0.2).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(worker): nest application context, results store, reminders processor"
```

### Task 4.2: Reports flow, sweep, and rate-limited processors

**Files:**
- Create: `apps/worker/src/processors/reports.logic.ts`, `apps/worker/src/processors/reports.processor.ts`, `apps/worker/src/processors/sweep.processor.ts`, `apps/worker/src/processors/sync.processor.ts`
- Modify: `apps/worker/src/worker.module.ts`
- Test: `apps/worker/src/processors/reports.logic.spec.ts`

**Interfaces:**
- Produces: `composeStep(step: ReportStep, childValues: unknown[]): string` — each step's return value embeds the previous one.

- [ ] **Step 1: Failing test**

`apps/worker/src/processors/reports.logic.spec.ts`:
```ts
import { composeStep } from "./reports.logic";

describe("composeStep", () => {
  it("gather has no children", () => {
    expect(composeStep("gather", [])).toBe("gathered 12 policies");
  });
  it("render embeds gather's output", () => {
    expect(composeStep("render", ["gathered 12 policies"])).toBe("rendered PDF from [gathered 12 policies]");
  });
  it("email embeds render's output", () => {
    expect(composeStep("email", ["rendered PDF from [x]"])).toBe("emailed [rendered PDF from [x]]");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter worker test
```
Expected: FAIL — cannot find `./reports.logic`.

- [ ] **Step 3: Implement**

`apps/worker/src/processors/reports.logic.ts`:
```ts
import type { ReportStep } from "@demo/queue";
export function composeStep(step: ReportStep, childValues: unknown[]): string {
  const prev = childValues.map(String).join(", ");
  switch (step) {
    case "gather": return "gathered 12 policies";
    case "render": return `rendered PDF from [${prev}]`;
    case "email": return `emailed [${prev}]`;
  }
}
```
`apps/worker/src/processors/reports.processor.ts`:
```ts
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { QUEUES, type ReportJob, type ReportStepJob } from "@demo/queue";
import { ResultsStore } from "../results/results.store";
import { log } from "../log";
import { composeStep } from "./reports.logic";
import { sleep } from "./reminders.logic";

@Processor(QUEUES.reports, { concurrency: 2 })
export class ReportsProcessor extends WorkerHost {
  constructor(private readonly results: ResultsStore) { super(); }

  async process(job: Job<ReportJob | ReportStepJob>) {
    await sleep(300);
    const childValues = Object.values(await job.getChildrenValues());
    const summary = job.name === "report"
      ? `report for ${job.data.agencyId}/${job.data.month} done: ${childValues.join(" | ")}`
      : composeStep((job.data as ReportStepJob).step, childValues);
    await this.results.record(QUEUES.reports, {
      jobId: String(job.id), queue: QUEUES.reports, finishedAt: new Date().toISOString(), summary,
    });
    return summary;
  }

  @OnWorkerEvent("completed") onCompleted(job: Job) { log("completed", { queue: QUEUES.reports, jobId: job.id, name: job.name }); }
  @OnWorkerEvent("failed") onFailed(job: Job | undefined, err: Error) { log("failed", { queue: QUEUES.reports, jobId: job?.id, error: err.message }); }
}
```
`apps/worker/src/processors/sweep.processor.ts`:
```ts
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { ALL_QUEUES, QUEUES } from "@demo/queue";
import { ResultsStore } from "../results/results.store";
import { log } from "../log";

@Processor(QUEUES.nightlySweep, { concurrency: 1 })
export class SweepProcessor extends WorkerHost {
  constructor(private readonly results: ResultsStore) { super(); }

  async process(job: Job) {
    const counts = Object.fromEntries(await Promise.all(ALL_QUEUES.map(async (q) => [q, await this.results.count(q)])));
    log("sweep", { jobId: job.id, resultCounts: counts });
    return counts;
  }
}
```
`apps/worker/src/processors/sync.processor.ts`:
```ts
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { QUEUES, type RateLimitedSyncJob } from "@demo/queue";
import { ResultsStore } from "../results/results.store";
import { log } from "../log";

// 5 jobs per 10 seconds, across all worker instances (limiter is enforced in Redis)
@Processor(QUEUES.rateLimitedSync, { concurrency: 5, limiter: { max: 5, duration: 10_000 } })
export class SyncProcessor extends WorkerHost {
  constructor(private readonly results: ResultsStore) { super(); }

  async process(job: Job<RateLimitedSyncJob>) {
    const summary = `synced ${job.data.carrierId}`;
    await this.results.record(QUEUES.rateLimitedSync, {
      jobId: String(job.id), queue: QUEUES.rateLimitedSync, finishedAt: new Date().toISOString(), summary,
    });
    log("completed", { queue: QUEUES.rateLimitedSync, jobId: job.id });
    return summary;
  }
}
```
Add `ReportsProcessor, SweepProcessor, SyncProcessor` to `WorkerModule.providers`.

- [ ] **Step 4: Run tests and verify behaviour in Bull Board**

```bash
pnpm --filter worker test && pnpm turbo run build --filter=worker... --filter=api...
(cd apps/worker && node dist/main.js &) ; (cd apps/api && node dist/main.js &) ; sleep 3
curl -s -XPOST localhost:4000/api/jobs/report -H 'content-type: application/json' -d '{"agencyId":"agency-9","month":"2026-09"}'
curl -s -XPOST localhost:4000/api/jobs/seed -H 'content-type: application/json' -d '{"count":12,"queue":"rate-limited-sync"}'
```
Open http://localhost:4000/api/admin/queues:
- `reports`: 4 jobs complete in order gather → render → email → report; the parent's return value contains `emailed [rendered PDF from [gathered 12 policies]]`.
- `rate-limited-sync`: 5 complete immediately, 5 more after ~10 s, last 2 after ~20 s.
- `nightly-sweep`: one delayed job; wait for a 5-minute boundary and see a `sweep` log line.
Then `pkill -f "dist/main.js"`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): report flow, sweep scheduler, rate-limited processors"
```

---

## Phase 5 — Seed script, e2e test, local verification

### Task 5.1: CLI seeder and API e2e test

**Files:**
- Create: `scripts/seed-queue.ts`, `scripts/package.json`, `scripts/tsconfig.json`
- Create: `apps/api/jest.e2e.config.js`, `apps/api/test/jobs.e2e-spec.ts`

- [ ] **Step 1: Seeder**

`scripts/package.json`:
```json
{
  "name": "scripts", "version": "0.0.0", "private": true,
  "scripts": { "seed": "tsx seed-queue.ts" },
  "dependencies": { "@demo/queue": "workspace:*", "bullmq": "^5.34.0" },
  "devDependencies": { "@demo/tsconfig": "workspace:*", "tsx": "^4.19.2", "@types/node": "^22.10.2" }
}
```
`scripts/tsconfig.json`: `{ "extends": "@demo/tsconfig/base.json", "include": ["*.ts"] }`

`scripts/seed-queue.ts`:
```ts
// Usage: pnpm --filter scripts seed -- --count 50 --fail-rate 0.2 --queue renewal-reminders
import { Queue } from "bullmq";
import { QUEUES, redisConnectionOptions, type QueueName } from "@demo/queue";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const count = Number(arg("count", "50"));
const failRate = Number(arg("fail-rate", "0.2"));
const queueName = arg("queue", QUEUES.renewalReminders) as QueueName;

async function main() {
  const queue = new Queue(queueName, { connection: redisConnectionOptions(process.env) });
  const opts = { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 100, removeOnFail: 500 };
  const jobs = Array.from({ length: count }, (_, i) =>
    queueName === QUEUES.rateLimitedSync
      ? { name: "sync", data: { carrierId: `carrier-${i + 1}` }, opts }
      : { name: "remind", data: { policyId: `pol-${i + 1}`, agencyId: `agency-${(i % 5) + 1}`, renewalDate: "2026-12-01", failRate }, opts },
  );
  const added = await queue.addBulk(jobs);
  console.log(`enqueued ${added.length} jobs on ${queueName}`);
  await queue.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: e2e test that boots api + worker against local Redis**

`apps/api/jest.e2e.config.js`:
```js
module.exports = { preset: "ts-jest", testEnvironment: "node", rootDir: ".", testRegex: "test/.*\\.e2e-spec\\.ts$", testTimeout: 30000 };
```
`apps/api/test/jobs.e2e-spec.ts`:
```ts
import { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { Queue } from "bullmq";
import { QUEUES, redisConnectionOptions } from "@demo/queue";
import { AppModule } from "../src/app.module";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WorkerModule } = require("../../worker/src/worker.module");

describe("jobs e2e", () => {
  let api: INestApplication;
  let worker: INestApplicationContext;

  beforeAll(async () => {
    process.env.REDIS_URL ??= "redis://localhost:6379";
    const q = new Queue(QUEUES.renewalReminders, { connection: redisConnectionOptions(process.env) });
    await q.obliterate({ force: true });
    await q.close();
    api = await NestFactory.create(AppModule, { logger: false });
    await api.init();
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  });
  afterAll(async () => { await worker.close(); await api.close(); });

  it("seeded jobs reach completed", async () => {
    const res = await request(api.getHttpServer()).post("/api/jobs/seed").send({ count: 5, failRate: 0 });
    expect(res.body.enqueued).toBe(5);
    const deadline = Date.now() + 20_000;
    let completed = 0;
    while (Date.now() < deadline && completed < 5) {
      await new Promise((r) => setTimeout(r, 500));
      const stats = await request(api.getHttpServer()).get("/api/jobs/stats");
      completed = stats.body[QUEUES.renewalReminders].completed;
    }
    expect(completed).toBe(5);
  });
});
```

- [ ] **Step 3: Run**

If ts-jest refuses to compile `../../worker/src/worker.module.ts` (outside `rootDir`), add `roots: ["<rootDir>/src", "<rootDir>/test", "<rootDir>/../worker/src"]` to `jest.e2e.config.js`.

```bash
pnpm install && pnpm turbo run build && pnpm --filter api test:e2e
pnpm --filter scripts seed -- --count 10 --fail-rate 0.5
```
Expected: e2e passes (~5 s); seeder prints `enqueued 10 jobs on renewal-reminders`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: seed script and api e2e test"
```

### Task 5.2: Verification ladder rung 2 + learning notes 01 and 02

- [ ] **Step 1: Turborepo cache proof**

```bash
pnpm turbo run build --force >/dev/null && pnpm turbo run build
```
Expected: second run ends with `FULL TURBO` and `cached` on every task.

```bash
pnpm turbo run build --filter=worker... --dry-run=json | grep '"package"' | sort -u
```
Expected: only `@demo/queue` and `worker` (no `web`, no `api`).

- [ ] **Step 2: BullMQ behaviour proof**

Run api + worker (`pnpm dev` in the root — both restart on change), then:
```bash
pnpm --filter scripts seed -- --count 50 --fail-rate 0.2
```
In Bull Board after ~30 s: `renewal-reminders` shows ≈ 40 completed, ≈ 10 failed each with `attemptsMade: 3`. Click a failed job → the three attempts with exponential gaps (1 s, 2 s, 4 s) are visible in its logs/timestamps.

- [ ] **Step 3: Write `docs/01-turborepo.md`** with these sections and facts:
  - *What turbo adds over pnpm scripts*: task graph (`dependsOn: ["^build"]`), content-hashed cache keyed on inputs + env (`globalEnv`), `--filter` syntax (`worker...` = worker and its deps; `...worker` = worker and its dependents), `--dry-run=json` to see the graph.
  - *Why `outputs` matters*: what gets restored on a cache hit; why `.next/cache` is excluded.
  - *`turbo prune --docker`*: what `out/json`, `out/full`, `out/pnpm-lock.yaml` contain and why `packageManager` must be set.
  - *Gotchas hit in this repo* (fill from what actually happened).

- [ ] **Step 4: Write `docs/02-bullmq.md`** with sections: *Queue vs Worker vs QueueEvents vs FlowProducer* (which process owns which); *Job lifecycle* (waiting → active → completed/failed/delayed, stalled); *Retries* (`attempts`, `backoff`), *why `maxRetriesPerRequest: null`*; *Flows* (children run first; `getChildrenValues()`); *Job schedulers* (`upsertJobScheduler` replaces the old `repeat` API); *Rate limiting is per-queue and enforced in Redis*; *Graceful shutdown* (`enableShutdownHooks` → `worker.close()` waits for active jobs); *How this maps to Sidekiq* (queue ≈ Sidekiq queue, processor ≈ worker class, scheduler ≈ sidekiq-scheduler, Bull Board ≈ Sidekiq Web).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: turborepo and bullmq learning notes"
```

---

## Phase 6 — Next.js web

### Task 6.1: Landing page with stats table and action buttons

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.js`, `apps/web/next-env.d.ts`, `apps/web/.env.example`, `apps/web/eslint.config.js`
- Create: `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/actions.tsx`, `apps/web/app/globals.css`, `apps/web/lib/api.ts`

**Interfaces:**
- Consumes: `GET /api/jobs/stats`, `POST /api/jobs/seed`, `POST /api/jobs/report`.
- Env: `API_URL` (server-side base URL).

- [ ] **Step 1: Package files**

`apps/web/package.json`:
```json
{
  "name": "web", "version": "0.0.0", "private": true,
  "scripts": { "build": "next build", "dev": "next dev -p 3000", "start": "next start -p 3000", "lint": "next lint", "typecheck": "tsc --noEmit" },
  "dependencies": { "next": "^15.1.3", "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "@demo/tsconfig": "workspace:*", "@types/node": "^22.10.2", "@types/react": "^19.0.2",
    "@types/react-dom": "^19.0.2", "eslint": "^9.17.0", "eslint-config-next": "^15.1.3", "typescript": "^5.7.2"
  }
}
```
`apps/web/tsconfig.json`:
```json
{ "extends": "@demo/tsconfig/next.json", "compilerOptions": { "paths": { "@/*": ["./*"] } }, "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"], "exclude": ["node_modules"] }
```
`apps/web/next.config.js`:
```js
/** @type {import('next').NextConfig} */
module.exports = { output: "standalone" };
```
`apps/web/next-env.d.ts`:
```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />
```
`apps/web/.env.example`: `API_URL=http://localhost:4000`
`apps/web/eslint.config.js`:
```js
module.exports = [...require("eslint-config-next/core-web-vitals")];
```

- [ ] **Step 2: API client, page, actions**

`apps/web/lib/api.ts`:
```ts
export const API_URL = process.env.API_URL ?? "http://localhost:4000";
export type Counts = { waiting: number; active: number; completed: number; failed: number; delayed: number };
export async function getStats(): Promise<Record<string, Counts>> {
  const res = await fetch(`${API_URL}/api/jobs/stats`, { cache: "no-store" });
  if (!res.ok) throw new Error(`stats failed: ${res.status}`);
  return res.json();
}
```
`apps/web/app/layout.tsx`:
```tsx
import "./globals.css";
export const metadata = { title: "NextAgency Demo" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
```
`apps/web/app/globals.css`:
```css
body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
table { border-collapse: collapse; margin-top: 1rem; }
td, th { border: 1px solid #ccc; padding: .4rem .8rem; text-align: right; }
th:first-child, td:first-child { text-align: left; }
button { margin-right: .5rem; padding: .5rem 1rem; }
```
`apps/web/app/actions.tsx`:
```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function Actions() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const call = async (label: string, path: string, body: unknown) => {
    setBusy(label);
    await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(null);
    router.refresh();
  };
  return (
    <p>
      <button disabled={!!busy} onClick={() => call("seed", "/api/jobs/seed", { count: 50, failRate: 0.2 })}>Seed 50 reminders (20% fail)</button>
      <button disabled={!!busy} onClick={() => call("report", "/api/jobs/report", {})}>Run report flow</button>
      <button disabled={!!busy} onClick={() => router.refresh()}>Refresh</button>
      {busy && <span>working…</span>}
    </p>
  );
}
```
`apps/web/app/page.tsx`:
```tsx
import { getStats } from "@/lib/api";
import { Actions } from "./actions";

export const dynamic = "force-dynamic";

export default async function Home() {
  const stats = await getStats();
  const cols = ["waiting", "active", "completed", "failed", "delayed"] as const;
  return (
    <main>
      <h1>NextAgency Demo — queue dashboard</h1>
      <Actions />
      <table>
        <thead><tr><th>queue</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {Object.entries(stats).map(([name, c]) => (
            <tr key={name}><td>{name}</td>{cols.map((k) => <td key={k}>{c[k]}</td>)}</tr>
          ))}
        </tbody>
      </table>
      <p><a href="/api/admin/queues">Open Bull Board →</a></p>
    </main>
  );
}
```

- [ ] **Step 3: Local proxy so browser calls to `/api/*` reach the api in dev**

Add to `apps/web/next.config.js`:
```js
module.exports = {
  output: "standalone",
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${process.env.API_URL ?? "http://localhost:4000"}/api/:path*` }];
  },
};
```
(On Fargate the ALB does this routing; the rewrite is harmless there because `API_URL` points at the ALB.)

- [ ] **Step 4: Verify**

```bash
pnpm install && pnpm dev
```
Open http://localhost:3000 — table renders; *Seed* increases `renewal-reminders` counts; *Run report flow* adds to `reports`; Bull Board link opens. `pnpm turbo run build` succeeds and `apps/web/.next/standalone/apps/web/server.js` exists.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): landing page with queue stats and actions"
```

---

## Phase 7 — Docker

### Task 7.1: Dockerfiles with `turbo prune`, compose `full` profile

**Files:**
- Create: `docker/Dockerfile.api`, `docker/Dockerfile.worker`, `docker/Dockerfile.web`, `.dockerignore`
- Modify: `docker/docker-compose.yml`

- [ ] **Step 1: `.dockerignore`**

```
node_modules
**/node_modules
**/dist
**/.next
.turbo
**/.turbo
.git
infra
docs
```

- [ ] **Step 2: `docker/Dockerfile.api`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /app

FROM base AS pruner
RUN pnpm add -g turbo@2
COPY . .
RUN turbo prune api --docker

FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=api...
RUN pnpm prune --prod

FROM node:22-alpine AS runner
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=installer /app .
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "apps/api/dist/main.js"]
```

- [ ] **Step 3: `docker/Dockerfile.worker`** — identical except: `turbo prune worker --docker`, `--filter=worker...`, no `ENV PORT`, no `EXPOSE`, no `HEALTHCHECK`, `CMD ["node", "apps/worker/dist/main.js"]`.

- [ ] **Step 4: `docker/Dockerfile.web`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate
WORKDIR /app

FROM base AS pruner
RUN pnpm add -g turbo@2
COPY . .
RUN turbo prune web --docker

FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm turbo run build --filter=web...

FROM node:22-alpine AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=installer /app/apps/web/.next/standalone ./
COPY --from=installer /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

- [ ] **Step 5: Compose with `full` profile**

`docker/docker-compose.yml`:
```yaml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  api:
    profiles: ["full"]
    build: { context: .., dockerfile: docker/Dockerfile.api }
    environment: { REDIS_URL: redis://redis:6379 }
    ports: ["4000:4000"]
    depends_on: [redis]

  worker:
    profiles: ["full"]
    build: { context: .., dockerfile: docker/Dockerfile.worker }
    environment: { REDIS_URL: redis://redis:6379 }
    depends_on: [redis]

  web:
    profiles: ["full"]
    build: { context: .., dockerfile: docker/Dockerfile.web }
    environment: { API_URL: http://api:4000 }
    ports: ["3000:3000"]
    depends_on: [api]
```

- [ ] **Step 6: Build and run all three (native arch first — fast)**

```bash
docker compose -f docker/docker-compose.yml --profile full up --build
```
Expected: http://localhost:3000 renders; seed button changes counts; `docker compose ... ps` shows `api` healthy. Note image sizes with `docker images | grep nextagency`. Stop with Ctrl-C, `docker compose -f docker/docker-compose.yml --profile full down`.

- [ ] **Step 7: Prove the arm64 build works (slow, once)**

```bash
docker buildx build --platform linux/arm64 -f docker/Dockerfile.worker -t demo-worker:arm64 --load .
docker run --rm --platform linux/arm64 demo-worker:arm64 node -e "console.log(process.arch)"
```
Expected: `arm64`.

- [ ] **Step 8: Write `docs/03-docker-monorepo.md`**: *why prune* (image doesn't contain the other apps), *the 4 stages and what each caches*, *why `pnpm prune --prod` after build*, *standalone Next output layout* (`apps/web/server.js`, static copied separately), *non-root user*, *HEALTHCHECK only where there is an HTTP port*, *arm64 via QEMU: build time observed*.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "build: turbo-prune multi-stage dockerfiles and compose full profile"
```

---

## Phase 8 — Terraform bootstrap root

### Task 8.1: `infra/bootstrap` — state bucket, lock table, budget, OIDC provider

**Files:**
- Create: `infra/bootstrap/versions.tf`, `infra/bootstrap/variables.tf`, `infra/bootstrap/main.tf`, `infra/bootstrap/outputs.tf`, `infra/bootstrap/terraform.tfvars.example`, `infra/README.md`

- [ ] **Step 1: Files**

`infra/bootstrap/versions.tf`:
```hcl
terraform {
  required_version = ">= 1.9"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.80" } }
}
provider "aws" {
  region  = var.region
  profile = var.aws_profile
  default_tags { tags = { Project = "nextagency-demo", Environment = "bootstrap", ManagedBy = "terraform" } }
}
```
`infra/bootstrap/variables.tf`:
```hcl
variable "region"      { type = string, default = "us-east-1" }
variable "aws_profile" { type = string, default = "personal" }
variable "alert_email" { type = string }
variable "state_bucket_name" {
  type        = string
  description = "Globally unique, e.g. nextagency-demo-tfstate-<accountid>"
}
```
`infra/bootstrap/main.tf`:
```hcl
resource "aws_s3_bucket" "state" {
  bucket        = var.state_bucket_name
  force_destroy = true
}
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "AES256" } }
}
resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "lock" {
  name         = "nextagency-demo-tflock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  attribute { name = "LockID", type = "S" }
}

resource "aws_budgets_budget" "monthly" {
  name         = "nextagency-demo-monthly"
  budget_type  = "COST"
  limit_amount = "20"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  dynamic "notification" {
    for_each = [50, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.alert_email]
    }
  }
}

# Account-global. Lives here (not in production/) so destroying production never removes it.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}
```
`infra/bootstrap/outputs.tf`:
```hcl
output "state_bucket"       { value = aws_s3_bucket.state.bucket }
output "lock_table"         { value = aws_dynamodb_table.lock.name }
output "github_oidc_provider_arn" { value = aws_iam_openid_connect_provider.github.arn }
```
`infra/bootstrap/terraform.tfvars.example`:
```hcl
alert_email       = "you@example.com"
state_bucket_name = "nextagency-demo-tfstate-123456789012"
```
`infra/README.md`:
```markdown
# infra/
Two independent Terraform roots, each with its own state (same convention as NextAgency's `terraform/`).
- `bootstrap/` — local state. State bucket, lock table, budget alarm, GitHub OIDC provider. Apply once, keep.
- `production/` — S3 backend. Everything the app needs. Apply for the demo, destroy after.
Order: bootstrap → push images (Task 9.6) → production.
```

- [ ] **Step 2: Apply**

```bash
cd infra/bootstrap && cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars: your email, bucket name with your account id
terraform init && terraform validate && terraform plan -out tfplan && terraform apply tfplan
terraform output
```
Expected: 4 resource groups created; outputs printed; AWS Budgets sends a confirmation e-mail (verification ladder rung 4).

- [ ] **Step 3: Write `docs/04-terraform-state-and-roots.md`**: *why remote state* (team, locking, secrets in state), *root = state boundary*, *`default_tags`*, *`plan -out` then `apply tfplan` habit*, *what `terraform.tfvars` vs `.example` is for*, *why the OIDC provider is account-global*.

- [ ] **Step 4: Commit** (tfstate and tfvars are git-ignored)

```bash
cd ~/nextagency-demo && git add -A && git commit -m "infra: bootstrap root (state bucket, lock table, budget, github oidc provider)"
```

---

## Phase 9 — Terraform production root

Each task below is a file group; `terraform validate` + `plan` is the test. Nothing is applied until Task 9.6.

### Task 9.1: Providers, backend, variables, network

**Files:**
- Create: `infra/production/versions.tf`, `variables.tf`, `network.tf`, `terraform.tfvars.example`, `locals.tf`

- [ ] **Step 1: Files**

`infra/production/versions.tf` (fill bucket/table from bootstrap outputs):
```hcl
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.80" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    bucket         = "nextagency-demo-tfstate-<ACCOUNT_ID>"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "nextagency-demo-tflock"
    profile        = "personal"
    encrypt        = true
  }
}
provider "aws" {
  region  = var.region
  profile = var.aws_profile
  default_tags { tags = { Project = "nextagency-demo", Environment = "production", ManagedBy = "terraform" } }
}
```
`infra/production/variables.tf`:
```hcl
variable "region"        { type = string, default = "us-east-1" }
variable "aws_profile"   { type = string, default = "personal" }
variable "vpc_cidr"      { type = string, default = "10.40.0.0/16" }
variable "image_tag"     { type = string, default = "bootstrap" }
variable "github_repo"   { type = string, description = "owner/repo, e.g. msohaibnoor/nextagency-demo" }
variable "github_branch" { type = string, default = "main" }
variable "task_cpu"      { type = number, default = 256 }
variable "task_memory"   { type = number, default = 512 }
variable "github_oidc_provider_arn" { type = string, description = "from bootstrap output" }
```
`infra/production/locals.tf`:
```hcl
locals {
  name = "nextagency-demo"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
  apps = toset(["api", "worker", "web"])
}
data "aws_availability_zones" "available" { state = "available" }
data "aws_caller_identity" "current" {}
```
`infra/production/network.tf` (same tiering as NextAgency: offsets 0 / 10 / 20):
```hcl
resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}
resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.name}-public-${local.azs[count.index]}", Tier = "public" }
}
resource "aws_subnet" "private_app" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 10 + count.index)
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.name}-private-app-${local.azs[count.index]}", Tier = "private-app" }
}
resource "aws_subnet" "private_data" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 20 + count.index)
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.name}-private-data-${local.azs[count.index]}", Tier = "private-data" }
}

resource "aws_eip" "nat" { domain = "vpc" }
resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = local.name }
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route { cidr_block = "0.0.0.0/0", gateway_id = aws_internet_gateway.this.id }
  tags = { Name = "${local.name}-public" }
}
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  route { cidr_block = "0.0.0.0/0", nat_gateway_id = aws_nat_gateway.this.id }
  tags = { Name = "${local.name}-private-app" }
}
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id # no default route: data tier has no internet path at all
  tags   = { Name = "${local.name}-private-data" }
}
resource "aws_route_table_association" "public"       { count = 2, subnet_id = aws_subnet.public[count.index].id,       route_table_id = aws_route_table.public.id }
resource "aws_route_table_association" "private_app"  { count = 2, subnet_id = aws_subnet.private_app[count.index].id,  route_table_id = aws_route_table.private.id }
resource "aws_route_table_association" "private_data" { count = 2, subnet_id = aws_subnet.private_data[count.index].id, route_table_id = aws_route_table.data.id }
```
`infra/production/terraform.tfvars.example`:
```hcl
github_repo              = "msohaibnoor/nextagency-demo"
github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
```

- [ ] **Step 2: Validate**

```bash
cd infra/production && cp terraform.tfvars.example terraform.tfvars   # fill both values
terraform init && terraform validate && terraform plan
```
Expected: `Plan: 19 to add` (VPC, IGW, 6 subnets, EIP, NAT, 3 RTs, 6 associations).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "infra(production): backend, variables, three-tier network"
```

### Task 9.2: Security groups, ElastiCache Redis, Secrets Manager

**Files:** `infra/production/security.tf`, `data_stores.tf`, `secrets.tf`

- [ ] **Step 1: Files**

`security.tf`:
```hcl
resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  vpc_id      = aws_vpc.this.id
  ingress { from_port = 80, to_port = 80, protocol = "tcp", cidr_blocks = ["0.0.0.0/0"] }
  egress  { from_port = 0,  to_port = 0,  protocol = "-1",  cidr_blocks = ["0.0.0.0/0"] }
  tags = { Name = "${local.name}-alb" }
}
resource "aws_security_group" "app" {
  name_prefix = "${local.name}-app-"
  vpc_id      = aws_vpc.this.id
  ingress { from_port = 3000, to_port = 3000, protocol = "tcp", security_groups = [aws_security_group.alb.id] }
  ingress { from_port = 4000, to_port = 4000, protocol = "tcp", security_groups = [aws_security_group.alb.id] }
  egress  { from_port = 0,    to_port = 0,    protocol = "-1",  cidr_blocks = ["0.0.0.0/0"] }
  tags = { Name = "${local.name}-app" }
}
resource "aws_security_group" "redis" {
  name_prefix = "${local.name}-redis-"
  vpc_id      = aws_vpc.this.id
  ingress { from_port = 6379, to_port = 6379, protocol = "tcp", security_groups = [aws_security_group.app.id] }
  egress  { from_port = 0,    to_port = 0,    protocol = "-1",  cidr_blocks = ["0.0.0.0/0"] }
  tags = { Name = "${local.name}-redis" }
}
```
`data_stores.tf`:
```hcl
resource "random_password" "redis_auth" {
  length  = 32
  special = false # ElastiCache limits allowed symbols; alnum keeps the URL unescaped
}
resource "aws_elasticache_subnet_group" "redis" {
  name       = "${local.name}-redis"
  subnet_ids = aws_subnet.private_data[*].id
}
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${local.name}-redis"
  description                = "BullMQ broker for ${local.name}"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = 1
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result
  automatic_failover_enabled = false
  apply_immediately          = true
}
```
`secrets.tf`:
```hcl
resource "aws_secretsmanager_secret" "redis_url" {
  name                    = "${local.name}/production/redis-url"
  recovery_window_in_days = 0 # demo: allow immediate re-create after destroy
}
resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id     = aws_secretsmanager_secret.redis_url.id
  secret_string = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
}
```

- [ ] **Step 2: Validate**

```bash
terraform validate && terraform plan | grep -E "Plan:|elasticache|secretsmanager"
```
Expected: plan adds 3 SGs, subnet group, replication group, password, secret + version.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "infra(production): security groups, elasticache redis, redis url secret"
```

### Task 9.3: ECR, logs, IAM roles

**Files:** `infra/production/ecr.tf`, `logs.tf`, `iam.tf`

- [ ] **Step 1: Files**

`ecr.tf`:
```hcl
resource "aws_ecr_repository" "app" {
  for_each             = local.apps
  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "MUTABLE" # we move :latest
  force_delete         = true
  image_scanning_configuration { scan_on_push = true }
}
resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = local.apps
  repository = aws_ecr_repository.app[each.key].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1, description = "keep last 10",
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 },
      action       = { type = "expire" }
    }]
  })
}
```
`logs.tf`:
```hcl
resource "aws_cloudwatch_log_group" "app" {
  for_each          = local.apps
  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = 7
}
```
`iam.tf`:
```hcl
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals { type = "Service", identifiers = ["ecs-tasks.amazonaws.com"] }
  }
}

# EXECUTION role: what the ECS agent needs to START the task (pull image, fetch secrets, ship logs)
resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}
resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-redis-url"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.redis_url.arn }]
  })
}

# TASK role: what the APPLICATION CODE may call. Only ECS Exec plumbing here.
resource "aws_iam_role" "task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}
resource "aws_iam_role_policy" "task_exec" {
  name = "ecs-exec"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"]
      Resource = "*"
    }]
  })
}
```

- [ ] **Step 2: Validate**: `terraform validate && terraform plan | grep Plan:` → adds 3 repos, 3 lifecycle policies, 3 log groups, 2 roles, 3 policies/attachments.

- [ ] **Step 3: Commit**: `git add -A && git commit -m "infra(production): ecr, log groups, execution and task roles"`

### Task 9.4: ECS cluster, task definitions, ALB, services

**Files:** `infra/production/compute.tf`

- [ ] **Step 1: File**

```hcl
resource "aws_ecs_cluster" "this" {
  name = local.name
  setting { name = "containerInsights", value = "enabled" }
}

# ---------- ALB ----------
resource "aws_lb" "this" {
  name               = local.name
  load_balancer_type = "application"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]
}
resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id
  health_check { path = "/", matcher = "200", interval = 15, healthy_threshold = 2, unhealthy_threshold = 3 }
  deregistration_delay = 10
}
resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 4000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id
  health_check { path = "/api/health", matcher = "200", interval = 15, healthy_threshold = 2, unhealthy_threshold = 3 }
  deregistration_delay = 10
}
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action { type = "forward", target_group_arn = aws_lb_target_group.web.arn }
}
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  action { type = "forward", target_group_arn = aws_lb_target_group.api.arn }
  condition { path_pattern { values = ["/api/*"] } }
}

# ---------- Task definitions ----------
locals {
  common_env = { NODE_ENV = "production" }
  container = {
    api = {
      port = 4000
      env  = merge(local.common_env, { PORT = "4000" })
      secrets = [{ name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn }]
      stop_timeout = 30
    }
    worker = {
      port = null
      env  = local.common_env
      secrets = [{ name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn }]
      stop_timeout = 60 # let in-flight jobs finish on deploy
    }
    web = {
      port = 3000
      env  = merge(local.common_env, { PORT = "3000", HOSTNAME = "0.0.0.0", API_URL = "http://${aws_lb.this.dns_name}" })
      secrets = []
      stop_timeout = 30
    }
  }
}

resource "aws_ecs_task_definition" "app" {
  for_each                 = local.apps
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform { cpu_architecture = "ARM64", operating_system_family = "LINUX" }

  container_definitions = jsonencode([{
    name        = each.key
    image       = "${aws_ecr_repository.app[each.key].repository_url}:${var.image_tag}"
    essential   = true
    stopTimeout = local.container[each.key].stop_timeout
    portMappings = local.container[each.key].port == null ? [] : [{ containerPort = local.container[each.key].port, protocol = "tcp" }]
    environment = [for k, v in local.container[each.key].env : { name = k, value = v }]
    secrets     = local.container[each.key].secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])
}

# ---------- Services ----------
resource "aws_ecs_service" "app" {
  for_each               = local.apps
  name                   = each.key
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.app[each.key].arn
  desired_count          = 1
  launch_type            = "FARGATE"
  enable_execute_command = true

  network_configuration {
    subnets          = aws_subnet.private_app[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker { enable = true, rollback = true }
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  dynamic "load_balancer" {
    for_each = each.key == "worker" ? [] : [each.key]
    content {
      target_group_arn = each.key == "web" ? aws_lb_target_group.web.arn : aws_lb_target_group.api.arn
      container_name   = each.key
      container_port   = local.container[each.key].port
    }
  }

  depends_on = [aws_lb_listener.http, aws_lb_listener_rule.api]

  lifecycle { ignore_changes = [task_definition] } # app deploys register new revisions outside Terraform
}
```

- [ ] **Step 2: Validate**: `terraform validate && terraform plan | grep Plan:` → cluster, ALB, 2 TGs, listener, rule, 3 task defs, 3 services.

- [ ] **Step 3: Commit**: `git add -A && git commit -m "infra(production): ecs cluster, task definitions, alb routing, services"`

### Task 9.5: GitHub deploy role and outputs

**Files:** `infra/production/cicd.tf`, `outputs.tf`

- [ ] **Step 1: Files**

`cicd.tf`:
```hcl
resource "aws_iam_role" "github_deploy" {
  name = "${local.name}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = var.github_oidc_provider_arn }
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:refs/heads/${var.github_branch}" }
      }
    }]
  })
}
resource "aws_iam_role_policy" "github_deploy" {
  name = "deploy"
  role = aws_iam_role.github_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow",
        Action = ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        Resource = [for r in aws_ecr_repository.app : r.arn] },
      { Effect = "Allow", Action = ["ecs:UpdateService", "ecs:DescribeServices"], Resource = [for s in aws_ecs_service.app : s.id] },
      { Effect = "Allow", Action = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"], Resource = "*" },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.execution.arn, aws_iam_role.task.arn] }
    ]
  })
}
```
`outputs.tf`:
```hcl
output "alb_dns_name"           { value = aws_lb.this.dns_name }
output "cluster_name"           { value = aws_ecs_cluster.this.name }
output "service_names"          { value = { for k, s in aws_ecs_service.app : k => s.name } }
output "ecr_repository_urls"    { value = { for k, r in aws_ecr_repository.app : k => r.repository_url } }
output "github_deploy_role_arn" { value = aws_iam_role.github_deploy.arn }
output "redis_secret_arn"       { value = aws_secretsmanager_secret.redis_url.arn }
```

- [ ] **Step 2: Validate**: `terraform validate && terraform plan -out tfplan | grep Plan:` — note the total (≈ 50 resources).

- [ ] **Step 3: Commit**: `git add -A && git commit -m "infra(production): github oidc deploy role and outputs"`

### Task 9.6: First apply — in the right order

The services reference `<repo>:bootstrap`; if that image doesn't exist the services will loop on pull errors. So: apply everything *except* services, push images, then apply the rest.

- [ ] **Step 1: Apply ECR only, push `bootstrap` images**

```bash
cd infra/production
terraform apply -target=aws_ecr_repository.app -auto-approve
ACCOUNT=$(aws sts get-caller-identity --profile personal --query Account --output text)
aws ecr get-login-password --profile personal --region us-east-1 | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.us-east-1.amazonaws.com
cd ~/nextagency-demo
for app in api worker web; do
  docker buildx build --platform linux/arm64 -f docker/Dockerfile.$app \
    -t $ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/nextagency-demo/$app:bootstrap --push .
done
```
Expected: three pushes succeed (arm64 build ≈ 5–10 min each the first time; later builds hit the buildx cache).

- [ ] **Step 2: Apply the rest**

```bash
cd infra/production && terraform plan -out tfplan && terraform apply tfplan
terraform output
```
Expected: ≈ 10 min (ElastiCache is the long pole). Outputs show `alb_dns_name`.

- [ ] **Step 3: Verify ladder rung 5**

```bash
ALB=$(terraform output -raw alb_dns_name)
until curl -sf http://$ALB/api/health; do sleep 10; done
curl -s http://$ALB/api/jobs/stats
```
Open `http://$ALB` in the browser — landing page renders; click *Seed* — counts change; Bull Board opens at `http://$ALB/api/admin/queues`.

If the api target is unhealthy: `aws ecs describe-services --profile personal --cluster nextagency-demo --services api --query 'services[0].events[:5]'` and `aws logs tail /ecs/nextagency-demo/api --profile personal --since 10m`.

- [ ] **Step 4: Write `docs/05-vpc-three-tier.md`, `docs/06-ecs-fargate-roles-and-tasks.md`, `docs/07-alb-routing.md`**:
  - 05: the three tiers and which route table each has; why the data tier has *no* default route; what a NAT gateway is for and what it costs; how `cidrsubnet(cidr, 8, i)` carves `/24`s; why the ALB lives in public subnets but tasks don't.
  - 06: cluster vs service vs task definition vs task; execution role vs task role (with the exact permissions from `iam.tf`); `awsvpc` networking and why every task gets its own ENI; secrets injection (`valueFrom`) vs env; `stopTimeout` and SIGTERM; `runtime_platform ARM64`; the circuit breaker; why `ignore_changes = [task_definition]`.
  - 07: target group `ip` type; health checks per TG; listener rule priority; path-based routing `/api/*` → api; `deregistration_delay`.

- [ ] **Step 5: Commit**: `git add -A && git commit -m "docs: vpc, ecs, alb learning notes"`

---

## Phase 10 — Deploy script and operations

### Task 10.1: `scripts/deploy.sh`, ECS Exec, log tailing

**Files:** `scripts/deploy.sh`, `docs/08-deploy-and-oidc.md` (part 1)

- [ ] **Step 1: Script**

`scripts/deploy.sh`:
```bash
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
docker buildx build --platform linux/arm64 -f "docker/Dockerfile.$APP" -t "$REPO:$TAG" -t "$REPO:latest" --push .

echo ">> point the task definition at :$TAG and roll the service"
TD_ARN=$(aws ecs describe-services $PROFILE_ARG --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)
aws ecs describe-task-definition $PROFILE_ARG --region "$REGION" --task-definition "$TD_ARN" --query 'taskDefinition' \
  | jq --arg img "$REPO:$TAG" '.containerDefinitions[0].image = $img
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)' \
  > /tmp/td-$APP.json
NEW_TD=$(aws ecs register-task-definition $PROFILE_ARG --region "$REGION" --cli-input-json file:///tmp/td-$APP.json --query 'taskDefinition.taskDefinitionArn' --output text)
aws ecs update-service $PROFILE_ARG --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEW_TD" >/dev/null

echo ">> waiting for $SERVICE to stabilise"
aws ecs wait services-stable $PROFILE_ARG --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
echo ">> done: http://$ALB  ($APP @ $TAG)"
```
`chmod +x scripts/deploy.sh`. Requires `jq` (`sudo apt-get install -y jq`).

- [ ] **Step 2: Deploy a visible change**

Edit `apps/web/app/page.tsx` heading to `NextAgency Demo — queue dashboard (v2)`, commit, then:
```bash
AWS_PROFILE=personal scripts/deploy.sh web
```
Expected: build, push, new task definition revision, `services-stable` returns, the ALB page shows *(v2)*. In the ECS console → service `web` → Deployments, watch the rolling replacement.

- [ ] **Step 3: ECS Exec into the worker (the SSM runbook equivalent)**

```bash
sudo apt-get install -y session-manager-plugin 2>/dev/null || { curl -s "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o /tmp/smp.deb && sudo dpkg -i /tmp/smp.deb; }
TASK=$(aws ecs list-tasks --profile personal --cluster nextagency-demo --service-name worker --query 'taskArns[0]' --output text)
aws ecs execute-command --profile personal --cluster nextagency-demo --task "$TASK" --container worker --interactive --command "/bin/sh"
# inside: env | grep REDIS_URL ; node -e "console.log(process.arch)" ; exit
```
Expected: a shell inside the running worker; `REDIS_URL` is the `rediss://` secret; arch `arm64`.

- [ ] **Step 4: Tail logs while seeding**

```bash
aws logs tail /ecs/nextagency-demo/worker --profile personal --follow &
curl -s -XPOST http://$(cd infra/production && terraform output -raw alb_dns_name)/api/jobs/seed -H 'content-type: application/json' -d '{"count":20}'
```
Expected: `completed`/`failed` JSON lines stream from the worker task. `kill %1`.

- [ ] **Step 5: Commit**: `git add -A && git commit -m "ops: deploy script; ecs exec and log tailing verified"`

---

## Phase 11 — GitHub Actions with OIDC

### Task 11.1: Workflow

**Files:** `.github/workflows/deploy.yml`, `docs/08-deploy-and-oidc.md` (part 2)

- [ ] **Step 1: Workflow**

```yaml
name: deploy
on:
  push: { branches: [main] }
  workflow_dispatch:

permissions:
  id-token: write   # OIDC token for AWS
  contents: read

env:
  AWS_REGION: us-east-1

jobs:
  deploy:
    runs-on: ubuntu-latest
    strategy:
      matrix: { app: [api, worker, web] }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
        with: { platforms: arm64 }
      - uses: docker/setup-buildx-action@v3
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}
      - uses: hashicorp/setup-terraform@v3
        with: { terraform_wrapper: false }
      - name: terraform init (read outputs only)
        working-directory: infra/production
        run: terraform init -input=false
      - name: deploy ${{ matrix.app }}
        run: |
          sudo apt-get install -y jq
          scripts/deploy.sh ${{ matrix.app }} ${GITHUB_SHA::7}
```

- [ ] **Step 2: Allow the deploy role to read Terraform state** (the script runs `terraform output`)

Append to `infra/production/cicd.tf` policy `Statement` list:
```hcl
      { Effect = "Allow", Action = ["s3:GetObject", "s3:ListBucket"],
        Resource = ["arn:aws:s3:::nextagency-demo-tfstate-${data.aws_caller_identity.current.account_id}", "arn:aws:s3:::nextagency-demo-tfstate-${data.aws_caller_identity.current.account_id}/production/*"] },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        Resource = "arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/nextagency-demo-tflock" }
```
Also remove `profile = "personal"` from the `backend "s3"` block in `versions.tf` (CI has no profile) and instead run locally with `AWS_PROFILE=personal terraform …` from now on. Then `terraform init -migrate-state` (no-op), `terraform apply`.

- [ ] **Step 3: Configure GitHub**

Repo → Settings → Secrets and variables → Actions → New secret `AWS_DEPLOY_ROLE_ARN` = output of `terraform output -raw github_deploy_role_arn`. (The ARN is not sensitive; a secret is used only to keep it out of the workflow file.)

- [ ] **Step 4: Trigger and verify ladder rung 7**

```bash
git add -A && git commit -m "ci: github actions deploy via oidc" && git push
```
Actions tab → `deploy` runs three matrix jobs → all green → ECS shows new revisions tagged with the commit SHA. No AWS access keys exist anywhere in GitHub.

- [ ] **Step 5: Write `docs/08-deploy-and-oidc.md`**: *the 4 deploy steps and what each AWS API call is*; *why register a new task definition revision rather than `--force-new-deployment` on `:latest`* (traceability + rollback = re-point to an older revision); *OIDC flow* (GitHub mints a JWT → `AssumeRoleWithWebIdentity` → trust policy checks `aud` and `sub`); *why `sub` is pinned to `main`*; *least privilege list of the role*; *`ignore_changes = [task_definition]` is what stops Terraform fighting CI*.

- [ ] **Step 6: Commit**: `git add -A && git commit -m "docs: deploy and oidc notes"`

---

## Phase 12 — Failure drills

### Task 12.1: Circuit-breaker rollback and stalled-job recovery

**Files:** `docs/09-failure-drills.md`

- [ ] **Step 1: Bad deployment → automatic rollback**

Temporarily change `apps/api/src/health/health.controller.ts` so `check()` returns `{ ok: false, redis: "down" }` with `@HttpCode(500)`:
```ts
import { Controller, Get, HttpCode, Inject } from "@nestjs/common";
// …
  @Get() @HttpCode(500)
  async check() { return { ok: false, redis: "down" as const }; }
```
Commit on a branch (don't push to main): `git checkout -b drill && git commit -am "drill: broken health"`, then `AWS_PROFILE=personal scripts/deploy.sh api drill-bad`.

Expected: `services-stable` waits, ECS events show `(service api) deployment failed: tasks failed container health checks` (or ALB health check), circuit breaker marks the deployment `FAILED` and rolls back to the previous revision; the ALB never served a 500 to `/api/health` for more than the health-check window. `git checkout main && git branch -D drill`.

- [ ] **Step 2: Worker killed mid-batch → replacement drains the queue**

```bash
ALB=$(cd infra/production && AWS_PROFILE=personal terraform output -raw alb_dns_name)
curl -s -XPOST http://$ALB/api/jobs/seed -H 'content-type: application/json' -d '{"count":200,"failRate":0}'
TASK=$(aws ecs list-tasks --profile personal --cluster nextagency-demo --service-name worker --query 'taskArns[0]' --output text)
aws ecs stop-task --profile personal --cluster nextagency-demo --task "$TASK" --reason drill >/dev/null
watch -n 5 "curl -s http://$ALB/api/jobs/stats | jq '.\"renewal-reminders\"'"
```
Expected: `active` drops to 0 for ~30–60 s while ECS launches a replacement, then `completed` climbs to 200. Any job that was `active` when the task died is re-queued by BullMQ's stalled-job checker (default 30 s) — you'll see `stalled` in Bull Board's job log for those.

- [ ] **Step 3: Scale the worker to 2 and watch the rate limiter stay global**

```bash
aws ecs update-service --profile personal --cluster nextagency-demo --service worker --desired-count 2 >/dev/null
curl -s -XPOST http://$ALB/api/jobs/seed -H 'content-type: application/json' -d '{"count":20,"queue":"rate-limited-sync"}'
```
Expected: still 5 jobs per 10 s in total across both tasks (limiter state lives in Redis). Scale back: `--desired-count 1`.

- [ ] **Step 4: Write `docs/09-failure-drills.md`** with what you observed for each drill: event text, timings, Bull Board screenshots if you like.

- [ ] **Step 5: Commit**: `git add -A && git commit -m "docs: failure drill observations"`

---

## Phase 13 — Cost check and teardown

### Task 13.1: `scripts/cost-check.sh`, destroy, final notes

**Files:** `scripts/cost-check.sh`, `docs/10-teardown-and-cost.md`

- [ ] **Step 1: Cost script**

```bash
#!/usr/bin/env bash
# Daily cost of everything tagged Project=nextagency-demo for the last 7 days (Cost Explorer lags ~24h).
set -euo pipefail
START=$(date -u -d '7 days ago' +%F); END=$(date -u -d 'tomorrow' +%F)
aws ce get-cost-and-usage --profile "${AWS_PROFILE:-personal}" \
  --time-period Start=$START,End=$END --granularity DAILY --metrics UnblendedCost \
  --filter '{"Tags":{"Key":"Project","Values":["nextagency-demo"]}}' \
  --query 'ResultsByTime[].{day:TimePeriod.Start,usd:Total.UnblendedCost.Amount}' --output table
```
`chmod +x scripts/cost-check.sh`. Cost allocation tags must be activated once: Billing → Cost allocation tags → activate `Project` (takes up to 24 h to appear).

- [ ] **Step 2: Destroy production**

```bash
cd infra/production && AWS_PROFILE=personal terraform destroy
```
Expected: ≈ 50 resources destroyed in ~6–8 min (ElastiCache and NAT are slowest). Verify nothing is left: `aws ecs list-clusters --profile personal`, `aws elasticache describe-replication-groups --profile personal`, `aws ec2 describe-nat-gateways --profile personal --filter Name=state,Values=available`.

- [ ] **Step 3: Decide on bootstrap**

Keep `infra/bootstrap` (state bucket + lock table + budget ≈ $0.05/month; OIDC provider is free) so re-running the demo later is `terraform apply` in `production/` only. If you want zero footprint: `cd infra/bootstrap && terraform destroy` (the bucket has `force_destroy`), then delete the `nextagency-demo-admin` IAM user in the console.

- [ ] **Step 4: Run the cost check 24 h later** and record the real number in `docs/10-teardown-and-cost.md` alongside the pre-estimate (≈ $3.70/day), plus the destroy order and the "what survives destroy" list (bootstrap, ECR images are gone because `force_delete`, CloudWatch log groups gone because managed, Secrets Manager gone immediately because `recovery_window_in_days = 0`).

- [ ] **Step 5: Final commit and push**

```bash
git add -A && git commit -m "docs: teardown and cost notes" && git push
```

---

## Verification ladder ↔ tasks

| Rung | Proven in |
|---|---|
| 1 Monorepo cache/filter | Task 5.2 |
| 2 BullMQ behaviours | Tasks 4.2, 5.2 |
| 3 Images run locally | Task 7.1 |
| 4 Bootstrap | Task 8.1 |
| 5 Production apply + ALB | Task 9.6 |
| 6 Deploy / Exec / logs | Task 10.1 |
| 7 CI/CD via OIDC | Task 11.1 |
| 8 Failure drills | Task 12.1 |
| 9 Teardown + cost | Task 13.1 |
