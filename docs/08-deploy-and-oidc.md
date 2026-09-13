# 08 — Deploy script, ECS Exec, and log tailing (part 1)

See also: `06-ecs-fargate-roles-and-tasks.md` (task definitions, `awsvpc`
networking) and `07-alb-routing.md` (how the ALB picks a target). This note
covers `scripts/deploy.sh` and the manual "SSM runbook" drill from a real
run against the live stack; part 2 (GitHub Actions + OIDC) lands in Phase 11.

## `scripts/deploy.sh`

One script, three apps (`api` | `worker` | `web`), same shape every time:

1. Derive the ECR repo URL, cluster name, service name and ALB DNS from
   `aws sts get-caller-identity` (account id), the stack's fixed names
   (`nextagency-demo`, `nextagency-demo/<app>`) and
   `aws elbv2 describe-load-balancers --names nextagency-demo`. An earlier
   version ran `terraform output` here; that was removed in the final wave
   because it forced the CI role to read Terraform state (see part 2).
2. `docker login` to ECR, `docker buildx build --push` a tagged image
   (git short SHA by default, plus `:latest`).
3. `describe-task-definition` the service's *current* task definition,
   `jq` in the new image, strip the fields AWS adds back on read that
   `register-task-definition` rejects, and register a new revision.
4. `update-service` to point at the new revision, then
   `aws ecs wait services-stable`, then confirm the `PRIMARY` deployment is
   the new revision with `rolloutState == COMPLETED` — `services-stable`
   also returns 0 after a circuit-breaker rollback (Drill 1 in `docs/09`
   caught this), so the script now prints the last five service events and
   exits 1 in that case.

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

# 08 — GitHub Actions deploy via OIDC (part 2)

See also `docs/AWS-ECS-FARGATE-GUIDE.md` §7, which covers the same flow at a
more introductory level; this note has the actual incident and the
`cicd.tf` policy as it now stands.

## The four deploy steps, as AWS/registry API calls

`.github/workflows/deploy.yml` runs `scripts/deploy.sh <app> <sha>` once per
matrix leg (`api`, `worker`, `web`). There is no Terraform in the job any
more — the workflow is checkout → buildx → OIDC credentials → `deploy.sh`.
The script starts with two cheap reads (`sts:GetCallerIdentity` for the
account id, `elasticloadbalancing:DescribeLoadBalancers` for the ALB DNS
name it prints at the end) and then makes four calls in sequence:

1. **`ecr:GetAuthorizationToken`** — `aws ecr get-login-password`, piped into
   `docker login`. Gets a 12-hour bearer token for the account's ECR
   registry; not scoped to one repo.
2. **`ecr:InitiateLayerUpload` / `UploadLayerPart` / `CompleteLayerUpload` /
   `PutImage`** (plus `BatchCheckLayerAvailability` to skip layers ECR
   already has) — `docker buildx build --push`. These are the calls the
   Docker client makes under the hood when pushing; `ecr:BatchGetImage` and
   `GetDownloadUrlForLayer` cover a `docker pull` if one were needed.
3. **`ecs:DescribeTaskDefinition`** then **`ecs:RegisterTaskDefinition`** —
   read the service's current task definition JSON, patch
   `containerDefinitions[0].image` to the new tag, strip the
   server-assigned fields (`taskDefinitionArn`, `revision`, `status`, …),
   and register the result as a new revision (`:1` → `:2` → …).
4. **`ecs:UpdateService`** (point the service at the new revision) then
   **`ecs:DescribeServices`**, polled by `aws ecs wait services-stable`
   until the rolling deployment reports `COMPLETED`.

## Why a new revision, not `--force-new-deployment` on `:latest`

`--force-new-deployment` against a service whose task definition always
says `image: ...:latest` would restart tasks that then pull whatever
`:latest` happens to point to *at restart time* — not necessarily what you
just built, and not something ECS records anywhere. Registering a new
task-definition revision instead buys two things `:latest` cannot:

- **Traceability** — `nextagency-demo-api:7`'s `containerDefinitions[0].image`
  is a fixed, immutable string (`...api:f65d2f7`) baked into that revision
  forever. `aws ecs describe-task-definition --task-definition
  nextagency-demo-api:7` always answers "what was actually running", no
  guessing from image tag history.
- **Rollback** — reverting is re-pointing the service at an older revision,
  no rebuild, no re-push, no image-tag archaeology:

  ```bash
  aws ecs update-service --cluster nextagency-demo --service api \
    --task-definition nextagency-demo-api:1
  ```

  ECS then rolls the service back to whatever revision `:1` pinned, the
  same way it rolls forward — one task starts healthy, the other drains.

## The OIDC flow, in six steps

1. A push to `main` starts the workflow. `permissions: id-token: write` in
   `deploy.yml` lets the job ask GitHub's OIDC provider for a token.
2. `aws-actions/configure-aws-credentials` requests that token: GitHub's
   backend mints a short-lived, signed **JWT** whose `aud` claim is
   `sts.amazonaws.com` and whose `sub` claim identifies the exact
   repo/branch that triggered the run.
3. The action calls **`sts:AssumeRoleWithWebIdentity`** with that JWT and
   the role ARN from the `AWS_DEPLOY_ROLE_ARN` repo secret (the ARN itself
   isn't sensitive — it's a non-secret identifier, not a credential — but a
   secret keeps it out of the workflow file so it isn't hardcoded per-repo).
4. AWS's STS validates the JWT's signature against the OIDC provider
   registered in Phase 8 (`token.actions.githubusercontent.com`), then
   evaluates the role's **trust policy**: does `aud` equal
   `sts.amazonaws.com` (`StringEquals`), and does `sub` match one of the
   allowed patterns (`StringLike`)?
5. If both match, STS returns temporary credentials (1-hour session) scoped
   to that role's permissions — no long-lived AWS access key ever exists in
   GitHub.
6. The job exports those credentials as env vars for the rest of the steps;
   `scripts/deploy.sh` runs exactly as it does by hand, just with a session
   token instead of `--profile personal`.

## The real incident: `sub` didn't match

The first push (commit before the OIDC fix) failed all three matrix jobs
with:

```
Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity
```

That message is deliberately vague — AWS doesn't tell a caller *why* an
`AssumeRole*` call was denied, since the reason (an unmatched trust-policy
condition) is itself sensitive: an attacker probing a role shouldn't learn
which condition it's failing. So the Actions log alone was a dead end. The
fix required going to the source of truth for what STS actually saw:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity
```

The event's request parameters showed the JWT's real `sub`:

```
repo:msohaibnoor@73883272/nextagency-demo@1367206627:ref:refs/heads/main
```

— not the `repo:msohaibnoor/nextagency-demo:ref:refs/heads/main` the trust
policy's `StringLike` condition expected. GitHub changed its OIDC token
format at some point in 2026 to embed the numeric owner id and repository
id alongside their names (`owner@id/repo@id`), and the trust policy
predated that change.

**First fix (superseded)**: `StringLike` accepts a *list* of patterns,
evaluated as OR, so the trust policy briefly allowed the classic form plus
`repo:owner@*/name@*:ref:…`. That unblocked CI, but the final review pointed
out that it is *not* stronger than the name-only form: IAM's `*` matches
anything in that segment, so `owner@*` is exactly as strict as `owner` — the
ids were being ignored.

**Current form** (`infra/production/cicd.tf`): the two numeric ids from the
CloudTrail event are pinned via variables, with the classic form kept as
the second entry:

```hcl
variable "github_owner_id" { default = "73883272" }
variable "github_repo_id"  { default = "1367206627" }

locals {
  github_subs = [
    "repo:${local.github_owner}@${var.github_owner_id}/${local.github_name}@${var.github_repo_id}:ref:refs/heads/${var.github_branch}",
    "repo:${var.github_repo}:ref:refs/heads/${var.github_branch}",
  ]
}
```

**Why pinning the ids is what adds strength**: repo and org names can be
renamed and later re-registered by a different entity; the numeric ids are
permanent. A `sub` that carries `owner@73883272/name@1367206627` can only
have been minted for *this* repository, whatever it is called by then. The
classic entry remains only for a token minted in the old shape.

## Why `sub` is pinned to `main`

The `StringLike` patterns end in `:ref:refs/heads/main`, not a wildcard
branch. Any workflow run from a fork, a feature branch, or a PR mints a
JWT with a different `sub` and is refused by the trust policy before it
ever reaches an IAM permission check. This is the actual security boundary
of the whole setup: the *role's permissions* (below) bound what a
successful assumption can do, but the *trust policy* bounds who can assume
it at all — only code that has been merged (or pushed directly, since
there's no branch protection here) to `main` in this exact repo.

## Least-privilege list of the `github-deploy` role

From `infra/production/cicd.tf`'s `aws_iam_role_policy.github_deploy`:

| Actions | Resource | Why |
|---|---|---|
| `ecr:GetAuthorizationToken` | `*` (required by the API) | Docker login to the registry |
| `ecr:BatchCheckLayerAvailability`, `CompleteLayerUpload`, `InitiateLayerUpload`, `PutImage`, `UploadLayerPart`, `BatchGetImage`, `GetDownloadUrlForLayer` | the 3 app ECR repos | Push (and, if needed, pull) images |
| `ecs:UpdateService`, `ecs:DescribeServices` | the 3 app services | Roll a new revision out, wait for stability |
| `ecs:DescribeTaskDefinition`, `ecs:RegisterTaskDefinition` | `*` (ECS doesn't support resource-level scoping here) | Read the current task def, register the patched one |
| `iam:PassRole` | the execution role + task role ARNs, with `iam:PassedToService = ecs-tasks.amazonaws.com` | Let ECS (and only ECS) launch tasks with those two roles |
| `elasticloadbalancing:DescribeLoadBalancers` | `*` (no resource-level scoping for Describe) | `deploy.sh` looks up the ALB DNS name for its final line |

`sts:GetCallerIdentity` is also called (for the account id) but needs no
policy — it is always allowed.

### The state-read episode, and what the role really cannot do

This table used to have two more rows. `deploy.sh` originally ran
`terraform output` to look up the ECR/cluster/service/ALB values, which
made the CI role need `s3:GetObject`/`ListBucket`/`GetBucketVersioning` on
the state bucket and `dynamodb:GetItem`/`PutItem`/`DeleteItem` on the lock
table. The first CI run then failed inside `terraform init` because the S3
backend also calls `dynamodb:DescribeTable` to validate the lock table's
schema before it will use it, so that action was granted too. The lesson
came at the final review: a Terraform state file holds every attribute of
every resource in plaintext, including `random_password.redis_auth` and the
`rediss://:<token>@…` secret version — so "read state" *is* "read the
Redis credential". We granted, then realised what state contains, then
removed the grant; the script now derives those values without Terraform,
and the workflow no longer installs it.

Even without the state grant, the honest statement is narrower than "cannot
read the Redis secret". The role cannot call `secretsmanager:GetSecretValue`
directly, but `RegisterTaskDefinition` + `PassRole` + `UpdateService` lets a
workflow run register a task definition with arbitrary image and command,
and ECS injects `REDIS_URL` into that container from Secrets Manager. Any
code that can deploy can read whatever the deployed task is given. The
PassRole condition and the fixed execution/task roles bound *which* roles
that code runs as; the trust policy above (only `main` of this exact repo)
is the real boundary on *who* can deploy. What the role genuinely cannot
do is change the shape of the stack: no VPC, ALB, security-group, IAM or
ElastiCache permissions, and no Terraform state to read or lock.

## `ignore_changes = [task_definition]`

`infra/production/compute.tf`'s `aws_ecs_service.app` resources carry:

```hcl
lifecycle { ignore_changes = [task_definition] }
```

Without this, every `terraform plan` after a CI deploy would see the live
service pointed at `nextagency-demo-api:7` while Terraform's own state
still remembers `:1` (the revision from the last `terraform apply`) — and
would plan to "fix" that drift by rolling the service back to whatever
image `terraform apply` last built, undoing every deploy CI has done
since. `ignore_changes = [task_definition]` tells Terraform "this
attribute is legitimately owned by someone else (CI) after creation" —
Terraform still creates the field on `apply` (the initial task definition
in state), but never again treats a difference there as drift to correct.
This is what stops Terraform and CI from fighting over the same field.

## Observed timeline (the fixed run)

| Time | Event |
|---|---|
| ~15:26 | Push to `main` (commit with the trust-policy fix) |
| 15:29:52 | ECS shows `api:2`, `worker:2`, `web:3` all `IN_PROGRESS` |
| 15:32:14 | `api` deployment `COMPLETED` |
| 15:32:53 | `web` deployment `COMPLETED` |
| 15:33:28 | `worker` deployment `COMPLETED` (last, because its 60s `stopTimeout` drains the old task longer than api/web's health-check-driven cutover) |

Running image confirmed as `nextagency-demo/api:f65d2f7` — the triggering
commit's short SHA, exactly what `${GITHUB_SHA::7}` in `deploy.yml` passed
to `scripts/deploy.sh`. `/api/health` returned `200`.
