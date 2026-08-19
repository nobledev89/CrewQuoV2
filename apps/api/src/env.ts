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

// In dev/test we fall back to fixed non-secret values so the API boots without a
// fully populated .env. In production these MUST be provided or the app exits.
const secret = (key: string) =>
  isProd
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

  // Auth (§5). Access token 15 min, refresh 30 days.
  JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
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
