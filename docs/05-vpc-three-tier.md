# 05 — VPC: three tiers, one CIDR block

See also: `AWS-ECS-FARGATE-GUIDE.md` §2 (Networking vocabulary) and §5.4 (how
a request actually travels hop by hop). This note covers what `network.tf`
builds and why it's split the way it is.

## Three tiers, one route table each

`network.tf` carves the VPC (`10.40.0.0/16`) into three tiers, two subnets
each (one per AZ, for the pattern — nothing here is actually multi-AZ HA
since each service runs a single task). Each tier gets its own route table,
and the route table *is* the tier's identity — not a tag, a routing fact:

| Tier | Subnets (this apply) | Route table | Default route (`0.0.0.0/0`) |
|---|---|---|---|
| public | `10.40.0.0/24`, `10.40.1.0/24` | `aws_route_table.public` | → Internet Gateway |
| private-app | `10.40.10.0/24`, `10.40.11.0/24` | `aws_route_table.private` | → NAT Gateway |
| private-data | `10.40.20.0/24`, `10.40.21.0/24` | `aws_route_table.data` | none |

Only the public route table's association gives a subnet a real path to the
internet as a *destination*: an Internet Gateway is stateful in neither
direction — anything with a public IP in a public subnet can be reached from,
and reach, the internet directly.

## Why the data tier has no default route

`aws_route_table.data` in `network.tf` has no `route` block at all — just the
VPC association. That's deliberate, not an oversight: Redis (ElastiCache) has
no business ever initiating or receiving a connection outside the VPC. Even
if someone widened `security.tf`'s `redis` security group to `0.0.0.0/0` by
mistake, there is still no route out of that subnet to anywhere but other
VPC subnets — the route table itself is the second lock on the door. Defense
in depth: security groups say who's *allowed*, route tables say who's even
*reachable*.

## What a NAT gateway is for, and what it costs

The private-app subnets (where the ECS tasks run) have no public IPs, so
they can't reach the internet directly — but the tasks still need *outbound*
paths (pulling images from ECR, calling Secrets Manager and CloudWatch Logs
API endpoints, any third-party API). `aws_nat_gateway.this` sits in a public
subnet with an Elastic IP (`aws_eip.nat`) and translates: private-app traffic
routes to it, it forwards to the Internet Gateway with its own public IP as
the source, and return traffic comes back the same way. Nothing can initiate
a connection *into* the private-app subnet through it — NAT is outbound-only
by construction.

Cost is the reason this project runs one NAT gateway instead of one per AZ
(the normal HA pattern): each NAT gateway is billed hourly (~$0.045/hr ≈
$32/mo) *plus* per-GB data processed, whether or not it's ever interrupted by
an AZ failure. One shared NAT gateway is the single biggest fixed line item
in this stack's ~$3.40/day estimate — a real tradeoff being made here for a
personal-account demo, not something you'd ship to a production account
without at least discussing it.

## `cidrsubnet(cidr, 8, i)` — carving `/24`s out of a `/16`

`variables.tf` sets `vpc_cidr = "10.40.0.0/16"` — a /16 has 16 host bits.
`cidrsubnet(cidr, 8, i)` says "extend the prefix by 8 more bits" (16 + 8 =
24, i.e. cut it into /24s) "and take the `i`-th one." So:

- `cidrsubnet("10.40.0.0/16", 8, 0)` = `10.40.0.0/24` (public, AZ 1)
- `cidrsubnet("10.40.0.0/16", 8, 10)` = `10.40.10.0/24` (private-app, AZ 1)
- `cidrsubnet("10.40.0.0/16", 8, 20)` = `10.40.20.0/24` (private-data, AZ 1)

The gaps (indices 2–9, 12–19) aren't wasted — they're headroom. Picking
non-adjacent starting offsets per tier (`0`, `10`, `20`) means you can grow
any one tier to more AZs or add more subnets later without ever having to
renumber a tier that's already in use downstream (security group rules,
peering, on-prem routes — anything written against a CIDR range).

## Why the ALB lives in public subnets but the tasks don't

`aws_lb.this` in `compute.tf` sets `subnets = aws_subnet.public[*].id`. The
load balancer is the one thing in this stack that's *supposed* to be
reachable from the internet — that's its whole job, terminating `GET /` from
a browser. The ECS tasks (`network_configuration.subnets =
aws_subnet.private_app[*].id`, in the same file) never need a public IP:
every request that reaches them arrives *through* the ALB, which is already
inside the VPC by the time it forwards to a task's private IP. Giving tasks
public IPs would mean two paths into the app (direct-to-task, bypassing the
ALB's routing rules and health checks) instead of one enforced choke point.
This is the same shape as the Rails project's `NETWORK_ARCHITECTURE.md`:
public tier terminates the internet, private-app tier does the work, and
nothing but the LB tier is dual-homed.

## This apply's real values

The subnet table above is exactly what account `472408435328` created on
2026-09-13, confirmed via `aws ec2 describe-subnets` after the fact — the
CIDR math and the reality matched with no surprises. The NAT gateway
(`nat-0a5b69a66529fb23f`) took 1m37s to reach `available`, the slowest
network-tier resource but still well under the ElastiCache replication
group's 4m42s (see `06-ecs-fargate-roles-and-tasks.md`'s "This apply's real
values"). The api and web tasks that ended up running in the private-app
tier landed at `10.40.10.90` (us-east-1a) and `10.40.11.181` (us-east-1b) —
one per AZ, each inside the `/24` its AZ's subnet carved out, exactly as the
`cidrsubnet` math above predicts.
