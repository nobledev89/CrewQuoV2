import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load the single repo-root .env regardless of the process working directory.
const here = dirname(fileURLToPath(import.meta.url)); // apps/api/src
config({ path: resolve(here, '../../../.env') });

const isProd = process.env.NODE_ENV === 'production';
// vitest sets NODE_ENV=test. Unit tests import modules that pull in this file
// transitively (tokens.ts needs the JWT secrets), so the schema has to be
// satisfiable without a populated .env — CI has none.
const isTest = process.env.NODE_ENV === 'test';

/**
 * What this process is for, which decides whether it needs signing keys at all.
 *
 * `job` is the scheduled one-shot workers — the outbox drain and the two
 * retention passes. **They mint no token of any kind**, and the only reason they
 * ever needed `JWT_ACCESS_SECRET` is that this file validates it at import for
 * every process alike. That incidental coupling had a real cost: it meant the
 * production signing keys had to be copied into the scheduler's environment,
 * where anybody able to push a workflow file could read them back out. A secret
 * that does not need to be somewhere should not be there.
 *
 * Read from the raw environment rather than from the parsed schema because the
 * schema's own shape depends on it.
 */
const processRole = process.env.CREWQUO_PROCESS === 'job' ? 'job' : 'api';

/**
 * What a job process gets instead of a signing key.
 *
 * A sentinel rather than a plausible-looking default, and rather than making the
 * field optional. Optional would ripple `string | undefined` through every call
 * site for a case none of them can encounter; a plausible default is worse than
 * either, because a job that *did* start signing would mint tokens under a key no
 * verifier holds — and those fail later, somewhere else, as "invalid or expired
 * token" on a user's screen. This value is checked where keys are built, so the
 * failure lands on the line that tried to use it, in the process that tried.
 */
export const NO_SIGNING_KEY = 'crewquo:no-signing-key-in-this-process';

// In dev/test we fall back to fixed non-secret values so the API boots without a
// fully populated .env. In production these MUST be provided or the app exits —
// unless this process is a job, which signs nothing and is handed a sentinel that
// throws if anything ever tries.
const secret = (key: string) =>
  processRole === 'job'
    ? z.string().min(1).default(NO_SIGNING_KEY)
    : isProd
      ? z.string().min(16, `${key} must be set (>=16 chars) in production`)
      : z.string().min(1).default(`dev-insecure-${key.toLowerCase()}`);

const EnvSchema = z.object({
  // Nothing under `vitest run` opens a connection — the suites are pure units —
  // so a placeholder keeps a JWT test from depending on local database setup.
  // Dev still fails loudly with the hint below, which is where a missing
  // DATABASE_URL is a real mistake worth catching early.
  DATABASE_URL: isTest
    ? z.string().url().default('postgres://test:test@127.0.0.1:5432/test')
    : z.string().url(),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * `api` (default) serves requests; `job` is a scheduled one-shot worker.
   *
   * The only thing it changes is whether signing keys are required — see the
   * `secret` helper above. Defaulting to `api` is the safe direction: a server
   * mislabelled as a job would fail loudly the first time it signed anything,
   * whereas a job mislabelled as a server merely asks for keys it will not use.
   */
  CREWQUO_PROCESS: z.enum(['api', 'job']).default('api'),

  // Auth (§5). Access token 15 min, refresh 30 days.
  JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),

  /**
   * Previously-current signing secrets, comma-separated, still accepted for
   * verification but never used to sign
   * (`docs/operating-model/access.md` §10, §14 step 4).
   *
   * This is what makes rotating a secret a non-event instead of a mass logout.
   * The procedure is publish → promote → retire: append the new secret here and
   * deploy, move it to `JWT_ACCESS_SECRET` and deploy again, then remove the old
   * value once `ACCESS_TOKEN_TTL_SECONDS` has passed and nothing it signed is
   * still alive. Empty is the steady state — a key list that never empties is a
   * rotation that never finished, and every entry is a secret that can still mint
   * a session if it leaks.
   */
  JWT_ACCESS_SECRET_RETIRED: z.string().default(''),

  /**
   * The same, for the refresh secret — which signs no refresh token.
   *
   * Refresh tokens are opaque and their SHA-256 is the record, so rotating this
   * value cannot invalidate one. What it does sign is the single-purpose tokens:
   * password-reset links, email-verification links and the MFA challenge. Those
   * outlive a deploy — a reset link is good for an hour — so rotating without an
   * overlap window silently breaks every link already sitting in somebody's inbox,
   * and the person holding one is told their link is invalid at the exact moment
   * they cannot sign in to ask why.
   */
  JWT_REFRESH_SECRET_RETIRED: z.string().default(''),

  /**
   * Salt for the rate limiter's source-address hashes
   * (`docs/operating-model/access.md` §7, §10).
   *
   * Its own variable because it is **not** a signing key and must not rotate with
   * one. The limiter stores `sha256(pepper + address)` so it can recognise a
   * caller without recording where anybody signs in from; if the pepper moves,
   * every stored hash stops matching the caller it belongs to and every budget
   * silently resets. Before the ring existed that was harmless — the value never
   * changed. Now that rotating a signing secret is a thing operators are asked to
   * do, a rotation would hand every attacker mid-lockout a fresh set of guesses,
   * which is precisely the kind of quiet coupling that makes the safe procedure
   * unsafe.
   *
   * **Optional, falling back to the refresh secret**, so existing deployments keep
   * the hashes they already have and no rotation is forced by this change. Set it
   * — to any long random string, once, and then never again — before rotating
   * `JWT_REFRESH_SECRET`, or that rotation takes the counters with it.
   */
  AUTH_SOURCE_PEPPER: z.string().optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 60 * 60),

  // Google sign-in (optional until configured; endpoint 501s without it).
  GOOGLE_CLIENT_ID: z.string().optional(),

  // Base URL used in password-reset / verify-email links and notification deep
  // links.
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  // Email delivery (Resend). Both optional: without them the notification worker
  // records each email as SKIPPED with that reason rather than pretending to
  // send, so a dev environment is never mistaken for a working one.
  RESEND_API_KEY: z.string().optional(),
  NOTIFICATION_FROM_EMAIL: z.string().email().optional(),

  /**
   * Comma-separated browser origins allowed to call this API
   * (`docs/operating-model/access.md` §10.4).
   *
   * `APP_BASE_URL` is always allowed and needs no repeating here; this is for the
   * extra ones — a preview deployment, a second domain. Empty is the common case.
   *
   * **Not a wildcard, and deliberately without an escape hatch.** The API used to
   * run `cors()` with no options, which reflects every origin — so any page a
   * signed-in user happened to visit could call it with their bearer token. An
   * env var that accepted `*` would be that hole with an audit trail.
   */
  CORS_EXTRA_ORIGINS: z.string().default(''),

  /**
   * Trusted reverse-proxy hops in front of the API, for `req.ip`.
   *
   * Matters to rate limiting rather than to routing: behind a proxy every request
   * arrives from the proxy's address, so a source-keyed budget would see the whole
   * internet as one caller and lock everybody out together. Left at 0 by default
   * because trusting a header nobody set lets a caller *forge* their source and
   * escape the budget entirely — the failure runs in both directions, so it has to
   * be stated per deployment rather than guessed.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[api] Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  console.error('Hint: copy .env.example to .env at the repo root and fill it in.');
  // Throw rather than exit. process.exit kills the host before it can report
  // anything useful: a test runner shows "process.exit unexpectedly called with
  // 1", and a serverless host shows only FUNCTION_INVOCATION_FAILED. A thrown
  // error carries the field names into the log, which is the whole point of
  // validating here. Local dev still gets the friendly hint printed above first.
  const missing = Object.keys(parsed.error.flatten().fieldErrors).join(', ');
  throw new Error(`[api] Invalid environment configuration: ${missing}`);
}

export const env = parsed.data;
export type Env = typeof env;
