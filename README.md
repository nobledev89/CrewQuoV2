# CrewQuo v2

Mobile-first contractor / subcontractor management. Postgres + TypeScript API on Render; Expo (mobile) and Next.js (web) clients on the way.

The full specification lives in **[`CREWQUO_V2_PLAN.md`](./CREWQUO_V2_PLAN.md)** and current progress in **[`PROGRESS.md`](./PROGRESS.md)**. Read the plan — and, before implementing the rate engine or authorization, read v1's `functions/src/rates.ts` and `firestore.rules` (from the v1 repo).

## Status

**Phase 3 — The core work loop (shipped).** On top of Phases 0–2 (foundations, identity/auth/entitlements, rate engine + catalog + web console): engagements & the relationship graph, providers/members/invite-accept, projects + assignments, the `DRAFT → SUBMITTED → APPROVED/REJECTED` work workflow with server-computed project summaries (cost + margin), and the mobile log-time → approvals flow with Expo push. Phase 4 (client portal + exports + audit) is next. See [`PROGRESS.md`](./PROGRESS.md).

## Prerequisites

- Node 20+
- pnpm 10+ (`corepack enable`)
- Docker (for local Postgres) — or any Postgres 13+ you point `DATABASE_URL` at

## Getting started

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env          # then edit if needed

# 3. Start local Postgres
docker compose -f infra/docker-compose.yml up -d

# 4. Run database migrations
pnpm db:migrate

# 5. Start the API (http://localhost:4000)
pnpm --filter @crewquo/api dev
# health check:
#   curl http://localhost:4000/healthz   ->  {"status":"ok","db":"up",...}
```

## Useful commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run all apps in dev (turbo) |
| `pnpm type-check` | Type-check every package |
| `pnpm lint` | Run the type-aware promise and React Hooks lint gates |
| `pnpm test` | Run unit tests |
| `pnpm db:migrate` | Apply pending SQL migrations |
| `pnpm db:seed` | Run the seed script |
| `pnpm --filter @crewquo/web dev` | Run the web console (http://localhost:3000) |
| `pnpm --filter @crewquo/api purge-audit` | Delete audit rows past their retention window |
| `pnpm --filter @crewquo/api purge-auth` | Prune rate-limit counters and long-expired sessions |
| `pnpm --filter @crewquo/api work` | Drain the outbox and the notification queue (`-- --loop` locally) |

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
| Build Command | `corepack enable && pnpm install --frozen-lockfile --prod=false` |
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

Both secrets are mandatory in production: `apps/api/src/env.ts` only falls back to
insecure defaults outside production, so the service refuses to boot without them.

### The scheduler (required — nothing works without it)

Three jobs are one-shot and run from outside the API, so that a dead job is
restarted by a scheduler rather than silently stopping with one process:

| Command | Cadence | What stops without it |
| --- | --- | --- |
| `pnpm --filter @crewquo/api work` | every 5 min | **every notification, on every channel** — the outbox never drains |
| `pnpm --filter @crewquo/api purge-audit` | daily | audit retention, which is a sold entitlement |
| `pnpm --filter @crewquo/api purge-auth` | daily | sign-in counters, old session rows, job-run history |

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

`NEXT_PUBLIC_*` is inlined at build time, not read at runtime — set it before you
build, and redeploy after changing it, or the browser will keep calling
`http://localhost:4000`.

## Notes

- The API runs via `tsx` in both dev and production for now; a bundled build step is added when needed. This is why the Render build installs with `--prod=false`: `tsx` is a devDependency, and `NODE_ENV=production` would otherwise make pnpm skip it.
- CI runs focused type-aware ESLint, TypeScript and unit tests. API verification scripts are included in the API TypeScript project.
