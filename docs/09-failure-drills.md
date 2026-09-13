# 09 — Three failure drills against the live stack

See also `docs/AWS-ECS-FARGATE-GUIDE.md` §8, which sketches these same three
drills at an introductory level; this note has the actual commands, event
text, and timings from a real run against `nextagency-demo`.

**Baseline note**: the brief assumed `api:2` / `worker:2` / `web:3`. A few
minutes into Drill 1, a CI deploy of an unrelated, already-merged commit
(`33ab984`, a docs-only change pushed earlier) landed concurrently and moved
the live baseline forward one revision on all three services
(`api:2→3`, `worker:2→3`, `web:3→4`) — confirmed by `describe-task-definition`
showing that revision's image tagged `33ab984`, not our drill tag. This
wasn't triggered by this drill (nothing here was pushed to `main`); it's just
what happens when a manual drill runs on a service CI also deploys to. It
doesn't change any of the three drills' conclusions, but it does mean Drill
1's rollback target below is `api:3`, not `api:2`.

## Drill 1: bad deployment → automatic rollback

`apps/api/src/health/health.controller.ts`'s `check()` was changed to always
`@HttpCode(500)` and return `{ ok: false, redis: "down" }`, committed on a
local `drill` branch (never pushed), then deployed by hand:

```bash
git checkout -b drill && git commit -am "drill: broken health"
AWS_PROFILE=personal timeout 900 scripts/deploy.sh api drill-bad
```

`scripts/deploy.sh` registered this as task-definition `nextagency-demo-api:4`
(the CI deploy above had already claimed `:3`) and called `update-service`.
ECS then cycled through **three** replacement tasks, each rejected by the ALB
target group's health check (`interval 15s`, `unhealthy_threshold 3` →
45s per attempt, `compute.tf`), before the deployment circuit breaker
(`enable: true, rollback: true, threshold: BOUNDED_PERCENT 50`) gave up:

```
(task c9beb1b8…) (port 4000) is unhealthy … Health checks failed with these codes: [500]
(task fe8a0562…) (port 4000) is unhealthy … Health checks failed with these codes: [500]
(task fb1a36d8…) (port 4000) is unhealthy … Health checks failed with these codes: [500]
(service api) (deployment ecs-svc/3468368874827011691) deployment failed: tasks failed to start.
(service api) rolling back to deployment ecs-svc/4744463545704487209.
```

Timeline: `update-service` at 15:45:51 → last task declared unhealthy
15:54:58 → circuit breaker fires and starts rollback 15:55:47 → rollback
`rolloutState: COMPLETED` on `api:3` at 15:56:13. **~10m22s** end to end,
almost all of it three sequential 45s-health-check-plus-relaunch cycles.

**The safety net held**: `/api/health` was polled every ~2-3s throughout
(15:42:50 → 15:56:48, 307 requests) and every single one returned `200`
(`sort | uniq -c` → `307 200`) — the ALB never routed a request to a bad
task because each one was pulled from the target group before it could
receive traffic. `scripts/deploy.sh`'s own `aws ecs wait services-stable`
call exited 0 and printed `>> done: … (api @ drill-bad)` — worth noting as a
gotcha: "services-stable" means the *service* reached a steady state, not
that *your* revision is what's running. Cleanup: `git checkout main && git
branch -D drill`; final state confirmed `nextagency-demo-api:3`, `git
status` clean on `main`.

## Drill 2: worker killed mid-batch → replacement drains the queue

First attempt seeded 200 jobs and then fetched the task ARN and called
`stop-task` — but at concurrency 5 and ~100-500ms/job, 200 jobs finish in
~15s, faster than the two sequential AWS/curl round-trips took, so the batch
had already fully drained before the kill landed. Redone with the task ARN
fetched *first* and 2000 jobs seeded so the kill would land mid-flight:

```bash
TASK=$(aws ecs list-tasks --cluster nextagency-demo --service-name worker --query 'taskArns[0]' --output text)
curl -s -XPOST http://$ALB/api/jobs/seed -d '{"count":2000,"failRate":0}'
aws ecs stop-task --cluster nextagency-demo --task "$TASK" --reason drill
```

Immediately after: `waiting: 1932, active: 0` (68 jobs already done). Polling
`/api/jobs/stats` and `ecs list-tasks` every 5s:

| Time | Event |
|---|---|
| 15:58:10 | task stopped (`stoppedReason: drill`, `stopCode: UserInitiated`) |
| 15:58:10 → 15:59:16 | `list-tasks` returns **no tasks** for the worker service (~66s) |
| 15:59:16 | replacement task visible in `list-tasks` |
| 15:59:41 | replacement starts consuming: `active` jumps 0→5, `waiting` 1932→1888 |
| 16:01:43 | queue fully drained: `waiting: 0, active: 0` |

So: ~66s with zero running workers before ECS's replacement task is even
visible, another ~25s before it's warm enough to pull jobs (Fargate
provisioning + Node boot + Redis connect), then it chews through the
remaining ~1930 jobs at ~16/s (5 concurrency × ~300ms average) — **3m33s**
total from kill to fully drained. `failed` stayed at 0 the whole time: the
jobs that were `active` on the dead task went back to `waiting` via BullMQ's
stalled-job checker and were reprocessed cleanly, not lost. Final state:
`nextagency-demo-worker:3`, desired 1, running 1.

## Drill 3: scale worker to 2 → rate limiter stays global

```bash
aws ecs update-service --cluster nextagency-demo --service worker --desired-count 2
# stable at 16:02:52, two distinct task ARNs confirmed via list-tasks
curl -s -XPOST http://$ALB/api/jobs/seed -d '{"count":20,"queue":"rate-limited-sync"}'
```

`sync.processor.ts` sets `limiter: { max: 5, duration: 10_000 }` — "5 jobs
per 10s **across all worker instances**", per its own comment, because
BullMQ enforces the limiter in Redis, not in-process. With two tasks now
pulling from the same queue, polling `/api/jobs/stats` at t+2s/12s/22s after
a clean seed:

| t | `completed` (cumulative) | delta |
|---|---|---|
| +2s | 25 | +5 (initial burst) |
| +13s | 30 | +5 |
| +23s | 35 | +5 |

Exactly 5 per ~10s window, *total* — not 5 per task (which would have shown
10 per window with two workers racing independently). Scaled back down
immediately after: `desired-count 1`, stable in 2s, final state
`nextagency-demo-worker:3`, desired 1, running 1.

## What this teaches

- The circuit breaker's rollback target is "whatever was `PRIMARY` when this
  deployment started" — not a hardcoded prior version. In a shared
  environment with CI also deploying, that target can shift out from under
  you (Drill 1's baseline note above).
- `aws ecs wait services-stable` confirms the *service* stabilized, not that
  *your* task definition is the one running — always check
  `deployments[0].taskDefinition` after.
- ECS replacing a killed task is not instant: budget ~60-90s of zero
  capacity before a replacement is even pulling work, on top of BullMQ's
  stalled-job recovery making that gap safe rather than lossy.
- Horizontal scaling is just a number to ECS; a rate limiter backed by Redis
  (not process memory) is what keeps a shared external quota (e.g. a
  carrier's sync API) safe under that scaling.
