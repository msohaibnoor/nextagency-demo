# 02 — BullMQ

BullMQ is a job-queue library backed by Redis. This repo uses it across
`apps/api` (producers + Bull Board admin UI) and `apps/worker` (the
processors), sharing queue names and types from `packages/queue`.

## Queue vs Worker vs QueueEvents vs FlowProducer

Four separate classes, each wrapping its own Redis connection, and nothing
stops them living in different processes:

- **`Queue`** — the producer handle. `apps/api/src/jobs/jobs.service.ts`
  injects one `Queue` per queue name (via `@InjectQueue`) and calls
  `addBulk`/`getJobCounts`/`getJob` on it. It only ever *writes* jobs in
  and *reads* status back; it never runs job code.
- **`Worker`** — the consumer. In this repo it's wrapped by
  `@nestjs/bullmq`'s `WorkerHost` (`apps/worker/src/processors/*.ts`): each
  `@Processor(queueName)` class's `process()` method is what actually runs
  a job. Workers live in `apps/worker` only — the api process never
  processes jobs itself.
- **`QueueEvents`** — a *global*, Redis-stream-backed event listener, not
  used directly in this repo. It subscribes to a queue's event stream and
  fires regardless of which process (or how many worker instances) handled
  the job. What this repo uses instead is `@OnWorkerEvent` (see
  `reminders.processor.ts`, `reports.processor.ts`), which is an
  *in-process* listener on that one `Worker` instance's own events — it
  only sees jobs that specific worker instance handled, has no separate
  Redis subscription cost, but tells you nothing about jobs processed by a
  different worker instance. `QueueEvents` is the right tool if something
  outside the worker process (e.g. api) needs to react to job completion;
  `@OnWorkerEvent` is enough for a worker logging its own activity, which
  is all this repo needs it for.
- **`FlowProducer`** — for adding a *tree* of jobs (parent + children) in
  one atomic call. `jobs.service.ts`'s `report()` uses it to build the
  nested `gather → render → email → report` chain (see Flows, below).

## Job lifecycle

`waiting → active → completed` (or `failed`), with `delayed` as a
side-state a job can sit in before becoming `waiting` again (initial delay,
between retries, or a repeatable job's next scheduled run), and `stalled`
as a recovery state: if a worker takes a job `active` and then dies (crash,
lost connection) without heartbeating, BullMQ notices the missed lock
renewal, marks the job `stalled`, and re-queues it — which is also why job
processors must be safe to run more than once for the same job. A job that
exhausts all its retries ends in `failed`, queried directly from a running
instance in this repo (seeded via `POST /api/jobs/seed {"count":20,"failRate":0.9}`
so some jobs would actually exhaust all 3 attempts):

```
$ curl localhost:4000/api/jobs/renewal-reminders/23
{
    "id": "23",
    "name": "remind",
    "state": "failed",
    "attemptsMade": 3,
    "returnvalue": null,
    "failedReason": "simulated failure for pol-18",
    "data": {
        "policyId": "pol-18",
        "agencyId": "agency-3",
        "renewalDate": "2026-12-01",
        "failRate": 0.9
    }
}
```

## Retries

Set per-job in `jobs.service.ts`'s `seed()`:
`{ attempts: 3, backoff: { type: "exponential", delay: 1000 } }`. Exponential
backoff with `delay: 1000` means each retry waits `1000 * 2^(attemptsMade-1)`
ms after a failure: 1s before attempt 2, 2s before attempt 3. (With
`attempts: 3` there is no attempt 4, so no 4s gap actually occurs — a job
either succeeds within 3 tries or is permanently `failed` after the third.)
Observed directly by seeding a job with `failRate: 1` (guaranteed failure)
and reading the worker's `@OnWorkerEvent("failed")` log timestamps:

```
12:12:48.191Z attemptsMade:1 (initial attempt)
12:12:49.366Z attemptsMade:2 (Δ 1.18s — ~1s backoff + ~100-500ms simulated work)
12:12:51.480Z attemptsMade:3 (Δ 2.11s — ~2s backoff + ~100-500ms simulated work)
```
`GET /api/jobs/renewal-reminders/51` afterward: `{"state":"failed","attemptsMade":3,"failedReason":"simulated failure for pol-1"}`.

One thing this surfaced that's easy to get wrong: `shouldFail()`
(`apps/worker/src/processors/reminders.logic.ts`) re-rolls independently on
*every* attempt, not once per job. So a job seeded with `failRate: 0.2`
isn't 20% likely to end up permanently failed — it's `0.2^3 = 0.8%` likely
(all three independent rolls have to fail). Seeding 50 jobs at
`failRate: 0.2` and waiting for everything to settle produced:

```
$ curl localhost:4000/api/jobs/stats
"renewal-reminders": {"completed": 50, "failed": 0, ...}
```
with an `attemptsMade` histogram over those 50 completed jobs of
`{1: 39, 2: 9, 3: 2}` — i.e. 11 of the 50 needed at least one retry, and
all of them eventually succeeded within the 3-attempt budget. Zero
permanent failures out of 50 is the expected outcome at this fail rate, not
a bug; getting a handful of permanently-failed jobs to look at required
seeding separately with `failRate: 1`.

**Why `maxRetriesPerRequest: null`** (`packages/queue/src/connection.ts`):
this isn't job retries, it's the *ioredis command-level* retry limit. A
BullMQ `Worker` blocks on Redis waiting for the next job — confirmed by
grepping the installed package
(`node_modules/.pnpm/bullmq@5.81.5/node_modules/bullmq/dist/cjs/classes/worker.js`):
it runs `bclient.bzpopmin(this.keys.marker, blockTimeout)`, a blocking
`BZPOPMIN` on the queue's marker key (newer BullMQ moved off Bull v3's
`BRPOPLPUSH`-on-the-job-list design; job data itself now lives outside that
blocking call, with events delivered via Redis Streams). If ioredis were
allowed to give up on that command after N retries, the worker would throw
and lose its blocking connection. BullMQ requires `null` (unlimited) so the
underlying command retries forever instead of erroring out from under the
worker.

## Flows

A flow is a job tree, added by `FlowProducer.add()` with `children`. BullMQ
guarantees **children run before their parent** — a parent job sits in
`waiting-children` state until every child (recursively) has completed,
then automatically moves to `waiting`. `jobs.service.ts`'s `report()` builds
`report → email → render → gather` (each `children` array nests one level
deeper), so `gather` always finishes first and `report` always finishes
last, across four separate `Job` instances that could in principle be
picked up by four different worker processes.

A job accesses its children's results with `job.getChildrenValues()`
(`apps/worker/src/processors/reports.processor.ts`), which returns an
object keyed by the children's `queueName:jobId` and valued by each
child's `returnvalue` — that's how `report`'s summary string gets built
from what `email`/`render`/`gather` each returned.

## Job schedulers

`jobs.service.ts`'s `ensureSweepScheduler()` calls
`sweep.upsertJobScheduler("nightly-sweep", { pattern: "*/5 * * * *" }, ...)`.
This is BullMQ's current API for repeating jobs — it replaces the older
`queue.add(name, data, { repeat: {...} })` pattern, which is deprecated
because it could silently create duplicate repeating jobs if called more
than once with slightly different options. `upsertJobScheduler` is
idempotent by its first argument (the scheduler's id): calling it again
with the same id updates the existing schedule in place instead of adding
a second one.

## Rate limiting is per-queue and enforced in Redis

`apps/worker/src/processors/sync.processor.ts`:
`@Processor(QUEUES.rateLimitedSync, { concurrency: 5, limiter: { max: 5, duration: 10_000 } })`
— at most 5 jobs start per fixed 10-second window (a Redis key with a TTL
that resets after `duration`, not a rolling/sliding window). The limiter's
counter lives in Redis, not in worker process memory, so it's enforced
*across every worker instance consuming that queue* — running two copies
of `apps/worker` doesn't double the effective throughput to 10/10s, Redis
still caps the combined rate at 5/10s.

## Graceful shutdown

`app.enableShutdownHooks()` (`apps/api/src/main.ts`,
`apps/worker/src/main.ts`) wires Nest's shutdown lifecycle to process
signals (SIGTERM); `@nestjs/bullmq` registers a shutdown hook that calls
`worker.close()` on every registered `Worker`. `Worker.close()` stops
pulling *new* jobs immediately but **waits for any job already `active` on
that worker to finish** before resolving — so a SIGTERM (Fargate's normal
stop signal) doesn't kill a job mid-processing, it just stops new work and
lets in-flight work drain. This is also why the api e2e test needs
`forceExit: true` (`apps/api/jest.e2e.config.js`): the BullMQ/ioredis
sockets these hooks manage don't all fully release on `close()` in a test
process the way they do on a real SIGTERM.

## Redis gotchas hit in this repo

- **A hash was the wrong structure for "last N results."**
  `apps/worker/src/results/results.store.ts` originally stored each queue's
  recent results in a Redis hash, trimmed with `HKEYS` order. That's wrong:
  once a hash grows past listpack encoding, `HKEYS` order is no longer
  guaranteed to be insertion order, so "delete the oldest entries" wasn't
  reliable, and a separate `HSET` + `HDEL` pair wasn't atomic either. It's
  now a ZSET (`ZADD` scored by `Date.now()`, trimmed with
  `ZREMRANGEBYRANK key 0 -1001` to keep the most recent 1000), with both
  commands issued in one `multi()` so record-and-trim is a single atomic
  round trip even at worker concurrency 5.
- **`ioredis`'s `multi().exec()` doesn't reject on a per-command error.**
  It resolves to an array of `[err, result]` tuples, one per queued
  command — a `WRONGTYPE` on the `ZADD` doesn't reject the `exec()` promise
  or throw, it just shows up as a non-null `err` in that command's tuple.
  Only a queuing/syntax failure that aborts the whole `MULTI` makes
  `exec()` resolve `null`. `results.store.ts` checks both: it throws if
  `exec()` returns `null` ("MULTI aborted"), and separately walks the
  reply array throwing on the first per-command `err` — otherwise a failed
  `ZADD` would leave a job reported "completed" with nothing actually
  persisted, silently.

## `@nestjs/bullmq` module wiring

`BullModule.forRoot({ connection: ... })` alone is **not** enough to make
`@Processor` classes run. `apps/worker/src/worker.module.ts` also needs
`BullModule.registerQueue(...)` for every queue name — that call is what
pulls in `@nestjs/bullmq`'s discovery module, which scans providers for
`@Processor`-decorated classes and turns them into live BullMQ `Worker`
instances. Without `registerQueue`, the app starts and logs cleanly with no
error, but no `@Processor` ever consumes a job — a genuinely confusing
failure mode with no exception to point at it.

## How this maps to Sidekiq

| BullMQ | Sidekiq |
|---|---|
| A queue (`QUEUES.renewalReminders`, etc.) | A Sidekiq queue |
| A `@Processor` class (`RemindersProcessor`) | A worker class (`include Sidekiq::Worker`) |
| `upsertJobScheduler` | `sidekiq-scheduler` / `sidekiq-cron` |
| Bull Board (`/api/admin/queues`) | Sidekiq Web |
| `attempts` + `backoff` | Sidekiq's retry count + its own backoff curve |
| `FlowProducer` (parent/children) | No first-class equivalent — usually hand-rolled with `Sidekiq::Batch` (Pro) or a manual counter |
