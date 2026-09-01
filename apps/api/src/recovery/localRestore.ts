const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const SCRATCH_PREFIX = 'crewquo_restore_rehearsal_';

export type LocalDatabaseTarget = {
  database: string;
  host: string;
  port: number;
  username: string;
  connectionStringFor(database: string): string;
};

/**
 * A restore rehearsal is destructive to its scratch database. Keep the local
 * command incapable of being pointed at a hosted database by configuration or
 * typo; production recovery uses the host console and the reviewed runbook.
 */
export function parseLocalDatabaseTarget(value: string): LocalDatabaseTarget {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid Postgres URL');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('Local restore rehearsal refuses a non-loopback DATABASE_URL');
  }

  const database = decodeURIComponent(url.pathname.slice(1));
  const username = decodeURIComponent(url.username);
  const port = url.port === '' ? 5432 : Number(url.port);
  if (!database || database === 'postgres' || database.startsWith('template')) {
    throw new Error('Local restore rehearsal requires an application database');
  }
  if (!username) throw new Error('DATABASE_URL must include a database user');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('DATABASE_URL contains an invalid port');
  }

  return {
    database,
    host: url.hostname,
    port,
    username,
    connectionStringFor(nextDatabase: string) {
      const copy = new URL(url);
      copy.pathname = `/${encodeURIComponent(nextDatabase)}`;
      return copy.toString();
    },
  };
}

export function makeScratchDatabaseName(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  return `${SCRATCH_PREFIX}${stamp}_${nonce}`;
}

export function isSafeScratchDatabaseName(value: string): boolean {
  return /^crewquo_restore_rehearsal_\d{14}_[a-f0-9]{8}$/.test(value);
}

/** Identifiers below come from pg_catalog, but quote them at the SQL boundary. */
export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

