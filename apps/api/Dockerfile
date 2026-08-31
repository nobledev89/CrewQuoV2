# The API, containerised for local development.
#
# WHY THIS EXISTS. Until CrewQuo is production ready, every byte of customer-shaped
# data stays on the machine that made it (owner decision 2026-08-31), and the stack
# that holds it should be startable in one command rather than assembled by hand.
# Postgres was already containerised; the API was not, so "the local stack" meant a
# container plus a host process plus whichever `.env` that shell happened to read.
#
# WHY NODE 22 AND NOT THE 20 IN .nvmrc. CI runs `node-version: 22`, and the whole
# point of a container is that the thing you run locally is the thing that gets
# judged. `engines` allows >=20.9.0, so both are legal and the two files disagree —
# worth reconciling, but the version that gates a merge is the one to match here.
#
# WHY THERE IS NO BUILD STEP. `@crewquo/shared` is consumed as *source*: its
# `main` is `./src/index.ts` and `tsx` runs TypeScript directly, so there is no
# `dist` to produce and no stale artifact to get out of step with the source beside
# it. That is also why the mounts in docker-compose.yml are source directories.
FROM node:22-bookworm-slim

# Postgres client libraries are not needed — `pg` is pure JavaScript — but a shell
# with `curl` is, because the healthcheck below is the only thing that can tell
# "still booting" from "booted and broken".
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Manifests before source, so editing a route does not reinstall the dependency
# tree. Every workspace manifest is copied, not just the two this image runs:
# `--frozen-lockfile` validates the lockfile against the workspace it can see, and
# a workspace missing three of its five projects is a workspace the lockfile does
# not describe. Installing web's and mobile's dependencies is the price of the same
# frozen check CI runs, which is the check worth having.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/

RUN pnpm install --frozen-lockfile

# The source the container actually runs. Bind-mounted over at run time by
# docker-compose for hot reload; copied here so the image is runnable on its own,
# which is what makes `docker compose run --rm api ...` work for a one-off job.
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

EXPOSE 4000

# `start` (plain `tsx`), NOT `dev` (`tsx watch`) — and this is the second answer,
# because the first one was a promise the platform does not keep.
#
# `tsx watch` uses Node's `fs.watch`; tsx 4.23 depends on `esbuild` alone and bundles
# no polling watcher. Docker Desktop on Windows does not deliver inotify events across
# a bind mount, so the watcher starts, reports nothing, and never fires. That was
# measured rather than assumed: editing `apps/api/src/app.ts` with `tsx watch` running
# produced no restart in the container log at all.
#
# **A watch that silently does not watch is worse than no watch**, because it invites
# you to believe your edit is live. So this runs the script once and the source mounts
# in docker-compose.yml earn their place a different way: `docker compose restart api`
# picks up an edit in a few seconds without rebuilding the image, which is the loop
# this setup actually offers. For tight iteration, running the API on the host against
# the containerised Postgres is still available and costs nothing in data locality —
# Postgres is the only thing here that stores anything.
CMD ["pnpm", "--filter", "@crewquo/api", "start"]
