# 06 — ECS/Fargate: cluster, service, task; two roles; one ENI per task

See also: `AWS-ECS-FARGATE-GUIDE.md` §2 (Containers vocabulary), §5.2/§5.3
(what `compute.tf` and `iam.tf` create and how to read them in the console).
This note is the "why," using the exact resources in this repo.

## Cluster, service, task definition, task — four different nouns

It's easy to blur these; they nest, and only the last one is an actual
running thing:

- **Cluster** (`aws_ecs_cluster.this`) — a namespace / capacity boundary.
  Nothing runs "in" it directly; it's just where services and tasks are
  grouped and billed together. One cluster, `nextagency-demo`, holds all
  three services here.
- **Task definition** (`aws_ecs_task_definition.app`, one per app via
  `for_each = local.apps`) — a *recipe*, not a running thing: which image,
  how much CPU/memory, which roles, which env vars and secrets, which log
  group. Registering one creates a new immutable revision (`:1`, `:2`, …);
  it costs nothing and starts nothing by itself.
- **Service** (`aws_ecs_service.app`) — the thing that keeps a task
  definition running: "keep `desired_count = 1` copies of task definition
  revision N alive, replace any that die, and (for api/web) register them
  with this target group." A service is what makes ECS self-healing instead
  of a one-shot `docker run`.
- **Task** — one actual running instance: a task definition revision plus a
  real Fargate-managed ENI, private IP, and container process. This is the
  unit you see in **ECS → Clusters → Tasks**, with its own IP and log
  stream.

## Execution role vs. task role — who's allowed to do what, and when

Both are assumed by `ecs-tasks.amazonaws.com` (`iam.tf`'s
`ecs_tasks_assume` document), but at different moments and for different
reasons:

- **Execution role** (`aws_iam_role.execution`) — what the *ECS agent* needs
  to get a task from "scheduled" to "starting the container," before your
  code runs at all. This repo attaches the AWS-managed
  `AmazonECSTaskExecutionRolePolicy` (pull from ECR, write to CloudWatch
  Logs — the baseline every Fargate task needs) plus one inline policy,
  `execution_secrets`: `secretsmanager:GetSecretValue` scoped to exactly
  `aws_secretsmanager_secret.redis_url.arn`. That's the only way the
  `REDIS_URL` secret ever gets resolved — the agent fetches it at launch and
  injects it as an env var before your process's first line executes.
- **Task role** (`aws_iam_role.task`) — what the *application code itself*
  is allowed to call via the AWS SDK once it's running. Here that's
  deliberately minimal: just `ecs-exec` (`ssmmessages:Create/OpenControlChannel`,
  `Create/OpenDataChannel`), which is what lets `aws ecs execute-command`
  open a shell inside a running task. The app code never calls
  Secrets Manager itself — it just reads `process.env.REDIS_URL`, already
  resolved by the execution role above. Two roles, two blast radii: a
  container compromise gets ECS Exec plumbing, not secret-reading rights.

## `awsvpc` networking — every task gets its own ENI

`network_mode = "awsvpc"` on the task definition means Fargate gives *each
task* a real Elastic Network Interface with its own private IP from the
`private_app` subnet CIDR, not a shared host IP with port-mapped NAT (the
old EC2/bridge-mode ECS behavior). Consequences that show up elsewhere in
this stack: security groups attach to the *task* (`aws_security_group.app`
in `network_configuration`, not to a host), so `sg_app`'s rules are the
actual boundary; the ALB target group type is `ip`, not `instance`,  because
there's no shared instance to point at — see `07-alb-routing.md`; and two
tasks of the same app can never collide on a port, since each has its own
network namespace.

## Secrets injection (`valueFrom`) vs. plain `environment`

The task definition's `container_definitions` has two separate lists:
`environment` (plain `{name, value}` pairs, baked into the task definition
JSON — visible to anyone who can `DescribeTaskDefinition`) and `secrets`
(`{name, valueFrom}`, an ARN — resolved at launch by the *execution role*,
never written into the task definition itself). `REDIS_URL` is a `secrets`
entry pointing at `aws_secretsmanager_secret.redis_url.arn` specifically so
the Redis auth token never appears in plaintext in the task definition,
CloudFormation-style templates, or `terraform show`. `NODE_ENV`, `PORT`,
`HOSTNAME`, `API_URL` are plain `environment` — nothing sensitive, no reason
to pay the extra API call.

## `stopTimeout` and SIGTERM

When ECS stops a task (deploy, scale-down, drain), it sends `SIGTERM` to the
container's main process, waits up to `stopTimeout` seconds for it to exit
cleanly, then sends `SIGKILL` if it hasn't. `api` and `web` use 30s (default
housekeeping); `worker` is set to 60s specifically because it's mid-flight
on BullMQ jobs when a deploy happens — a `SIGTERM` handler in worker code can
finish the current job and stop pulling new ones, and 60s is deliberately
generous headroom for that to complete instead of a job dying half-processed
and needing BullMQ's stall-recovery to redo it.

## `runtime_platform` and this stack's architecture

`runtime_platform { cpu_architecture = ..., operating_system_family =
"LINUX" }` is a required block on every Fargate task definition — it's how
Fargate picks the underlying hardware to run your container on, and it must
exactly match the architecture the image was built for or you get a boot
failure, not a graceful error. Graviton (`ARM64`) is often the default
recommendation for greenfield ECS Fargate work because it's cheaper per
vCPU-hour; this stack pins `X86_64` instead, matching the demo's
`--platform linux/amd64` image builds — a deliberate choice for this account
to avoid any cross-arch surprises during first bring-up, not a Graviton
oversight.

## The deployment circuit breaker

`deployment_circuit_breaker { enable = true, rollback = true }` on the
service tells ECS to watch a rolling deployment and, if new tasks keep
failing to reach steady state (crash-looping, never passing their health
check), stop retrying forever and automatically roll back to the last
working task definition revision. Without it, a bad deploy can burn cycles
(and CloudWatch Logs volume) retrying indefinitely while the service sits at
`0/1` — with it, ECS gives up after a bounded number of attempts and returns
you to a known-good state on its own.

Caveat: rollback needs a *previous completed deployment* to roll back to.
On a service's very first deployment — task definition revision `:1`, as in
this apply — there is no earlier good revision, so a tripped breaker simply
marks the deployment `FAILED` and leaves the service at 0 running tasks;
"automatic rollback" only starts protecting you from the second deployment
onward.

## Why `ignore_changes = [task_definition]`

The service's `lifecycle { ignore_changes = [task_definition] }` exists
because two different processes update the same field: Terraform manages
the *infrastructure* (cluster, roles, networking, target groups), but
`docker push` + `aws ecs update-service --task-definition <new-revision>`
(Phase 10's `deploy.sh`, and later GitHub Actions) manages *application
releases* by registering new task definition revisions outside Terraform
entirely. Without `ignore_changes`, the next `terraform plan` after a manual
deploy would see the service pointing at a task definition revision
Terraform doesn't know about and want to "fix" it back to the last
Terraform-applied revision — silently undoing every deploy. This is the same
split as the Rails project: Terraform owns infrastructure, the deploy
pipeline owns releases, and neither fights the other for the same field.

## This apply's real values

`terraform apply` (52 resources) ran 5m27s, ElastiCache the long pole at
4m42s. `api`/`web` tasks (`10.40.10.90`, `10.40.11.181`) passed their target
health checks on the first poll — `health_check_grace_period_seconds = 60`
wasn't even needed this time, but it's there for a slower cold start.

The hardening commit's `depends_on` addition (`aws_iam_role_policy.execution_secrets`,
`aws_iam_role_policy_attachment.execution_managed`) orders the services after
the execution role's *IAM policies* — it guarantees the role can already
read the secret and pull images by the time a task tries to start, closing
an IAM-propagation race. It does **not** order the services after
`aws_secretsmanager_secret_version.redis_url` — that resource isn't in the
`depends_on` list, so Terraform is free to create it and the services
concurrently. That's a separate resource with its own propagation delay,
and it's what the `worker` task (`10.40.10.188`, no target group) actually
hit: its first two placements failed on a Secrets Manager `AWSCURRENT`
label race on that secret *version* (detail in `07-alb-routing.md`'s
matching section), not on the IAM policies the hardening commit covers.
ECS's own placement retry absorbed it, succeeding on the third attempt
about a minute later, with no HCL change needed. Whether
`aws_secretsmanager_secret_version.redis_url` belongs in the service
`depends_on` too is a fair follow-up — see the report's concerns.
