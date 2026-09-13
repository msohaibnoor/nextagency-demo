# nextagency-demo

Learning monorepo that rehearses the NextAgency V3 platform: pnpm + Turborepo, NestJS API + BullMQ
worker, Next.js dashboard, Docker images, Terraform-managed AWS (ECS Fargate, ALB, ElastiCache),
GitHub-OIDC CI/CD.

## Start here — the three hands-on guides

| Guide | Read it when | What you'll do |
|---|---|---|
| [`docs/GUIDE-1-RUN-IT-LOCALLY.md`](docs/GUIDE-1-RUN-IT-LOCALLY.md) | First | Run Redis, api, worker, web by hand; seed every queue; watch jobs move; kill the worker and see recovery |
| [`docs/GUIDE-2-TERRAFORM-WHAT-HAPPENED.md`](docs/GUIDE-2-TERRAFORM-WHAT-HAPPENED.md) | Second | Walk `infra/` file by file: what each resource is, why, and how they reference each other |
| [`docs/GUIDE-3-AWS-CONSOLE-TOUR.md`](docs/GUIDE-3-AWS-CONSOLE-TOUR.md) | While the stack is up | A click-path checklist through every AWS service the demo touches |

Reference: [`docs/AWS-ECS-FARGATE-GUIDE.md`](docs/AWS-ECS-FARGATE-GUIDE.md) (vocabulary, troubleshooting,
teardown) and the per-phase notes `docs/01…10-*.md`.

## Quick commands

```bash
pnpm redis                       # local Redis via docker compose
pnpm dev                         # api :4000, worker, web :3000 (turbo)
pnpm test                        # all unit suites; pnpm --filter api test:e2e for the end-to-end one
docker compose -f docker/docker-compose.yml --profile full up --build   # the three images locally
AWS_PROFILE=personal scripts/deploy.sh <api|worker|web>                 # build → ECR → new task-def revision
```

Design spec: `docs/superpowers/specs/2026-09-12-nextagency-demo-design.md`.
Plan: `docs/superpowers/plans/2026-09-12-nextagency-demo.md`.
