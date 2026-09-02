import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_KEYS,
  SYSTEM_BUNDLE_CAPABILITIES,
  SYSTEM_BUNDLE_KEYS,
  type CapabilityKey,
  type SystemBundleKey,
} from '@crewquo/shared';

/**
 * The seed and the code must agree about what a bundle grants.
 *
 * §37's bundles live in two places on purpose — the keys in code because adding
 * one needs an enforcement hook, the membership in Postgres because a company
 * builds its own without a deploy. That split is right and it is also exactly
 * how a drifting duplicate starts: a capability added to `admin` in the migration
 * and not to `SYSTEM_BUNDLE_CAPABILITIES` is a permission that exists in
 * production and in no test.
 *
 * So this reads the migrations themselves. It is not elegant, and the alternative —
 * asserting against a live database — cannot run in CI without one, which means
 * it would not run on the pull request that introduced the drift.
 *
 * **It reads every migration, not only `0026`**, and that changed with Phase 9.
 * The capability layer landed whole in `0026` and the vocabulary is not frozen:
 * `0040` adds `sustainability.write` in the migration that creates the table it
 * governs, which is where a capability belongs — beside the thing it protects,
 * rather than in a catalog migration somebody has to remember to amend. Scanning
 * the directory means the next phase to do the same does not break this test for
 * the wrong reason.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../../../../../infra/migrations');

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/** Migration `0026`, which owns the layer's shape and is asserted about directly. */
const sql = readFileSync(join(migrationsDir, '0026_capabilities.sql'), 'utf8');

/**
 * Every statement in the whole directory that begins with `startsWith`.
 *
 * Slicing to the terminating semicolon matters more than it looks: the first
 * version of this file matched `('key', '` across the whole file, so the *bundle*
 * rows were read as capability rows and the suite reported that `admin` was an
 * unknown capability. A parser that cannot tell two insert lists apart proves
 * nothing about either.
 */
function statements(startsWith: string): string[] {
  const found: string[] = [];
  for (const file of files) {
    const content = readFileSync(join(migrationsDir, file), 'utf8');
    let from = 0;
    for (;;) {
      const start = content.indexOf(startsWith, from);
      if (start < 0) break;
      const end = content.indexOf(';', start);
      if (end < 0) throw new Error(`Statement "${startsWith}" in ${file} is not terminated`);
      found.push(content.slice(start, end));
      from = end;
    }
  }
  return found;
}

function statementIn(content: string, startsWith: string): string {
  const start = content.indexOf(startsWith);
  if (start < 0) throw new Error(`Migration 0026 has no statement starting "${startsWith}"`);
  const end = content.indexOf(';', start);
  if (end < 0) throw new Error(`Statement "${startsWith}" is not terminated`);
  return content.slice(start, end);
}

const capabilityInserts = statements('insert into capabilities (key, name').join('\n');
const bundleInsert = statementIn(sql, 'insert into capability_bundles (key, name');
const adminInsert = statementIn(
  sql,
  'insert into capability_bundle_items (bundle_key, capability_key)\nselect'
);
const itemInserts = statements(
  'insert into capability_bundle_items (bundle_key, capability_key) values'
).join('\n');

/** The first quoted value of every row tuple in an insert's VALUES list. */
function firstColumnOf(block: string): string[] {
  return [...block.matchAll(/\(\s*'([a-z][a-z._]*)'\s*,/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

describe('the capability migrations and SYSTEM_BUNDLE_CAPABILITIES', () => {
  const seededCapabilities = firstColumnOf(capabilityInserts);
  const seededBundles = firstColumnOf(bundleInsert);

  const bundleItems = new Map<string, Set<string>>();
  for (const [, bundleKey, capabilityKey] of itemInserts.matchAll(
    /\(\s*'([a-z_]+)'\s*,\s*'([a-z.]+)'\s*\)/g
  )) {
    if (!bundleKey || !capabilityKey) continue;
    if (!bundleItems.has(bundleKey)) bundleItems.set(bundleKey, new Set());
    bundleItems.get(bundleKey)?.add(capabilityKey);
  }

  it('seeds every capability key the code knows about', () => {
    expect([...new Set(seededCapabilities)].sort()).toEqual([...CAPABILITY_KEYS].sort());
  });

  it('seeds no capability key the code does not know about', () => {
    // The direction that matters more: a key in `capabilities` with no entry in
    // `CAPABILITY_KEYS` can be granted through a bundle and can never be checked
    // by a route, because no route can name it.
    for (const key of seededCapabilities) {
      expect(CAPABILITY_KEYS).toContain(key as CapabilityKey);
    }
  });

  it('creates exactly the system bundles the code declares', () => {
    expect([...seededBundles].sort()).toEqual([...SYSTEM_BUNDLE_KEYS].sort());
  });

  // `admin` is seeded from the catalog in 0026 rather than as literal tuples, so
  // its 0026 membership has nothing to compare here; it is covered by the two
  // assertions below.
  const explicit = SYSTEM_BUNDLE_KEYS.filter((k): k is SystemBundleKey => k !== 'admin');

  it.each(explicit)('%s grants exactly what the code says it grants', (bundleKey) => {
    const seeded = [...(bundleItems.get(bundleKey) ?? [])].sort();
    const declared = [...SYSTEM_BUNDLE_CAPABILITIES[bundleKey]].sort();
    expect(seeded).toEqual(declared);
  });

  it('seeds admin from the catalog rather than by hand', () => {
    // A hand-written admin list is a list somebody forgets to extend, and the
    // bundle whose whole definition is "everything" is the worst one to get
    // wrong — it is what every OWNER and ADMIN derives.
    expect(adminInsert).toMatch(/select\s+'admin',\s*key\s+from\s+capabilities/);
    expect(statementIn(sql, 'insert into capability_bundle_items (bundle_key, capability_key) values'))
      .not.toMatch(/\(\s*'admin'\s*,/);
  });

  it('grants admin every key added after 0026, since the catalog select already ran', () => {
    /*
     * The half a directory scan makes checkable, and the reason it is worth
     * checking. `0026`'s `select 'admin', key from capabilities` ran against the
     * catalog as it stood that day, so a capability created by a LATER migration
     * reaches admin only if that migration says so — and a key admin does not hold
     * is a key the company owner cannot use or delegate, which presents as "the
     * feature is broken for everyone" rather than as a permissions problem.
     */
    const adminGrants = bundleItems.get('admin') ?? new Set<string>();
    const declaredElsewhere = new Set(
      CAPABILITY_KEYS.filter((key) => !sql.includes(`('${key}',`))
    );
    for (const key of declaredElsewhere) {
      expect(adminGrants, `${key} was added after 0026 and admin must be granted it`).toContain(key);
    }
    for (const key of adminGrants) {
      expect(CAPABILITY_KEYS).toContain(key as CapabilityKey);
    }
  });

  it('assigns no bundle to any existing membership', () => {
    // The line that makes this migration behaviour-preserving. A backfill would
    // freeze today's role-derived answer as an explicit assignment, and a later
    // correction to the default mapping would then reach nobody.
    expect(sql).not.toMatch(/update\s+memberships\s+set\s+bundle_key/i);
    expect(sql).toMatch(/add column if not exists bundle_key text references capability_bundles/);
  });
});
