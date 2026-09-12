# 01 — Turborepo

This repo has three pnpm workspace packages that depend on each other
(`@demo/queue` is used by `api` and `worker`) plus two config-only packages
(`@demo/eslint-config`, `@demo/tsconfig`). Turborepo sits on top of the
existing pnpm scripts (`turbo.json`, root `package.json`) and makes running
those scripts across the whole graph fast and correct.

## What turbo adds over plain pnpm scripts

Without turbo, running `pnpm -r build` just runs every package's `build`
script, in whatever order pnpm feels like, every time — even if nothing
changed. Turbo adds two things on top:

- **A task graph.** `turbo.json` declares, per task, what has to finish
  first via `dependsOn`. In this repo:

  ```json
  "build": { "dependsOn": ["^build"], "outputs": [".next/**", "!.next/cache/**", "dist/**"] }
  ```

  The `^` means "the same task, in every workspace dependency of this
  package, first." So `worker#build` waits for `@demo/queue#build`
  (worker depends on `@demo/queue`), because worker imports its compiled
  `dist`, not its TypeScript source.

- **A content-addressed cache.** Before running a task, turbo hashes its
  inputs — the package's source files, its `package.json`, the versions of
  its workspace dependencies, and any env vars listed in `globalEnv`
  (`REDIS_URL`, `PORT`, `API_URL` here) — into one key. If a previous run
  already produced output for that exact key, turbo replays the old
  stdout/stderr and restores the old `outputs` instead of re-running the
  command.

Verified in this repo:

```
$ pnpm turbo run build --force >/dev/null && pnpm turbo run build
...
 Tasks:    3 successful, 3 total
Cached:    3 cached, 3 total
  Time:    12ms >>> FULL TURBO
```

`FULL TURBO` means every task in the run was a cache hit — nothing actually
executed, turbo just replayed logs and restored `dist/`. 12ms vs. the ~5s
the `--force` run took.

**`--filter`** scopes a run to part of the graph. `worker...` (dots after
the name) means "worker and everything it depends on"; `...worker` (dots
before) would mean "worker and everything that depends on it." Checked here:

```
$ pnpm turbo run build --filter=worker... --dry-run=json | grep '"package"' | sort -u
      "package": "@demo/eslint-config",
      "package": "@demo/queue",
      "package": "@demo/tsconfig",
      "package": "worker",
```

No `api` in the list — the filter correctly excludes the sibling app. The
two extra config packages are a gotcha, see below. `--dry-run=json` is the
way to inspect the resolved task graph (what would run, in what order,
with what hash) without actually building anything.

## Why `outputs` matters

`outputs` tells turbo what to snapshot after a task runs and what to
restore on a cache hit. For `build` that's `dist/**` (Nest's compiled
output) and `.next/**` for a future Next.js app. Nothing listed in
`outputs` is restored — if you forget to list a directory a task actually
writes, a "cache hit" will silently skip regenerating it and later steps
that expect it will fail against stale or missing files.

`.next/cache/**` is explicitly excluded (`"!.next/cache/**"`) because it's
Next's own incremental build cache: large, tied to the exact filesystem
paths and Node/Next version of the machine that produced it, and not safe
to replay verbatim on another machine or after a dependency bump. Turbo's
own cache is the thing that should decide whether to rebuild; `.next/cache`
would fight it.

## `turbo prune --docker`

`pnpm turbo prune worker --docker` generates a minimal, worker-only subset
of the monorepo in `out/`, meant to be `COPY`'d into a Docker build in two
layers so dependency installation is cached separately from source changes:

- **`out/json/`** — every workspace package's `package.json` only (plus
  root `package.json`, `pnpm-workspace.yaml`, `.npmrc`), stripped of source.
  `COPY` this layer and run `pnpm install --frozen-lockfile` against it; as
  long as no `package.json` changed, Docker reuses that layer's cache even
  if application code did change.
- **`out/full/`** — the same packages with their actual source
  (`out/full/apps/worker/src/**`, etc.) included, for the layer that runs
  the actual build.
- **`out/pnpm-lock.yaml`** — a lockfile pruned to only the dependencies the
  selected package (and its workspace deps) actually need, so
  `pnpm install --frozen-lockfile` in the Docker build doesn't need the
  full monorepo lockfile.

`packageManager` (`"pnpm@10.30.2"` in root `package.json`) has to be set
because `turbo prune` and the resulting `pnpm install` need to know exactly
which package manager and version to use — without it, `corepack` (or a
CI image) has nothing to pin to, and a version drift between the pruned
lockfile and whatever pnpm happens to be on `$PATH` can produce a subtly
different install than the one that was tested.

## Gotchas hit in this repo

- **`--filter=worker...` pulls in devDependencies, not just runtime deps.**
  The dry-run list above includes `@demo/eslint-config` and
  `@demo/tsconfig` even though worker only needs them at lint/typecheck
  time, because both are declared `workspace:*` in worker's
  `devDependencies` (`apps/worker/package.json`) and turbo's dependency
  graph doesn't distinguish `dependencies` from `devDependencies`. They
  don't actually run: neither package has a `build` script, and
  `--dry-run=json` shows them with `"command": "<NONEXISTENT>"` — turbo
  still lists them as graph nodes for completeness, it just skips
  executing them.
- **`dev` is intentionally uncached.** `"dev": { "cache": false, "persistent": true }`
  — a dev server has no "output" to cache and must be allowed to keep
  running (`persistent`) instead of being treated as a finished task, or
  `turbo run dev` would immediately think the task graph is done and exit.
- **`lint`/`typecheck`/`test` all depend on `^build`**, not just their own
  package's build. That's because `worker`'s tests and typecheck import
  `@demo/queue`'s compiled types/output; without the dependency, turbo
  could run `worker#test` before `@demo/queue#build` had ever produced a
  `dist/`, and the run would fail non-deterministically depending on task
  ordering.
