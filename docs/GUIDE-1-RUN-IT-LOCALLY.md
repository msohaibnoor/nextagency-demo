# Guide 1 — Run everything locally, by hand, and watch BullMQ work

This is a do-it-yourself walkthrough. Nothing here needs AWS. You'll start Redis, the API, the
worker and the web app one at a time in separate terminals, so you can *see* which process does
what. Then you'll push jobs through every queue and watch them move.

Budget an hour. Keep this file open in one window and a terminal grid (4 panes) in another.

Companion reading, when a section says so: `docs/02-bullmq.md` (concepts), `docs/01-turborepo.md`
(the build tool), `docs/03-docker-monorepo.md` (images).

---

## 0. The shape of the thing (2 minutes)

```
apps/web  (Next.js, :3000)  ── browser calls /api/* ──▶  apps/api (NestJS, :4000)
                                                             │  adds jobs to queues
                                                             ▼
                                                        Redis (:6379)   ◀── apps/worker (NestJS, no port)
                                                                             pulls jobs, runs them,
                                                                             writes results
```

Three processes, one Redis. The api never runs a job; the worker never serves HTTP. Everything
they share — queue names, job payload shapes, how to connect to Redis — lives in one package,
`packages/queue`, so they can't drift apart.

| Folder | What it is | Entry point |
|---|---|---|
| `packages/queue` | The contract: `QUEUES` names, TypeScript types for each job, `redisConnectionOptions()` | `src/index.ts` |
| `apps/api` | HTTP + **producers** (they *add* jobs) + Bull Board UI | `src/main.ts` |
| `apps/worker` | **Consumers** (they *process* jobs) | `src/main.ts` |
| `apps/web` | One-page dashboard | `app/page.tsx` |
| `scripts/seed-queue.ts` | A producer you run from the terminal | — |

---

## 1. Start Redis (terminal 1)

```bash
cd ~/nextagency-demo
pnpm redis            # = docker compose -f docker/docker-compose.yml up -d redis
docker ps --filter name=redis --format '{{.Names}} {{.Status}}'
```
You should see `docker-redis-1 Up …`. Redis is now on `localhost:6379`.

Open a Redis shell you'll keep for the whole session — this is your X-ray into what BullMQ stores:
```bash
docker exec -it docker-redis-1 redis-cli
```
Try `KEYS *`. Empty, or leftovers from earlier runs. Leave this open; we'll come back to it.

> **What's Redis doing here?** BullMQ has no server of its own. A "queue" is just a set of Redis
> keys with an agreed naming scheme (`bull:<queue>:…`), and the *worker* is any process that runs
> BullMQ's Lua scripts against those keys. Redis is the only shared state.

---

## 2. Start the API (terminal 2)

```bash
cd ~/nextagency-demo/apps/api
cat .env              # PORT=4000, REDIS_URL=redis://localhost:6379  (loaded by dotenv in main.ts)
pnpm dev              # = nest start --watch
```
Wait for `{"msg":"api listening","port":4000}`. Now check it from terminal 3:

```bash
curl -s localhost:4000/api/health          # {"ok":true,"redis":"up"}
curl -s localhost:4000/api/jobs/stats | jq
```
Read the stats output slowly. Four queues, each with counts. Notice `nightly-sweep` already has
`delayed: 1` — you never added anything. **That's the job scheduler**: when the api booted,
`JobsModule.onModuleInit()` ran `ensureSweepScheduler()`, which told Redis "produce a `sweep` job
every 5 minutes" (`apps/api/src/jobs/jobs.service.ts`, `upsertJobScheduler`). The next one is
sitting in `delayed` until its cron time.

Back in the Redis shell:
```
KEYS bull:nightly-sweep:*
```
You'll see the scheduler's keys (`…:repeat`, `…:delayed`, a job hash). That's the whole mechanism.

Open **Bull Board**: http://localhost:4000/api/admin/queues — four queues, live counts, and you
can click into any job. Keep this tab open; it's the best BullMQ teacher there is.

---

## 3. Produce jobs *without* a worker (terminal 3)

The point of this step: see jobs pile up when nobody consumes them.

```bash
curl -s -XPOST localhost:4000/api/jobs/seed -H 'content-type: application/json' -d '{"count":5}' | jq
```
Response: `{ "enqueued": 5, "ids": ["1","2",…] }`. Now:

```bash
curl -s localhost:4000/api/jobs/stats | jq '.["renewal-reminders"]'
```
`waiting: 5`. Nothing is processing them. In Bull Board, click **renewal-reminders → Waiting** and
open one job — you'll see its `data` (`policyId`, `agencyId`, `renewalDate`, `failRate`) and its
`opts` (`attempts: 3`, `backoff: exponential 1000`, `removeOnComplete: 100`, `removeOnFail: 500`).
Those opts came from `JobsService.seed()`.

Redis shell:
```
LRANGE bull:renewal-reminders:wait 0 -1      # the 5 job ids, in order
HGETALL bull:renewal-reminders:1             # one job's hash: name, data, opts, timestamp…
```
A queue's "waiting" list is literally a Redis list. Now you know what `waiting: 5` means.

---

## 4. Start the worker and watch them drain (terminal 4)

```bash
cd ~/nextagency-demo/apps/worker
pnpm dev
```
Watch terminal 4. Within a second or two you'll see JSON lines like:
```
{"ts":"…","event":"completed","queue":"renewal-reminders","jobId":"3"}
{"ts":"…","event":"failed","queue":"renewal-reminders","jobId":"2","attemptsMade":1,"error":"simulated failure for pol-2"}
```
Each line is an `@OnWorkerEvent` handler in `apps/worker/src/processors/reminders.processor.ts`.
The `failed` lines are the seeded 20 % failure rate (`failRate: 0.2` default) — and note
`attemptsMade: 1`: that job is *not* dead, it's been rescheduled.

Re-run the stats:
```bash
curl -s localhost:4000/api/jobs/stats | jq '.["renewal-reminders"]'
```
`completed` went up; if a job failed you'll briefly see `delayed: 1` — that's the **backoff**: it
waits 1 s, then 2 s, then 4 s between attempts. Watch Bull Board's **Delayed** tab; the job reappears
in Active, then Completed (or Failed after the 3rd attempt).

> Why do almost none end up permanently failed? Each attempt re-rolls the 20 % dice, so the chance
> of failing three times in a row is 0.2³ ≈ 0.8 %. Seed with `"failRate":0.9` if you want to see
> the Failed tab fill up: `-d '{"count":20,"failRate":0.9}'`.

Now look at what the worker *wrote*:
```
ZRANGE results:renewal-reminders 0 -1 WITHSCORES
ZCARD results:renewal-reminders
```
`ResultsStore.record()` (`apps/worker/src/results/results.store.ts`) puts one JSON entry per
completed job into a **sorted set** scored by timestamp and trims it to the newest 1,000 — all in one
`MULTI` so five concurrent jobs can't race each other. (Read the comment in that file: it explains
why a hash was the wrong choice.)

---

## 5. Concurrency — see 5 jobs run at once

`RemindersProcessor` is declared `@Processor(QUEUES.renewalReminders, { concurrency: 5 })` and each
job sleeps 100–500 ms. So 50 jobs should take ~3 s, not ~15 s.

```bash
curl -s -XPOST localhost:4000/api/jobs/seed -H 'content-type: application/json' -d '{"count":50,"failRate":0}' >/dev/null
for i in 1 2 3 4 5 6; do curl -s localhost:4000/api/jobs/stats | jq -c '.["renewal-reminders"] | {active,waiting,completed}'; sleep 0.5; done
```
`active` hovers at 5 while `waiting` drops. Change `concurrency: 5` → `1` in the processor, save
(nest `--watch` restarts the worker), seed 50 again, and watch `active` stay at 1. Put it back.

---

## 6. The seed script — a producer with no HTTP at all

```bash
cd ~/nextagency-demo
REDIS_URL=redis://localhost:6379 pnpm --filter scripts seed -- --count 10 --fail-rate 0.5
```
(The script has no `.env` loading, unlike the apps — hence the inline variable.)
`scripts/seed-queue.ts` creates a `new Queue("renewal-reminders", { connection })` and calls
`addBulk`. That's all a producer is: any process, anywhere, that knows the queue name and can reach
Redis. The api does the same thing behind `POST /api/jobs/seed`; there's nothing special about it.

---

## 7. Flows — one job that waits for its children

```bash
curl -s -XPOST localhost:4000/api/jobs/report -H 'content-type: application/json' -d '{"agencyId":"agency-9","month":"2026-09"}'
```
You get `{ "parentId": "…" }`. Now in Bull Board open **reports**. Within ~1.5 s four jobs complete in
this order: `gather` → `render` → `email` → `report`. Fetch the parent:

```bash
curl -s localhost:4000/api/jobs/reports/<parentId> | jq
```
`returnvalue` is `report for agency-9/2026-09 done: emailed [rendered PDF from [gathered 12 policies]]`.
Each step's output was fed into the next via `job.getChildrenValues()`
(`apps/worker/src/processors/reports.processor.ts`).

How it's built (`JobsService.report()`): a `FlowProducer.add()` with the tree
`report → email → render → gather`. BullMQ runs the *deepest* child first and only moves a parent to
`waiting` once all its children have completed. Seed it 5 times and watch `waiting-children` in the
stats — that state exists only for flows.

Redis shell: `KEYS bull:reports:*` — notice the `…:dependencies` and `…:processed` keys on the
parent job; that's how BullMQ tracks "which children are done".

---

## 8. Rate limiting — throttle a queue globally

```bash
curl -s -XPOST localhost:4000/api/jobs/seed -H 'content-type: application/json' -d '{"count":12,"queue":"rate-limited-sync"}' >/dev/null
for i in $(seq 1 12); do date +%T; curl -s localhost:4000/api/jobs/stats | jq -c '.["rate-limited-sync"] | {completed,waiting}'; sleep 2; done
```
`completed` goes 5 → 5 → 5 → 10 → 10 → 10 → 12. `SyncProcessor` has
`limiter: { max: 5, duration: 10_000 }`. The counter lives in Redis
(`KEYS bull:rate-limited-sync:limiter`), which is why in Phase 12 two worker tasks on AWS still
shared one limit — start a **second** worker locally (`pnpm dev` in another terminal from
`apps/worker`), seed 12 again, and you'll still see 5 per 10 s in total.

---

## 9. The scheduler fires

Wait for a 5-minute boundary (xx:00, xx:05 …). Terminal 4 prints
`{"event":"sweep","jobId":"repeat:…","resultCounts":{…}}` — `SweepProcessor` counting the results
sorted sets. In Bull Board, **nightly-sweep** shows one completed and a fresh `delayed` one already
queued for the next slot. You never re-add it: `upsertJobScheduler` is idempotent by its id
(`"nightly-sweep"`), which is why restarting the api doesn't create duplicates. Restart the api
(Ctrl-C, `pnpm dev`) and check — still exactly one scheduler.

---

## 10. Kill the worker mid-batch

```bash
curl -s -XPOST localhost:4000/api/jobs/seed -H 'content-type: application/json' -d '{"count":200,"failRate":0}' >/dev/null
```
Immediately press **Ctrl-C** in terminal 4. Look at what it prints before exiting: Nest runs its
shutdown hooks, `@nestjs/bullmq` calls `Worker.close()`, which **waits for the ≤ 5 active jobs to
finish** and then stops taking new ones. That's graceful shutdown — nothing was lost, the rest sit
in `waiting`. Start the worker again; it drains them.

To see the *ungraceful* path — what BullMQ does when a worker vanishes without closing — run the
worker **without** the watcher (the watcher would restart it too fast to see anything):
```bash
cd ~/nextagency-demo/apps/worker && pnpm build && node dist/main.js &   # note the PID it prints
curl -s -XPOST localhost:4000/api/jobs/seed -H 'content-type: application/json' -d '{"count":200,"failRate":0}' >/dev/null
sleep 1; kill -9 %1                                                     # SIGKILL: no shutdown hooks run
curl -s localhost:4000/api/jobs/stats | jq '.["renewal-reminders"] | {active,waiting}'
```
`active` is stuck at 5: those jobs were mid-flight and nobody told Redis. Start the worker again
(`pnpm dev`) and watch for ~30 s: BullMQ's **stalled-job check** notices their lock expired and
re-queues them (Bull Board shows `stalled` in those jobs' logs). This is the mechanism that makes
"just kill the container" safe on ECS — and it's the one Phase 12's drill 2 did *not* exercise,
because ECS sends SIGTERM first (see `docs/09-failure-drills.md`).

---

## 11. The web app (terminal 5)

```bash
cd ~/nextagency-demo/apps/web
pnpm dev              # next dev on :3000
```
http://localhost:3000 — the table is `GET /api/jobs/stats` rendered by a **server component**
(`app/page.tsx`, `export const dynamic = "force-dynamic"` so it re-fetches every request). The
buttons (`app/actions.tsx`, `"use client"`) POST to `/api/jobs/seed` and `/api/jobs/report` then
`router.refresh()`.

Two things to notice:
- The browser calls `/api/jobs/seed` on **:3000**, not :4000. In dev, `next.config.js`'s `rewrites()`
  proxies `/api/*` to `API_URL`. On AWS the ALB does that routing before Next ever sees it.
- Stop the api (Ctrl-C in terminal 2) and reload :3000 — you get the `app/error.tsx` boundary
  ("API unreachable", with a Retry button) instead of a crash. Start the api again, click Retry.

---

## 12. Run the whole thing as containers (the way Fargate runs it)

Stop terminals 2, 4 and 5 (Ctrl-C each; leave Redis). Then:
```bash
cd ~/nextagency-demo
docker compose -f docker/docker-compose.yml --profile full up --build
```
First build takes a few minutes. Then :3000 and :4000 work exactly as before, but each app is now
the image ECS will run. `docker compose ps` shows `api` as `healthy` — that's the `HEALTHCHECK` in
`docker/Dockerfile.api` hitting `/api/health`. Ctrl-C, then
`docker compose -f docker/docker-compose.yml --profile full down`.

What's in an image: read `docs/03-docker-monorepo.md`. The one idea worth keeping: `turbo prune
worker --docker` produces a copy of the monorepo containing *only* what the worker needs, so its
image never installs Next.js.

---

## 13. Tests — what they prove

```bash
cd ~/nextagency-demo
pnpm turbo run build              # second run prints FULL TURBO (nothing changed → cache hit)
pnpm --filter @demo/queue test    # REDIS_URL parsing
pnpm --filter api test            # controller input bounds, service producers (mocked queues), health timeout
pnpm --filter worker test         # pure logic (shouldFail, composeStep) + ResultsStore with a mocked Redis
pnpm --filter api test:e2e        # boots api + worker against real Redis, seeds 5, polls until completed === 5
```
The e2e test is the one that matters: it's the whole pipeline in ~8 s.

---

## 14. Clean up

```bash
pnpm redis:down                   # stops and removes the Redis container (data gone)
```

## What you should now be able to explain

- Where a queue lives (Redis keys), what `waiting / active / delayed / completed / failed /
  waiting-children` mean, and which process moves a job between them.
- Producer vs consumer, and why `packages/queue` exists.
- `attempts` + `backoff`, and why the failure rate you seed isn't the failure rate you observe.
- `concurrency` (per worker process) vs `limiter` (global, in Redis).
- Flows: children first, parent last, `getChildrenValues()`.
- Job schedulers: idempotent by id, survive restarts.
- Graceful shutdown (`Worker.close()` waits) vs stalled recovery (lock expiry, ~30 s).
- Why the web app's `/api/*` calls work in dev (Next rewrite) and on AWS (ALB rule).

If any of those is still fuzzy, go back to that section and change one number in the code, then
watch what happens. That's the fastest way to make it stick.
