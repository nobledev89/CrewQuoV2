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
| `pnpm test` | Run unit tests |
| `pnpm db:migrate` | Apply pending SQL migrations |
| `pnpm db:seed` | Run the seed script |
| `pnpm --filter @crewquo/web dev` | Run the web console (http://localhost:3000) |
| `pnpm --filter @crewquo/api purge-audit` | Delete audit rows past their retention window |

The API also runs the audit purge daily in-process; set `AUDIT_PURGE_ENABLED=false`
to drive it from an external scheduler with the command above instead.

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
| `APP_BASE_URL` | the Vercel URL below |

Both secrets are mandatory in production: `apps/api/src/env.ts` only falls back to
insecure defaults outside production, so the service refuses to boot without them.

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
- ESLint is intentionally not wired up yet (added in a later step); `type-check` + `test` are the current CI gates.
