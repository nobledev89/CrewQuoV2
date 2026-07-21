import pg from 'pg';
import { env } from './env';

const { Pool } = pg;

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export type Queryable = Pick<pg.PoolClient, 'query'> | pg.Pool;

/** Run a query and return all rows, typed. Accepts the pool or a tx client. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  runner: Queryable = pool
): Promise<T[]> {
  const result = await runner.query<T>(text, params as never[]);
  return result.rows;
}

/** Return the first row or null. */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  runner: Queryable = pool
): Promise<T | null> {
  const rows = await query<T>(text, params, runner);
  return rows[0] ?? null;
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on
 * error. The callback receives a dedicated client — pass it to `query`/`queryOne`.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** Returns true if the database answers a trivial query. Used by /healthz. */
export async function pingDb(): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}
