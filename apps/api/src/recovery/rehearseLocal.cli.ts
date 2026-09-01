import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pg from 'pg';
import {
  isSafeScratchDatabaseName,
  makeScratchDatabaseName,
  parseLocalDatabaseTarget,
  quoteIdentifier,
} from './localRestore';

const { Client } = pg;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
config({ path: resolve(REPO_ROOT, '.env') });
const COMPOSE_ARGS = ['compose', '--env-file', '.env', '-f', 'infra/docker-compose.yml'];

type TableCount = { table: string; rows: number };

function dockerCompose(args: string[], options?: { stdinFile?: string; stdoutFile?: string }) {
  const child = spawn('docker', [...COMPOSE_ARGS, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    shell: false,
    stdio: [options?.stdinFile ? 'pipe' : 'ignore', options?.stdoutFile ? 'pipe' : 'inherit', 'inherit'],
  });

  const streams: Promise<unknown>[] = [];
  if (options?.stdinFile && child.stdin) {
    streams.push(pipeline(createReadStream(options.stdinFile), child.stdin));
  }
  if (options?.stdoutFile && child.stdout) {
    streams.push(pipeline(child.stdout, createWriteStream(options.stdoutFile, { flags: 'wx' })));
  }

  return Promise.all([
    new Promise<void>((resolveProcess, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolveProcess();
        else reject(new Error(`docker compose ${args[0] ?? ''} exited with code ${code ?? 'unknown'}`));
      });
    }),
    ...streams,
  ]).then(() => undefined);
}

async function tableCounts(connectionString: string): Promise<TableCount[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tables = await client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`
    );
    const counts: TableCount[] = [];
    for (const { tablename } of tables.rows) {
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count from ${quoteIdentifier(tablename)}`
      );
      counts.push({ table: tablename, rows: Number(result.rows[0]?.count ?? 0) });
    }
    return counts;
  } finally {
    await client.end();
  }
}

function compareCounts(source: TableCount[], restored: TableCount[]): void {
  const sourceJson = JSON.stringify(source);
  const restoredJson = JSON.stringify(restored);
  if (sourceJson !== restoredJson) {
    throw new Error('Restored table inventory or row counts differ from the source database');
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const target = parseLocalDatabaseTarget(databaseUrl);
  const scratchDatabase = makeScratchDatabaseName();
  if (!isSafeScratchDatabaseName(scratchDatabase)) {
    throw new Error('Generated scratch database name failed its own cleanup guard');
  }

  const startedAt = new Date();
  const started = performance.now();
  const outputDirectory = resolve(REPO_ROOT, '.tmp', 'recovery-rehearsals');
  const backupPath = resolve(outputDirectory, `${scratchDatabase}.dump`);
  await mkdir(outputDirectory, { recursive: true });

  let scratchCreated = false;
  try {
    console.log(`[recovery] dumping ${target.database}`);
    await dockerCompose(
      [
        'exec',
        '-T',
        'postgres',
        'pg_dump',
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--username',
        target.username,
        '--dbname',
        target.database,
      ],
      { stdoutFile: backupPath }
    );

    console.log(`[recovery] creating isolated scratch database ${scratchDatabase}`);
    await dockerCompose([
      'exec',
      '-T',
      'postgres',
      'createdb',
      '--username',
      target.username,
      scratchDatabase,
    ]);
    scratchCreated = true;

    console.log('[recovery] restoring backup');
    await dockerCompose(
      [
        'exec',
        '-T',
        'postgres',
        'pg_restore',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--username',
        target.username,
        '--dbname',
        scratchDatabase,
      ],
      { stdinFile: backupPath }
    );

    const [sourceCounts, restoredCounts, backupStats, backupSha256] = await Promise.all([
      tableCounts(databaseUrl),
      tableCounts(target.connectionStringFor(scratchDatabase)),
      stat(backupPath),
      sha256(backupPath),
    ]);
    compareCounts(sourceCounts, restoredCounts);

    const receipt = {
      scope: 'LOCAL_DOCKER_REHEARSAL',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      backupBytes: backupStats.size,
      backupSha256,
      publicTablesVerified: sourceCounts.length,
      result: 'PASS',
      productionRecoveryPromiseDischarged: false,
    } as const;
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    if (scratchCreated) {
      if (!isSafeScratchDatabaseName(scratchDatabase)) {
        throw new Error('Refusing cleanup because the scratch database name is not safe');
      }
      console.log(`[recovery] removing scratch database ${scratchDatabase}`);
      await dockerCompose([
        'exec',
        '-T',
        'postgres',
        'dropdb',
        '--if-exists',
        '--force',
        '--username',
        target.username,
        scratchDatabase,
      ]);
    }
    await rm(backupPath, { force: true });
  }
}

main().catch((error: unknown) => {
  console.error('[recovery] rehearsal failed:', error);
  process.exitCode = 1;
});
