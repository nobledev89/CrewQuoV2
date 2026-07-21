import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Forward-only SQL migration runner. Applies every unapplied `NNNN_*.sql` file
 * in this directory, in filename order, each inside its own transaction, and
 * records it in `schema_migrations`. See CREWQUO_V2_PLAN.md §10.
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
    await client.query(`
      create table if not exists schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      );
    `);

    const appliedResult = await client.query<{ filename: string }>(
      'select filename from schema_migrations'
    );
    const applied = new Set(appliedResult.rows.map((r) => r.filename));

    const files = readdirSync(here)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = readFileSync(join(here, file), 'utf8');
      process.stdout.write(`applying ${file} ... `);

      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations(filename) values ($1)', [file]);
        await client.query('commit');
        console.log('ok');
        count++;
      } catch (err) {
        await client.query('rollback');
        console.log('FAILED');
        throw err;
      }
    }

    console.log(count === 0 ? 'No new migrations to apply.' : `Applied ${count} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
