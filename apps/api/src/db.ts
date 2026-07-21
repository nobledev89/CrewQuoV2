import pg from 'pg';
import { env } from './env';

const { Pool } = pg;

export const pool = new Pool({ connectionString: env.DATABASE_URL });

/** Returns true if the database answers a trivial query. Used by /healthz. */
export async function pingDb(): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}
