# 04 — Terraform state and roots

## Why remote state

Terraform state is a JSON file recording what it thinks exists in AWS
(resource IDs, attributes — some of them secrets, like DB passwords). Left on
one laptop's disk, it can't be shared: a second person or CI job has no way
to see or lock it, so two applies at once can corrupt it or silently
overwrite each other's work. `infra/bootstrap` creates the fix for every
*other* root: an S3 bucket to hold the state file and a DynamoDB table
(`nextagency-demo-tflock`) so Terraform can take a lock while applying,
forcing concurrent runs to queue instead of racing.

`bootstrap` itself is the one root allowed to use local state — it has to
create the bucket before anything can point at it.

## Root = state boundary

A "root" is a directory with its own `terraform init`/`plan`/`apply` and its
own state file — a separate blast radius. This repo has two: `bootstrap/`
(long-lived account plumbing: state bucket, lock table, budget, GitHub OIDC
provider) and `production/` (the app itself, meant to be destroyed after the
demo). Keeping them separate means `terraform destroy` in `production/` can
never touch the bucket its own state lives in, or the OIDC provider CI needs
to redeploy.

## `default_tags`

Set once on the `provider "aws"` block in `versions.tf`, `default_tags`
applies `Project`/`Environment`/`ManagedBy` to every resource in the root
automatically — no need to repeat `tags = {...}` on each resource, and no
resource can be created untagged by accident.

## `plan -out` then `apply tfplan`

`terraform plan -out tfplan` writes the exact set of changes Terraform is
about to make to a file; `terraform apply tfplan` then applies precisely
that plan, unmodified. Running bare `terraform apply` instead re-plans at
apply time — if anything in AWS changed in between (or a variable did), you
can end up applying something you never reviewed. The two-step habit is
what makes it safe to eyeball a plan's summary line ("N to add, 0 to
change, 0 to destroy") before anything real happens.

## `terraform.tfvars` vs `.tfvars.example`

`terraform.tfvars` holds this deployment's actual values — here, a real
email address and an account-specific bucket name — and is git-ignored
because it's environment-specific and not something to commit.
`terraform.tfvars.example` is the checked-in template showing what keys
are expected, with placeholder values; copy it to `terraform.tfvars` and
fill in the real ones before running `init`.

## Why the OIDC provider is account-global

An `aws_iam_openid_connect_provider` for GitHub Actions can only exist once
per AWS account — creating a second one for the same URL fails. It belongs
in `bootstrap/`, not `production/`, specifically so that destroying and
recreating `production/` between demo runs never deletes (and has to
recreate) the trust relationship CI depends on to assume a role.

## Toolchain note

Terraform and the AWS CLI used here live in `~/.local/bin` — run
`export PATH=$HOME/.local/bin:$PATH` before any `terraform`/`aws` command in
a fresh shell.
