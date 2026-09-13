# 08 — Deploy script, ECS Exec, and log tailing (part 1)

See also: `06-ecs-fargate-roles-and-tasks.md` (task definitions, `awsvpc`
networking) and `07-alb-routing.md` (how the ALB picks a target). This note
covers `scripts/deploy.sh` and the manual "SSM runbook" drill from a real
run against the live stack; part 2 (GitHub Actions + OIDC) lands in Phase 11.

## `scripts/deploy.sh`

One script, three apps (`api` | `worker` | `web`), same shape every time:

1. Read `terraform output` for the ECR repo URL, cluster name, service name,
   and ALB DNS — never hardcode account/region-specific values in the script.
2. `docker login` to ECR, `docker buildx build --push` a tagged image
   (git short SHA by default, plus `:latest`).
3. `describe-task-definition` the service's *current* task definition,
   `jq` in the new image, strip the fields AWS adds back on read that
   `register-task-definition` rejects, and register a new revision.
4. `update-service` to point at the new revision, then
   `aws ecs wait services-stable`.

### Platform: `linux/amd64`, not `arm64`

The original draft used `--platform linux/arm64`. This stack's ECS tasks
and build host are x86_64 (`runtimePlatform` on the task definitions is the
default `X86_64`), so the script builds `linux/amd64`. Building arm64 here
would produce an image ECS can pull but Fargate would fail to run (or, with
Fargate's platform-implied arch check, the task would fail at launch) —
confirmed indirectly by `process.arch` inside the running container
reporting `x64`, not `arm64` (see Step 3 below).

### `register-task-definition` and stripped fields

`describe-task-definition` returns several fields that are server-assigned
metadata, not valid input to `register-task-definition`:
`taskDefinitionArn`, `revision`, `status`, `requiresAttributes`,
`compatibilities`, `registeredAt`, `registeredBy`. This stack's current
task definitions also came back with an `enableFaultInjection` key (a newer
ECS API field, defaults to `false`, also not accepted as register input),
so the script's `jq del(...)` drops that one too. No other unknown-key
errors were hit in this run — `register-task-definition` succeeded first
try with those seven keys removed.

## Deploy drill: `web` v2

Changed `apps/web/app/page.tsx`'s `<h1>` to
`NextAgency Demo — queue dashboard (v2)`, committed
(`chore(web): v2 heading for deploy drill`), then ran
`AWS_PROFILE=personal scripts/deploy.sh web`.

- Build+push (`docker buildx build --platform linux/amd64`, Next.js
  standalone build inside the image): ~68s.
- New task definition: `nextagency-demo-web:2` (was `:1`).
- Total wall time (login → build → push → register → update-service →
  `services-stable`): **5m 1.9s** (14:48:32 → 14:53:34 local).
- Rolling replacement observed via
  `aws ecs describe-services --query 'services[0].deployments'`: a second
  `PRIMARY` deployment on `:2` came up alongside the draining `:1`
  deployment, then `:1`'s deployment showed `rolloutState: COMPLETED` with
  `desiredCount: 0` once `:2` was healthy — the ECS equivalent of watching
  the console's Deployments tab.
- Verification: `curl -s http://$ALB | grep -o 'dashboard (v2)'` returned
  `dashboard (v2)` (matched twice — once in the `<title>`/meta, once in the
  `<h1>`).

## ECS Exec into `worker`

Session Manager plugin isn't installable via `apt` without sudo on this
host, so it was installed to a user prefix instead:

```bash
cd /tmp && curl -sSLo smp.deb https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb
dpkg-deb -x smp.deb ~/.local/smp
ln -sf ~/.local/smp/usr/local/sessionmanagerplugin/bin/session-manager-plugin ~/.local/bin/session-manager-plugin
```

`aws ecs execute-command` needs a real TTY to be *interactive*, which isn't
available from an automated shell. For a reproducible, non-interactive
proof the same command was run with an explicit `sh -c` one-liner and
`< /dev/null`:

```bash
TASK=$(aws ecs list-tasks --cluster nextagency-demo --service-name worker --query 'taskArns[0]' --output text)
timeout 60 aws ecs execute-command --cluster nextagency-demo --task "$TASK" --container worker --interactive \
  --command "sh -c 'env | grep -c REDIS_URL; node -e \"console.log(process.arch)\"'" < /dev/null
```

Output:

```
1
x64
Cannot perform start session: EOF
```

`1` confirms `REDIS_URL` is injected (as the `rediss://` Secrets Manager
value — `env | grep -c` just counts the match rather than printing the
secret to a transcript). `x64` confirms the running container is x86_64,
consistent with the `--platform linux/amd64` build above (the brief assumed
`arm64`, which doesn't match this stack). The trailing
`Cannot perform start session: EOF` is the Session Manager client's
teardown complaint after its stdin (`/dev/null`) hit EOF mid-session — the
command output above it had already returned correctly, so this is cosmetic
for a non-interactive drive rather than a failure of ECS Exec itself.

## Tailing worker logs while seeding

`aws logs tail --follow`, when its stdout is a **pipe or a redirected
file** rather than a real TTY, buffers its output internally and only
flushes on a clean exit — a `timeout`-delivered `SIGTERM` (or a plain
`kill`) discards whatever hadn't been flushed yet. Three attempts piping
`--follow` straight to a file (via `> file`, via a backgrounded job, and
with `PYTHONUNBUFFERED=1` set) all produced **zero** captured lines despite
`aws logs describe-log-streams` and a plain (non-`--follow`) `tail`
confirming the log events landed in CloudWatch within ~1-2s of the jobs
being enqueued. Wrapping the same command in `script` (which allocates a
pseudo-TTY) fixed it:

```bash
timeout 30 script -qec "aws logs tail /ecs/nextagency-demo/worker --since 1m --follow" /tmp/worker-tail.log >/dev/null 2>&1
```

Sample captured lines (seeded 20 jobs via
`curl -XPOST http://$ALB/api/jobs/seed -d '{"count":20}'` concurrently):

```
{"ts":"2026-09-13T09:59:43.614Z","event":"completed","queue":"renewal-reminders","jobId":"92"}
{"ts":"2026-09-13T09:59:43.977Z","event":"failed","queue":"renewal-reminders","jobId":"96","attemptsMade":1,"error":"simulated failure for pol-6"}
{"ts":"2026-09-13T09:59:45.344Z","event":"completed","queue":"renewal-reminders","jobId":"96"}
{"ts":"2026-09-13T09:59:48.256Z","event":"completed","queue":"renewal-reminders","jobId":"109"}
```

(`jobId":"96"` and `"109"` each appear twice — first `failed`, then
`completed` on retry, matching BullMQ's default retry-with-backoff
behaviour for the seed endpoint's simulated failures.) The background tail
was time-boxed with `timeout` rather than left running, so nothing needed
a manual `kill` afterward.
