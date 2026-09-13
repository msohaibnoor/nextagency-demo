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
`infra/production/compute.tf`'s `aws_ecs_service.app` sets, verbatim:
`deployment_circuit_breaker { enable = true, rollback = true }`,
`deployment_minimum_healthy_percent = 100`, `deployment_maximum_percent = 200`,
and (for `api`/`web`, not `worker`) `health_check_grace_period_seconds = 60`.
The ALB target group's health check is `interval 15s`, `unhealthy_threshold 3`
(45s of failing checks to condemn a task), `healthy_threshold 2`,
`deregistration_delay 10`. ECS then cycled through **three** replacement
tasks, each rejected by that health check, before the circuit breaker gave
up:

```
(task c9beb1b8…) (port 4000) is unhealthy … Health checks failed with these codes: [500]
(task fe8a0562…) (port 4000) is unhealthy … Health checks failed with these codes: [500]
(task fb1a36d8…) (port 4000) is unhealthy … Health checks failed with these codes: [500]
(service api) (deployment ecs-svc/3468368874827011691) deployment failed: tasks failed to start.
(service api) rolling back to deployment ecs-svc/4744463545704487209.
```

Timeline (from the `describe-services` snapshots polled every ~20s during
the drill; see the report's evidence appendix for the raw lines): first
snapshot showing the `:4` deployment already `IN_PROGRESS` 15:46:01 → task 1
(`c9beb1b8…`) first shown unhealthy 15:47:52 → task 2 (`fe8a0562…`) 15:51:39
→ task 3 (`fb1a36d8…`) 15:55:04 → circuit breaker fires ("deployment failed:
tasks failed to start" / "rolling back to deployment …") 15:55:49 →
rollback `rolloutState: COMPLETED` on `api:3` at 15:56:13. **≈10 minutes**
(15:46:01 → 15:56:13, ~10m12s between the two evidenced endpoints) end to
end — longer than "3 × 45s" because each of the three attempts also carries
the 60s `health_check_grace_period_seconds` (ECS won't act on a failing
health check until a newly-started task clears its grace window) plus
Fargate provisioning/relaunch time on top of the 45s ALB threshold itself.

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
| 15:58:25 → 15:59:09 | every `list-tasks` poll in this window returns **no tasks** for the worker service (first poll 15s after the stop; last empty poll 15:59:09) |
| 15:59:16 | replacement task visible in `list-tasks` |
| 15:59:41 | replacement starts consuming: `active` jumps 0→5, `waiting` 1932→1888 |
| 16:01:43 | queue fully drained: `waiting: 0, active: 0` |

So: at least ~51s (15:58:25→15:59:16, the observed empty window) and up to
~66s counting from the stop itself (15:58:10→15:59:16) with zero running
workers before ECS's replacement task is even visible, another ~25s before
it's warm enough to pull jobs (Fargate provisioning + Node boot + Redis
connect), then it chews through the remaining ~1930 jobs at ~16/s (5
concurrency × ~300ms average, from the `waiting` deltas in the poll log) —
**3m33s** total from kill (15:58:10) to fully drained (16:01:43). `failed`
stayed at 0 the whole time and nothing was lost. Final state:
`nextagency-demo-worker:3`, desired 1, running 1.

### What actually happened to the in-flight jobs (not stalled recovery)

An earlier draft of this note credited BullMQ's stalled-job checker with
rescuing the five `active` jobs. That is not what `stop-task` exercises.
The mechanism was a **graceful drain**:

1. `aws ecs stop-task` makes ECS send `SIGTERM` to PID 1 (`node
   apps/worker/dist/main.js`) and start the container's `stopTimeout` clock
   (60 s for `worker`, `compute.tf`).
2. `main.ts` calls `app.enableShutdownHooks()`, so Nest turns the signal
   into `onApplicationShutdown` across its providers.
3. `@nestjs/bullmq` closes each `@Processor` via `Worker.close()`, which
   stops fetching and **waits for the jobs currently in `process()`** —
   ≤500 ms each for reminders — before resolving. `RedisClient` closes the
   plain ioredis connection the same way.
4. The process exits 0 well inside the 60 s; the five `active` jobs had
   already completed and been acknowledged, so there was nothing for the
   stalled checker to find.

No `stalled` events appeared in the worker log for this run, and none were
expected. Stalled recovery only fires when a job's lock in Redis expires
without the worker renewing it (default `lockDuration` 30 s, checked every
`stalledInterval` 30 s) — i.e. when the process dies *without* running
`Worker.close()`.

### Exercise: force a real stalled recovery

Two ways to remove the graceful path so the jobs really are abandoned
mid-flight:

- **Kill PID 1 hard** — `SIGKILL` bypasses the Nest hooks entirely:

  ```bash
  TASK=$(aws ecs list-tasks --cluster nextagency-demo --service-name worker --query 'taskArns[0]' --output text)
  curl -s -XPOST http://$ALB/api/jobs/seed -d '{"count":2000,"failRate":0}'
  aws ecs execute-command --cluster nextagency-demo --task "$TASK" --container worker \
    --interactive --command "kill -9 1"
  ```

- **Shrink the grace window** — set `stop_timeout = 2` for `worker` in
  `compute.tf`, apply, redeploy, and use `stop-task` as above with a
  processor that sleeps longer than 2 s; ECS kills the container before
  `Worker.close()` finishes.

What to look for: the seeded `active` count stays at 5 for up to ~30 s
after the kill while the replacement task boots (the locks are still held
by a dead process), then the replacement's stalled checker moves them back
to `waiting` and the worker log shows `{"event":"stalled",…}` lines if a
`@OnWorkerEvent("stalled")` handler is added (none of the processors log
it today), followed by a second `completed` for the same `jobId`. A job that stalls
more than `maxStalledCount` times (default 1) is moved to `failed` instead
of being retried, so repeating the kill quickly on the same batch will
also show a non-zero `failed` count.

## Drill 3: scale worker to 2 → rate limiter stays global

```bash
aws ecs update-service --cluster nextagency-demo --service worker --desired-count 2
# stable at 16:02:52, two distinct task ARNs confirmed via list-tasks
curl -s -XPOST http://$ALB/api/jobs/seed -d '{"count":20,"queue":"rate-limited-sync"}'
```

`sync.processor.ts` sets `limiter: { max: 5, duration: 10_000 }` — "5 jobs
per 10s **across all worker instances**", per its own comment, because
BullMQ enforces the limiter in Redis, not in-process. With two tasks now
pulling from the same queue, a seed was fired and `/api/jobs/stats` polled
with a script that requested polls at t+2s/12s/22s; actual elapsed time by
the point each poll's `curl` returned was t+2s/13s/23s (one second of drift
from the script's own `curl`/`jq` overhead each iteration):

| requested t | actual elapsed | wall clock | `completed` (cumulative) | delta |
|---|---|---|---|---|
| +2s | 2s | 16:04:16 | 25 | +5 (initial burst) |
| +12s | 13s | 16:04:26 | 30 | +5 |
| +22s | 23s | 16:04:36 | 35 | +5 |

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
- ECS replacing a killed task is not instant: this run measured 91s
  (15:58:10→15:59:41) of zero active workers before the replacement task was
  pulling jobs. The gap was lossless because `stop-task` is a *graceful*
  stop — SIGTERM, Nest shutdown hooks, `Worker.close()` — not because of
  stalled-job recovery, which this drill never triggered.
- Horizontal scaling is just a number to ECS; a rate limiter backed by Redis
  (not process memory) is what keeps a shared external quota (e.g. a
  carrier's sync API) safe under that scaling.
