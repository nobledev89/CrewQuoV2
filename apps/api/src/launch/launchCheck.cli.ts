import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db';
import {
  evaluateLaunchReadiness,
  launchEvidenceSchema,
  summarizeLaunchReadiness,
  type LaunchEvidence,
} from './readiness';
import { readLaunchReadinessFacts } from './readiness.repo';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MIGRATIONS_DIRECTORY = resolve(REPO_ROOT, 'infra/migrations');

function evidenceArgument(argv: readonly string[]): string | null {
  const index = argv.indexOf('--evidence');
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--evidence requires a path to a JSON evidence file');
  }
  return resolve(process.cwd(), value);
}

async function readEvidence(path: string | null): Promise<LaunchEvidence> {
  if (!path) return {};
  const raw = await readFile(path, 'utf8');
  return launchEvidenceSchema.parse(JSON.parse(raw) as unknown);
}

async function expectedMigrations(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIRECTORY))
    .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
    .sort();
}

function marker(status: 'PASS' | 'BLOCKED' | 'MANUAL'): string {
  if (status === 'PASS') return 'PASS   ';
  if (status === 'BLOCKED') return 'BLOCK ';
  return 'MANUAL ';
}

async function main(): Promise<void> {
  const evidencePath = evidenceArgument(process.argv.slice(2));
  const [evidence, migrations] = await Promise.all([
    readEvidence(evidencePath),
    expectedMigrations(),
  ]);
  const facts = await readLaunchReadinessFacts(migrations);
  const checks = evaluateLaunchReadiness(facts, evidence);
  const summary = summarizeLaunchReadiness(checks);

  console.log('CrewQuo production launch readiness');
  console.log('===================================');
  for (const check of checks) {
    console.log(`${marker(check.status)} ${check.label}`);
    console.log(`        ${check.detail}`);
  }
  console.log('-----------------------------------');
  console.log(
    `${summary.passed} passed, ${summary.blocked} blocked, ${summary.manual} awaiting evidence.`
  );
  console.log(summary.ready ? 'READY TO LAUNCH' : 'NOT READY TO LAUNCH');

  if (!summary.ready) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('[launch-check] Could not evaluate readiness.');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
