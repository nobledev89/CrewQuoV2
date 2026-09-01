import { readFileSync } from 'node:fs';
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
 * So this reads the migration itself. It is not elegant, and the alternative —
 * asserting against a live database — cannot run in CI without one, which means
 * it would not run on the pull request that introduced the drift.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(here, '../../../../../infra/migrations/0026_capabilities.sql');
const sql = readFileSync(migrationPath, 'utf8');

/**
 * One statement, from its opening keywords to the terminating semicolon.
 *
 * Slicing matters more than it looks: the first version of this file matched
 * `('key', '` across the whole file, so the *bundle* rows were read as
 * capability rows and the suite reported that `admin` was an unknown capability.
 * A parser that cannot tell two insert lists apart proves nothing about either.
 */
function statement(startsWith: string): string {
  const start = sql.indexOf(startsWith);
  if (start < 0) throw new Error(`Migration 0026 has no statement starting "${startsWith}"`);
  const end = sql.indexOf(';', start);
  if (end < 0) throw new Error(`Statement "${startsWith}" is not terminated`);
  return sql.slice(start, end);
}

const capabilityInsert = statement('insert into capabilities (key, name');
const bundleInsert = statement('insert into capability_bundles (key, name');
const adminInsert = statement('insert into capability_bundle_items (bundle_key, capability_key)\nselect');
const itemInsert = statement('insert into capability_bundle_items (bundle_key, capability_key) values');

/** The first quoted value of every row tuple in an insert's VALUES list. */
function firstColumnOf(block: string): string[] {
  return [...block.matchAll(/\(\s*'([a-z][a-z._]*)'\s*,/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

describe('migration 0026 and SYSTEM_BUNDLE_CAPABILITIES', () => {
  const seededCapabilities = firstColumnOf(capabilityInsert);
  const seededBundles = firstColumnOf(bundleInsert);

  const bundleItems = new Map<string, Set<string>>();
  for (const [, bundleKey, capabilityKey] of itemInsert.matchAll(
    /\(\s*'([a-z_]+)'\s*,\s*'([a-z.]+)'\s*\)/g
  )) {
    if (!bundleKey || !capabilityKey) continue;
    if (!bundleItems.has(bundleKey)) bundleItems.set(bundleKey, new Set());
    bundleItems.get(bundleKey)?.add(capabilityKey);
  }

  it('seeds every capability key the code knows about', () => {
    expect([...seededCapabilities].sort()).toEqual([...CAPABILITY_KEYS].sort());
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

  // `admin` is seeded from the catalog rather than as literal tuples, so it has
  // nothing to compare here and is covered by the assertion below.
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
    expect(bundleItems.has('admin')).toBe(false);
  });

  it('assigns no bundle to any existing membership', () => {
    // The line that makes this migration behaviour-preserving. A backfill would
    // freeze today's role-derived answer as an explicit assignment, and a later
    // correction to the default mapping would then reach nobody.
    expect(sql).not.toMatch(/update\s+memberships\s+set\s+bundle_key/i);
    expect(sql).toMatch(/add column if not exists bundle_key text references capability_bundles/);
  });
});
