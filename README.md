# CrewQuo v2

Mobile-first contractor / subcontractor management. Postgres + TypeScript API on Render; Expo (mobile) and Next.js (web) clients on the way.

The full specification lives in **`CREWQUO_V2_PLAN.md`** (in the v1 repo). Read it — and, before implementing the rate engine or authorization, read v1's `functions/src/rates.ts` and `firestore.rules`.

## Status

**Phase 0 — Foundations (scaffold).** Working monorepo, a running API with `/healthz`, and a Postgres migration runner. Phase 1 (identity, auth, entitlements) is next.

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

## Layout

```
apps/
  api/            Express 5 + node-postgres API (Render)
packages/
  shared/         Zod schemas, domain enums, (soon) the rate engine — pure TS
infra/
  migrations/     Forward-only SQL migrations + runner
  seed/           Seed scripts
  docker-compose.yml   Local Postgres
  render.yaml     Render blueprint (API + Postgres)
```

## Notes

- The API runs via `tsx` in both dev and production for now; a bundled build step is added when needed.
- ESLint is intentionally not wired up yet (added in a later step); `type-check` + `test` are the current CI gates.
