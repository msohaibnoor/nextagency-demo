# 07 — ALB: one listener, two target groups, path-based routing

See also: `AWS-ECS-FARGATE-GUIDE.md` §2 (Load balancing vocabulary) and §5.4
(a request traced hop by hop end to end). This note covers what
`compute.tf`'s ALB block does and why, with this apply's real values filled
in at the bottom.

## Target group type `ip`, not `instance`

`aws_lb_target_group.web` and `.api` both set `target_type = "ip"`. Classic
ECS-on-EC2 target groups register the *EC2 instance* and a host port; that
model doesn't exist here because Fargate tasks aren't EC2 instances you can
point at — each task gets its own ENI and private IP (see
`06-ecs-fargate-roles-and-tasks.md`, `awsvpc` networking). `target_type =
"ip"` tells the target group to register and health-check *task IPs*
directly, and the ECS service does that registration automatically on every
task start/stop via the `load_balancer` block — no manual
register-target/deregister-target calls anywhere in this stack.

## Health checks: one per target group, tuned per app

Each target group owns its own health check, because "healthy" means
something different for each app:

| Target group | Path | Matcher | Interval | Healthy / unhealthy threshold |
|---|---|---|---|---|
| `web` | `/` | `200` | 15s | 2 / 3 |
| `api` | `/api/health` | `200` | 15s | 2 / 3 |

Two consecutive 200s (30s) promote a target to healthy; three consecutive
failures (45s) demote it — deliberately asymmetric so a target isn't yanked
out of rotation on one blip, but a truly broken task is still caught inside
a minute. `worker` has no target group at all: it's never behind the ALB
(`compute.tf`'s `dynamic "load_balancer"` block is empty for
`each.key == "worker"`), so there's nothing for a health check to probe —
its liveness is ECS's own task-level health, not an HTTP check.

## Listener + rule priority — how the ALB picks a target group

There's one listener, `aws_lb_listener.http` on port 80, with a
`default_action` forwarding to the `web` target group. `aws_lb_listener_rule.api`
adds one path-based rule at `priority = 10`: if the request path matches
`/api/*`, forward to the `api` target group instead. Lower priority numbers
are evaluated first (this stack only has one rule, so the number itself
doesn't matter yet, but it will the moment a second rule is added — the ALB
walks rules in ascending priority order and stops at the first match, falling
through to the listener's `default_action` if nothing matches). The practical
effect: `GET /` and any other unmatched path go to `web` (the Next.js app);
anything starting with `/api/` — `/api/health`, `/api/jobs/stats`,
`/api/admin/queues` (Bull Board) — goes to `api`. One hostname, one port,
two backends, routed entirely by path.

## `deregistration_delay`

Both target groups set `deregistration_delay = 10` (seconds) — the default
is 300. When a task is being replaced (deploy, scale-down, health-check
failure), the ALB stops sending it *new* requests immediately but waits this
long before fully deregistering the target, giving in-flight requests time
to finish. 10s instead of the 5-minute default is a deliberate demo-speed
tradeoff: it makes `terraform apply`/rolling deploys visibly faster in a
20-minute session at the cost of being slightly less gentle to any request
that happens to be mid-flight exactly when a task is cycled — acceptable
here, and something you'd reconsider (dial back up) for a real production
workload with sustained traffic.

## This apply's real values

This is the first real apply against account `472408435328` (2026-09-13).

- ALB DNS name: `nextagency-demo-668835763.us-east-1.elb.amazonaws.com`
  (`terraform output alb_dns_name`)
- `GET http://<dns>/api/health` → `200 {"ok":true,"redis":"up"}` — healthy on the
  first poll, no wait needed once the apply finished
- `GET http://<dns>/` → the Next.js landing page; target: `10.40.11.181:3000` (us-east-1b), state `healthy`
- `GET http://<dns>/api/jobs/stats` before/after `POST /api/jobs/seed {"count":10}`:
  `renewal-reminders.completed` went `0 → 10` within 5 seconds — the worker
  task (`10.40.10.188`, us-east-1a, no target group) drained the whole batch
  almost immediately
- `GET http://<dns>/api/admin/queues` → `200` (Bull Board); target: `10.40.10.90:4000` (us-east-1a), state `healthy`
- One transient event worth knowing about: on first launch, the `worker`
  service failed to place its first two tasks with
  `ResourceInitializationError: … unable to retrieve secret … ResourceNotFoundException:
  … can't find the specified secret value for staging label: AWSCURRENT` —
  Secrets Manager's `AWSCURRENT` label on the just-created `redis_url`
  secret *version* (`aws_secretsmanager_secret_version.redis_url`) hadn't
  propagated yet when the execution role first tried to resolve it. ECS
  retried automatically and the third attempt succeeded about a minute
  later, with no Terraform or code changes needed.

  This is **not** the scenario the hardening commit's `depends_on` addition
  targets. That addition orders the services after the execution role's IAM
  policies (`aws_iam_role_policy.execution_secrets`,
  `aws_iam_role_policy_attachment.execution_managed`) — it makes sure the
  role's *permissions* are attached before a task tries to use them, which
  is an IAM-propagation concern. The secret version that raced here is a
  different resource entirely and isn't in that `depends_on` list, so
  Terraform can (and did) create it and the services in parallel. The two
  problems look similar — both are "AWS eventual consistency after create"
  — but the hardening commit only closes the IAM one; the secret-version
  race that actually happened here was absorbed by ECS's own placement
  retry, not by anything in the HCL. See the report's concerns for whether
  `aws_secretsmanager_secret_version.redis_url` should be added to the
  service `depends_on` in a follow-up.
