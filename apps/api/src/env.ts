import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load the single repo-root .env regardless of the process working directory.
const here = dirname(fileURLToPath(import.meta.url)); // apps/api/src
config({ path: resolve(here, '../../../.env') });

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[api] Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  console.error('Hint: copy .env.example to .env at the repo root and fill it in.');
  process.exit(1);
}

export const env = parsed.data;
