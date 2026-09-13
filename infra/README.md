# infra/
Two independent Terraform roots, each with its own state (same convention as NextAgency's `terraform/`).
- `bootstrap/` — local state. State bucket, lock table, budget alarm, GitHub OIDC provider. Apply once, keep.
- `production/` — S3 backend. Everything the app needs. Apply for the demo, destroy after.
Order: bootstrap → push images (Task 9.6) → production.
