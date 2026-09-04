import pg from 'pg';
import { env } from './env';

const { Pool } = pg;

/**
 * One pool per process: the API holds one for its lifetime, and each one-shot
 * job holds another for the length of its run. The ceiling below is therefore
 * per-process rather than per-deployment — the API and the scheduler each open
 * up to `max` connections against the same database.
 *
 * The three non-default values are all the same point: a connection is
 * expensive to open and cheap to keep. `idleTimeoutMillis` defaults to ten
 * seconds, which on a quiet service means the pool is empty again between
 * visitors, so nearly every request pays a fresh TCP handshake, TLS negotiation
 * and Postgres auth before its first query runs. Sixty seconds spans the gaps
 * that occur in ordinary traffic. The one-shot jobs are unaffected: both CLIs
 * call `pool.end()` in a `finally`, and that closes idle clients immediately
 * rather than waiting the timeout out.
 *
 * `keepAlive` matters *because* connections now live longer. An idle socket can
 * be dropped by something in the middle without either end being told, and
 * without it the pool eventually hands that dead socket to a query.
 *
 * `connectionTimeoutMillis` defaults to 0, which means wait forever. A request
 * that cannot get a connection should fail rather than hang — `/healthz` most
 * of all, because a health check that never answers is read as a timeout by the
 * platform anyway, only later and with nothing to say about why.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

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
