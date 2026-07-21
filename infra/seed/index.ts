import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

/**
 * Seed script. Currently a no-op placeholder — the plans/entitlements seed
 * (Crew/Starter/Pro/Business/Enterprise) lands in Phase 1. See CREWQUO_V2_PLAN.md §5B.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env at the repo root.');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    console.log('Seed: nothing to seed yet (plans/entitlements arrive in Phase 1).');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
