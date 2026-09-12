# 03 — Docker + Turborepo monorepo

Each of `apps/api`, `apps/worker`, `apps/web` has its own Dockerfile
(`docker/Dockerfile.api`, `.worker`, `.web`) and its own final image — there
is no single "build everything" image. All three lean on `turbo prune` to
solve the same problem: a plain `docker build .` from the repo root would
`COPY` and install all three apps' dependencies into every image, even
though (say) the worker image never runs a line of Next.js code.

## Why prune

`turbo prune <app> --docker` (run inside the `pruner` stage) walks the
workspace graph backwards from one app and writes two directories under
`out/`: `out/json/` (every relevant package's `package.json` only —
`api`/`worker`/`web` plus their workspace deps like `@demo/queue`, but not
each other) and `out/full/` (those same packages' actual source). Nothing
belonging to the *other* two apps is copied at all. The result: the api
image's `node_modules` has no trace of Next.js, and the web image has no
trace of NestJS or `@bull-board`.

## The four stages, and what each caches

1. **`base`** — installs the pinned pnpm version via corepack. Shared by
   every later stage; changes almost never, so it's always cache-hit.
2. **`pruner`** — installs `turbo` globally, copies the *whole* repo in,
   and runs `turbo prune`. This stage's own build cache is nearly useless
   (any source change anywhere invalidates the `COPY . .`), but that's fine
   — it's cheap, and its only job is to produce `out/`.
3. **`installer`** — the expensive stage, split into two `COPY`s
   deliberately: first `out/json/` + the pruned lockfile, then
   `pnpm install --frozen-lockfile`, and *only after that* `out/full/` (real
   source) is copied in. Docker layer caching means editing application
   code doesn't invalidate the `pnpm install` layer — it's only invalidated
   when a `package.json` or the lockfile actually changes. Then
   `turbo run build --filter=<app>...` builds that app and every workspace
   package it depends on (`@demo/queue`, and for `worker`/`api`,
   `@demo/eslint-config`/`@demo/tsconfig` are pulled in as devDependencies
   of the pruned manifests too, harmlessly).
4. **`runner`** — a fresh `node:22-alpine` with no build tooling, no
   `turbo`, no pnpm-installed devDependencies download cache — just the
   built output copied in from `installer`. This is the layer that actually
   ships.

## Why `pnpm prune --prod` — and why it's *not* in these Dockerfiles

The standard last step of the `installer` stage in most turbo+pnpm
Dockerfile examples is `pnpm prune --prod`, which deletes devDependencies
(TypeScript, `ts-jest`, `@nestjs/cli`, etc.) after the build has already
used them, so the `runner` stage only inherits the smaller production
`node_modules`. On this repo's exact versions (pnpm 10.30.2, Node 22), that
command instead threw `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, and
even with `--config.confirmModulesPurge=false` to get past that, it went on
to strip every top-level symlink out of `node_modules` and
`apps/*/node_modules` — including `dotenv`, a *production* dependency —
while leaving the actual packages orphaned in the pnpm content store
(`node_modules/.pnpm/…`). The runner container failed at startup with
`Cannot find module 'dotenv/config'`. Comparing image sizes with and
without that command showed no reduction at all (569MB either way) — on
this pnpm/Node combination `prune --prod` isn't trimming anything, it's
just breaking the symlinks — so both Dockerfiles skip it entirely and
`runner` copies the whole (unpruned) `installer` `/app`. Cost: nothing
measurable, since a *working* prune wasn't observed to save any space here
either. Final images: **api 519MB, worker 507MB, web 316MB** (web is
smaller because its `runner` only copies the Next.js standalone output, not
`installer`'s full `node_modules`).

## Standalone Next.js output layout

`next.config.js` has `output: "standalone"`, so `next build` produces a
self-contained `apps/web/.next/standalone/` tree with its *own* pruned
`node_modules` and an `apps/web/server.js` entrypoint — no `next start`,
no full `node_modules`, needed at runtime. But it deliberately does **not**
include the `.next/static/` assets (browser JS/CSS), so `Dockerfile.web`'s
`runner` stage does two separate `COPY`s: the standalone tree to `/app`,
then `.next/static` back on top at `apps/web/.next/static` — miss the
second `COPY` and the app boots fine but every page is unstyled with 404s
in the browser console for `/​_next/static/*`.

One non-obvious gotcha this surfaced: `next.config.js`'s `rewrites()`
reads `process.env.API_URL` to build the `/api/*` proxy destination, but
Next.js resolves `rewrites()` **once, at `next build` time**, baking the
result into `.next/routes-manifest.json` — it is not re-evaluated when the
container starts. Setting `API_URL` at runtime only (the compose file's
`environment:` block, matching how `api`/`worker` get `REDIS_URL`) has no
effect on the proxy. `Dockerfile.web` instead sets `API_URL` as a build-time
`ARG`/`ENV` (defaulting to `http://api:4000`, the in-network hostname)
right before the `turbo run build --filter=web...` step.

## Non-root user

Every `runner` stage ends with `USER node` before `CMD` — `node:22-alpine`
ships a pre-created uid-1000 `node` user for exactly this. Nothing in these
images needs to bind a privileged port or write outside `/app`, so running
as root would be pure unnecessary blast radius.

## `HEALTHCHECK` only where there's an HTTP port

Only `Dockerfile.api` has a `HEALTHCHECK` (`GET /api/health`), because it's
the only one of the three with a port to poll. `worker` has no server at
all — nothing to `wget` — so a healthcheck there would just be pinging a
socket that was never going to accept connections; its liveness is judged
by whether the process is still running, which Docker already tracks.
`web` also gets no explicit `HEALTHCHECK` here (out of scope for this task)
even though it does have a port.

## arm64 via QEMU: build time observed

`docker run --privileged --rm tonistiigi/binfmt --install arm64` registers
the `qemu-aarch64` binfmt handler once; after that
`docker buildx build --platform linux/arm64 -f docker/Dockerfile.worker
--load .` builds and loads an arm64 image on amd64 hardware by emulating
every `RUN` instruction. `docker run --rm --platform linux/arm64
demo-worker:arm64 node -e "console.log(process.arch)"` printed `arm64`,
confirming it's a real cross-arch build, not just a relabeled amd64 layer.
The cost is real: this build took **~77 minutes** end-to-end (497MB final
image), almost entirely inside the two `tsc`-based compiles
(`@demo/queue` and `nest build` for `worker`) — turbo reported those two
tasks alone took **1h13m** under emulation, versus under 25 seconds
natively for the same `Dockerfile.worker` build. `pnpm install` was ~5x
slower too (~107s vs ~20-60s natively). This is why arm64 images belong in
CI on native arm64 runners (or a remote builder), not in a developer's
day-to-day inner loop.
