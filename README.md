# CrewQuo v2

Mobile-first contractor / subcontractor management. Postgres + TypeScript API on Render; Expo (mobile) and Next.js (web) clients on the way.

The full specification lives in **[`CREWQUO_V2_PLAN.md`](./CREWQUO_V2_PLAN.md)** and current progress in **[`PROGRESS.md`](./PROGRESS.md)**. Read the plan — and, before implementing the rate engine or authorization, read v1's `functions/src/rates.ts` and `firestore.rules` (from the v1 repo).

## Status

**Phase 3 — The core work loop (shipped).** On top of Phases 0–2 (foundations, identity/auth/entitlements, rate engine + catalog + web console): engagements & the relationship graph, providers/members/invite-accept, projects + assignments, the `DRAFT → SUBMITTED → APPROVED/REJECTED` work workflow with server-computed project summaries (cost + margin), and the mobile log-time → approvals flow with Expo push. Phase 4 (client portal + exports + audit) is next. See [`PROGRESS.md`](./PROGRESS.md).

## Prerequisites

- Node 20+ (the containers and CI both run 22; `.nvmrc` says 20 and the two should be reconciled)
- pnpm 10+ (`corepack enable`)
- Docker Desktop — Postgres **and** the API run in containers

## All data is local until CrewQuo is production ready

**Owner decision, 2026-08-31.** There is no hosted database holding customer-shaped
rows and there is not meant to be one yet. Concretely, and each of these is a thing
somebody could otherwise do in good faith and undo the decision:

- **[`render.yaml`](./render.yaml) is a blueprint for later and is deliberately not
  applied.** It declares paid plans, so applying it provisions real infrastructure —
  that is the decision it records, not an instruction to run it now.
- **The GitHub Actions schedule in
  [`scheduled-jobs.yml`](./.github/workflows/scheduled-jobs.yml) stays paused.** Its
  `cron:` triggers are commented out. It is the one thing in the repo that would run
  against a remote `DATABASE_URL`, so restoring it means creating exactly the hosted
  database this decision defers. Run a pass by hand instead — see the commands below.
- **Postgres keeps its data in a local Docker volume** (`crewquo_pgdata`), on this
  machine, and nothing replicates it anywhere.

**The one deliberate exception, stated rather than buried:** `RESEND_API_KEY` in
`.env` is a live key, so mail the app sends really is delivered, which means
recipient addresses and notification bodies do leave the machine. That was chosen
knowingly (owner, 2026-08-31) because a mail path nobody has watched deliver is a
mail path nobody has tested. Unset the key to make the adapter record `SKIPPED` with
a reason and send nothing.

## Getting started

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment (required — the compose file reads this file)
cp .env.example .env          # then edit if needed

# 3. Start the local stack: Postgres, MinIO and the API, all in Docker
docker compose --env-file .env -f infra/docker-compose.yml up -d --build

# 4. Migrate and seed, from the host, against the container
pnpm db:migrate && pnpm db:seed

# 5. Check the API came up (http://localhost:4000)
curl http://localhost:4000/healthz     # -> {"status":"ok","db":"up",...}

# 6. Start the web app — on the host, and always on port 3000
pnpm --filter @crewquo/web dev
```

### The web app should always be running, and always on port 3000

Treat `pnpm --filter @crewquo/web dev` as something you leave up while you work, on
`http://localhost:3000` and nowhere else. The port is not a preference:

- the API builds its **CORS allowlist** from `APP_BASE_URL`, which is
  `http://localhost:3000`, so a browser on another port gets opaque CORS failures
  rather than an error that names the real problem;
- **every link in an outbound email** — verification, password reset, the account
  closure notices — is written against that origin, so a link opens the instance on
  3000 or nothing at all;
- **Playwright's `baseURL` is 3000** with `reuseExistingServer`, so a drifted port
  means the suite quietly drives a different server than the one you just started.

`next dev` treats `-p 3000` as a *preference*: when the port is taken it prints one
warning and moves to 3001, which leaves an app that loads and is at the wrong
address. So `predev` and `prestart` run
[`require-port-3000.mjs`](./apps/web/scripts/require-port-3000.mjs), which refuses to
start and tells you what is holding the port. If it refuses because your own dev
server is already up, that is the guard working — you do not need a second one.

Both scripts also pass `-H 127.0.0.1`. The stack is loopback-only on purpose while
data is local, and it avoids the IPv6 shadowing that makes a bare port look bound but
unreachable.

### Working on the API

`apps/api/src`, `apps/api/scripts` and `packages/shared/src` are bind-mounted
read-only into the container, so your edits are visible to it immediately — but
**there is no hot reload, and that is a platform limit rather than an oversight.**
Docker Desktop on Windows does not deliver filesystem events across a bind mount, and
`tsx watch` uses Node's `fs.watch` with no polling fallback, so the watcher starts and
then never fires. That was measured, not assumed. Running plain `tsx` instead is
deliberate: a watch that silently does not watch is worse than none, because it invites
you to trust an edit that never loaded.

So the loop is a restart, which the mounts make cheap — a few seconds, no rebuild:

```bash
docker compose --env-file .env -f infra/docker-compose.yml restart api        # after a source or .env edit
docker compose --env-file .env -f infra/docker-compose.yml logs -f api        # follow it
docker compose --env-file .env -f infra/docker-compose.yml up -d --build api  # after a dependency change
```

Rebuild the image only when `package.json` or the lockfile changes; a source edit is
already inside the container.

`node_modules` is deliberately **not** mounted. The image installs its own for Linux,
and mounting a Windows pnpm tree over it would replace a working symlink farm with
paths that do not exist in the container.

**If the restart loop gets in the way, run the API on the host instead:**

```bash
docker compose --env-file .env -f infra/docker-compose.yml stop api
pnpm --filter @crewquo/api dev     # tsx watch, on the host, where file events work
```

That costs nothing in data locality. The two things in this stack that store
anything — Postgres and, since 0027, MinIO — are both still containers on this
machine; where the API *process* runs is a development-comfort choice, not a data
one.


### File storage (local MinIO, R2 in production)

Uploaded evidence, documents and receipts live in an S3-compatible object store.
Locally that is the **MinIO** service in the compose file, on the same reasoning
as the local Postgres: until CrewQuo is production ready, all customer-shaped
data stays on this machine (owner decision, 2026-09-01). Cloudflare R2 is the
production target and speaks the same API, so there is one client and no
abstraction layer.

Its browser console is at http://localhost:9001 (`STORAGE_ACCESS_KEY_ID` /
`STORAGE_SECRET_ACCESS_KEY`). The bucket is created on first use, so there is
nothing to set up.

**The one thing to get right is the pair of endpoints.** A presigned URL is
signed *against a host*: the API reaches the store at `STORAGE_ENDPOINT`
(`http://minio:9000` inside the compose network) while the browser that follows
the URL reaches it at `STORAGE_PUBLIC_ENDPOINT` (`http://127.0.0.1:9000` on the
host). Signing the internal name produces a signature that verifies perfectly
and resolves nowhere — a failure with no error message anywhere in the code. In
production both are the same R2 hostname and the public one can be left unset.

Uploads are three steps and the bytes never pass through the API:
`POST /v1/files/presign` → the client `PUT`s straight to the store →
`POST /v1/files/:id/complete`. Completion sets `SCANNING`, **not** `READY`: the
API never sees the bytes, so the content-type check runs in the `work` pass,
which downloads the original to build previews anyway. Run it after uploading, or
files stay in `SCANNING`:

```bash
pnpm --filter @crewquo/api build   # the job entry points are compiled, not tsx
pnpm --filter @crewquo/api work
```

**A file is not evidence until a record says what it shows.** Once the three
upload steps are done, `POST /v1/projects/:projectId/evidence` turns a selection
into `project_evidence` rows — one request for the whole batch, with metadata
applied to all of it and overridden per photograph. The response always carries
both a `created` and a `rejected` list and never refuses the whole batch for one
bad file, because losing thirty-nine good photographs to one bad one is how a
capture product teaches people to stop using it.

Three timestamps, and they are not interchangeable: `createdAt` is when the
server accepted it and is the only one the platform attests to, `capturedAt` is
what the device's clock claimed, and `evidenceDate` is the project day a person
says it belongs to. A supervisor uploading Friday's photographs on Monday has all
three different.

`client_visible` is the disclosure lever and belongs to the **project owner
alone** — a subcontractor uploads, and the company that owns the client
relationship decides what that client sees. Hiding a published file removes it
from the portal going forward and withdraws nothing already downloaded, which is
what `first_published_at` records and what the API's confirmation copy says.

**A document is a chain, not an edit.** `POST /v1/projects/:id/documents` files
one; `PATCH /v1/documents/:id` corrects its metadata; new bytes go through
`POST /v1/documents/:id/versions`, which inserts a row pointing back at the old
one and hides it by default. Nothing anywhere replaces a document's `file_id` in
place, and `updateDocumentSchema` is strict so that adding such a path would be a
deliberate act. `GET /v1/documents/:id/versions` returns the whole chain from any
version in it.

Documents with an `expiresOn` are scanned by the same `work` pass, which walks a
90/60/30/14/7/0-day ladder in the **project owner's** own time zone and raises a
durable task for the owning company and, where the document is filed against a
subcontractor, for that subcontractor too. Each rung fires once; re-issuing the
document closes the task the old version raised.

**A day is closed once and never reopened.** `POST /v1/projects/:id/diary` opens
an entry for a date — one per project, per company, per day, so a subcontractor
keeps its own diary beside the hiring company's and both are attributed. While it
is `OPEN` it is a live document. `POST /v1/diary/:id/close` freezes it, stamping
who and when; after that every change is an **amendment**, which needs
`diary.close`, needs a reason, writes a `record_revisions` row with before, after
and changed fields, and makes the entry read *"amended N times"* wherever it
appears. There is no reopen and no delete: a day that can be removed is a day
somebody can make not have happened.

`GET /v1/projects/:id/diary/prefill?date=` offers attendance from the day's
submitted and approved time logs so the supervisor confirms rather than retypes —
confirming twice is a no-op rather than a second person. Close Day returns prompts
for what is obviously missing (nobody recorded, nothing written, no photos, drafts
still unsubmitted) and **closes anyway**: a close that refuses until a photograph
exists teaches people to photograph the floor twice.

Two people writing different parts of one open day both land. An edit may carry
the `revision` it was composed against plus a `base` of the fields it started
from; the thirteen narrative fields then merge per field, so a stale edit touching
nothing anybody else touched applies rather than raising a prompt about a change
nobody made. A genuine collision — both sides editing the same field — returns
409 naming the field and both values, and writes nothing.

**All four are sections of one project record** (§20), not four screens: open a
project and the rail carries Locations, Site diary, Photos & evidence and
Documents beside the sections that were already there. A section whose feature the
project owner's plan does not include is **not listed at all** — advertising one
that answers 403 teaches people the rail cannot be trusted — while a section the
plan includes but your own permissions do not is listed, readable, and says which
permission the action needs. Those are different refusals and they get different
answers.

The evidence gallery accepts a drag-and-drop of a whole selection, tags it in one
pass with per-photograph overrides, and keeps whatever uploaded when part of a
batch fails. The drop zone is a `<label>` around a real file input, so the
keyboard path and the pointer path are the same control rather than two
implementations of one outcome.

## Useful commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run all apps in dev (turbo) |
| `pnpm type-check` | Type-check every package |
| `pnpm lint` | Run the type-aware promise and React Hooks lint gates |
| `pnpm test` | Run unit tests |
| `pnpm db:migrate` | Apply pending SQL migrations |
| `pnpm db:seed` | Run the seed script |
| `pnpm --filter @crewquo/web dev` | Run the web console — **always** http://localhost:3000, guarded; leave it running |
| `docker compose --env-file .env -f infra/docker-compose.yml up -d` | Start the local stack (Postgres + MinIO + API) |
| `docker compose --env-file .env -f infra/docker-compose.yml logs -f api` | Follow the API log |
| `docker compose --env-file .env -f infra/docker-compose.yml down` | Stop the stack (the data volume survives) |
| `pnpm --filter @crewquo/api build` | Compile the API server and production job entry points to `apps/api/dist` |
| `pnpm --filter @crewquo/api rehearse-restore` | Restore the local Docker database into isolated scratch, verify it, and clean it up |
| `pnpm --filter @crewquo/api launch-check` | Run the read-only production launch gate against the configured database |
| `pnpm --filter @crewquo/api purge-audit` | Delete audit rows past their retention window |
| `pnpm --filter @crewquo/api purge-auth` | Prune rate-limit counters and long-expired sessions |
| `pnpm --filter @crewquo/api work` | Reconcile verified webhooks, drain the outbox and deliver notifications (`-- --loop` locally) |

Run the two purges from an external daily scheduler
(`pnpm --filter @crewquo/api purge-audit`, `pnpm --filter @crewquo/api purge-auth`);
both are one-shot on purpose rather than process-local, so a dead job is restarted by
the scheduler instead of silently stopping when one API instance falls over. Neither
touches `platform_audit_logs`, which is insert-only and outside every purge — so no
retention setting can erase the record that somebody was locked out or that a session
was revoked.

## Layout

```
apps/
  api/            Express 5 + node-postgres API (Render)
  web/            Next.js 14 console — rate cards, roles, templates, resolve
  mobile/         Expo (expo-router) app — login, entitlements, company switcher
packages/
  shared/         Zod schemas, domain enums, the rate engine — pure TS
  ui/             Neutral web design system (tokens + primitives)
infra/
  migrations/     Forward-only SQL migrations + runner
  seed/           Seed scripts
  docker-compose.yml   Local Postgres
render.yaml       Render blueprint (API + Postgres) — must sit at the repo root
```

## Deployment

Two hosts, one each. **They are not interchangeable** — `apps/api` is a long-running
Express server (`app.listen`), so it cannot run as a Vercel serverless function; a
Vercel project pointed at it fails at runtime with `FUNCTION_INVOCATION_FAILED`.

### API + Postgres → Render

Either route works — the blueprint is only automation.

**Blueprint.** Dashboard → **New → Blueprint** → this repo. Render reads
`render.yaml` from the root (it looks nowhere else) and creates the Postgres and
the API together, wiring `DATABASE_URL` and generating the JWT secrets. It prompts
for one value, `APP_BASE_URL` — the Vercel URL below.

**By hand.** Create the Postgres first (**New → PostgreSQL**), then **New → Web
Service** on this repo, leaving Root Directory blank — the build must run from the
monorepo root for the pnpm workspace to resolve.

| Field | Value |
| --- | --- |
| Build Command | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @crewquo/api build` |
| Start Command | `pnpm db:migrate && pnpm --filter @crewquo/api start` |
| Health Check Path | `/healthz` |

Then add the environment variables the blueprint would have set:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the Postgres **Internal Database URL** |
| `JWT_ACCESS_SECRET` | 32+ random chars — `openssl rand -base64 32` |
| `JWT_REFRESH_SECRET` | a *different* 32+ random string |
| `AUTH_SOURCE_PEPPER` | a third 32+ random string — set it once, then never change it |
| `TRUST_PROXY_HOPS` | **`1` on Render.** Left at the default `0`, every request looks like it came from Render's proxy, so one source-keyed sign-in budget is shared by the entire internet and thirty failures from anywhere lock out every user |
| `APP_BASE_URL` | the Vercel URL below |
| `RESEND_API_KEY`, `NOTIFICATION_FROM_EMAIL` | without both, every email records as `SKIPPED` rather than sending |
| `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENVIRONMENT` | server-side Paddle transaction creation and signed webhook receipt; optional while checkout is disabled |

Both secrets are mandatory in production: `apps/api/src/env.ts` only falls back to
insecure defaults outside production, so the service refuses to boot without them.

### Paddle billing (guarded until merchant acceptance)

Checkout has two independent gates: valid Paddle configuration and the Platform
Settings checkout switch. Leave the switch off while configuring sandbox. Add one
active USD `pri_…` id per sellable plan/interval in Platform → Plans, set the Paddle
default payment link to the web app's `/plan` page, and point a Paddle notification
destination at `POST /v1/webhooks/paddle`. The web deployment also needs the public
`NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` and matching `NEXT_PUBLIC_PADDLE_ENVIRONMENT`.

The `work` pass now reconciles the verified webhook inbox before delivering outbox
events. A running API without that scheduled pass will acknowledge Paddle events but
will not change subscriptions, which is why the checkout switch must stay off while
the hosted schedule below is paused. Before enabling checkout, prove purchase,
renewal, failed payment, cancellation, refund and replay in Paddle sandbox, then
repeat the production smoke test after seller KYC and payout setup.

Before public release, run the compiled launch gate with the deployment's real
environment and database. Manual claims are supplied as a dated evidence file;
the command exits non-zero for any automated blocker or missing attestation. See
[`docs/operations/launch-readiness.md`](docs/operations/launch-readiness.md).

```bash
pnpm --filter @crewquo/api build
pnpm --filter @crewquo/api launch-check -- --evidence /path/to/launch-evidence.json
```

### The scheduler (required in production — currently PAUSED, and run by hand)

Four jobs are one-shot and run from outside the API, so that a dead job is
restarted by a scheduler rather than silently stopping with one process:

| Command | Cadence | What stops without it |
| --- | --- | --- |
| `pnpm --filter @crewquo/api work` | every 5 min | **every notification, on every channel** — the outbox never drains |
| `pnpm --filter @crewquo/api purge-audit` | daily | audit retention, which is a sold entitlement |
| `pnpm --filter @crewquo/api purge-auth` | daily | sign-in counters, old session rows, job-run history |
| `pnpm --filter @crewquo/api run-closures` | hourly | due account/company closures **and their one-day-out warning**, so a cooling-off window never ends |

> **⚠️ The hosted schedule is paused, and while data is local it stays paused.** The
> `cron:` triggers in
> [`scheduled-jobs.yml`](.github/workflows/scheduled-jobs.yml) are commented out.
> That workflow is the only thing in the repo that runs against a remote
> `DATABASE_URL`, so switching it on means standing up the hosted database the
> data-locality decision above defers — it is not a one-line uncomment.
>
> **Run the passes against your local stack instead.** They are ordinary commands and
> need nothing but `.env`:
>
> ```bash
> pnpm --filter @crewquo/api work            # or: -- --loop, to keep draining
> pnpm --filter @crewquo/api run-closures
> pnpm --filter @crewquo/api purge-audit
> pnpm --filter @crewquo/api purge-auth
> ```
>
> Nothing is silently broken meanwhile: `job_runs` and the **Scheduled jobs** row on
> `/v1/admin/operations` will report every job as overdue, which is the dead man's
> switch telling the truth rather than misfiring.

When the schedule is eventually restored,
[`.github/workflows/scheduled-jobs.yml`](.github/workflows/scheduled-jobs.yml)
runs them ([the host decision and its costs](docs/operating-model/observability-data-lifecycle.md)).
It needs these **repository secrets** (Settings → Secrets and variables →
Actions). Only the first is required; a run without it fails loudly and says so,
rather than looking like a scheduler with nothing to do:

| Secret | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | **yes** | the **External** connection string, not the internal one — the runner is outside Render's network |
| `APP_BASE_URL` | recommended | notification deep links; defaults to `http://localhost:3000` |
| `RESEND_API_KEY` | recommended | omit and emails record as `SKIPPED` with that reason rather than sending |
| `NOTIFICATION_FROM_EMAIL` | recommended | must be on a domain verified at resend.com/domains |

**The signing secrets are deliberately not on that list.** The workflow sets
`CREWQUO_PROCESS=job`, and a job process holds no signing key: these jobs mint and
verify no token, and the only reason they ever needed `JWT_ACCESS_SECRET` was that
`env.ts` validated it at import for every process alike. Copying production
signing keys into Actions to satisfy a validator would put them where any
collaborator able to push a workflow file could read them back — a real exposure
bought for nothing. If a job ever does need to sign, it throws on the line that
tries rather than minting tokens no verifier accepts.

**Two things about this host, worth knowing before you rely on it.** GitHub's
`schedule` is best-effort and skews under load, so "every 5 minutes" means
"usually" — the overdue deadlines are four intervals wide for that reason. And a
`schedule` trigger is **disabled automatically after 60 days without repository
activity**, which is a silent stop; `workflow_dispatch` is on the workflow partly
so a manual run can reset that clock.

**Watch the alarm, not the cron.** `GET /v1/admin/operations` carries a
**Scheduled jobs** row computed from the last successful pass of each job, and it
reads *overdue* — not *unknown* — when a job has never succeeded, which is the
state a deployment is in when the schedule was never wired up. A queue depth is
only meaningful next to evidence that something is draining it: three pending
outbox events look like a quiet week whether the drain ran a minute ago or has not
run since the workflow was disabled.

### Rotating a signing secret

Access tokens and single-purpose links carry a `kid` header naming the key that
signed them, and are verified against a small ring rather than one secret
([access.md](docs/operating-model/access.md) §14 step 4). So a rotation is three
deploys with nobody signed out, instead of an event that logs the whole platform
out at once:

1. `JWT_ACCESS_SECRET_RETIRED=<the new secret>` — deploy. Both keys now verify;
   nothing is signed with the new one yet.
2. Move that value into `JWT_ACCESS_SECRET`, and put the **old** one in
   `JWT_ACCESS_SECRET_RETIRED` — deploy. New tokens carry the new `kid`; every
   token already in someone's browser still verifies.
3. Wait `ACCESS_TOKEN_TTL_SECONDS` (15 minutes by default), then clear
   `JWT_ACCESS_SECRET_RETIRED` — deploy. The old key is gone.

`JWT_REFRESH_SECRET_RETIRED` is the same for the refresh secret, which signs no
refresh token (those are opaque) but does sign password-reset links — so step 3
waits out the link TTL rather than the access-token one.

**`AUTH_SOURCE_PEPPER` must be set before rotating `JWT_REFRESH_SECRET`.** The rate
limiter salts its source-address hashes, and until the pepper has its own value it
borrows that secret — so rotating without it silently resets every rate-limit
budget mid-flight.

Migrations run in the start command rather than a `preDeployCommand`, which needs a
paid instance. They are forward-only and tracked, so re-running on each boot is a
no-op. Don't move them into the build command — build containers can't reach the
database's internal URL.

Migrations run automatically before each deploy takes traffic (`preDeployCommand`).

### Web console → Vercel

Create the project from this repo, then in **Settings → General**:

| Setting | Value |
| --- | --- |
| Root Directory | `apps/web` |
| Framework Preset | Next.js |
| Build / Install Command | leave as the defaults |

Root Directory is the one that matters; Vercel detects Next.js on its own once it
points at `apps/web`. Left at the repo root, Vercel builds the monorepo through
turbo and then fails with `No entrypoint found. Searched for: app.*, index.*,
server.*` — that is Vercel's *Node server* builder hunting for something to run,
having never recognised this as a Next.js app.

Two settings-page gotchas, both of which cost us a round trip:

- Changing Root Directory does **not** rebuild anything. Production keeps serving
  the last *successful* deployment, so a fixed setting can sit behind a months-old
  broken build. Deployments → ⋯ → **Redeploy**, cache off.
- **Skip deployments when there are no changes to the root directory** means a push
  touching only `README.md`, `render.yaml` or `apps/api` never triggers a web build
  at all.

The app is entirely client components with no server-side fetching, so every route
prerenders static and is served from the CDN. If you ever see
`FUNCTION_INVOCATION_FAILED` on this project, it is not this app — it is a stale
deployment from some earlier configuration.

And in **Settings → Environment Variables**:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | the Render API URL, e.g. `https://crewquo-api.onrender.com` |
| `NEXT_PUBLIC_SENTRY_DSN` | optional browser DSN; without it web tracking is inert |
| `NEXT_PUBLIC_SENTRY_RELEASE` | the same commit/tag used by the API release |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | `0` by default; a fraction from 0 to 1 when tracing is deliberately enabled |

For server-rendering errors, set `SENTRY_DSN`, `SENTRY_RELEASE` and
`SENTRY_TRACES_SAMPLE_RATE` on Vercel as well. Source-map upload additionally
requires `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT`; without the token
the build disables uploading rather than making a failing network call.

`NEXT_PUBLIC_*` is inlined at build time, not read at runtime — set it before you
build, and redeploy after changing it, or the browser will keep calling
`http://localhost:4000`.

## Notes

- Production runs the compiled files in `apps/api/dist`; `tsx` is confined to development and repository utilities. Render builds all HTTP and scheduled-job entry points before starting the service. The local Docker stack intentionally uses `start:source`, so a source edit still needs only `docker compose restart api` rather than an image rebuild.
- CI runs focused type-aware ESLint, TypeScript and unit tests. API verification scripts are included in the API TypeScript project.
