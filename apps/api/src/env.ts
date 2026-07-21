import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load the single repo-root .env regardless of the process working directory.
const here = dirname(fileURLToPath(import.meta.url)); // apps/api/src
config({ path: resolve(here, '../../../.env') });

const isProd = process.env.NODE_ENV === 'production';

// In dev/test we fall back to fixed non-secret values so the API boots without a
// fully populated .env. In production these MUST be provided or the app exits.
const secret = (key: string) =>
  isProd
    ? z.string().min(16, `${key} must be set (>=16 chars) in production`)
    : z.string().min(1).default(`dev-insecure-${key.toLowerCase()}`);

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Auth (§5). Access token 15 min, refresh 30 days.
  JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 60 * 60),

  // Google sign-in (optional until configured; endpoint 501s without it).
  GOOGLE_CLIENT_ID: z.string().optional(),

  // Base URL used in password-reset / verify-email links (Resend arrives Phase 5).
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[api] Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  console.error('Hint: copy .env.example to .env at the repo root and fill it in.');
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
