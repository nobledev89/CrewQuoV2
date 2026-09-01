import {
  capabilityKeySchema,
  type CapabilityKey,
  type CapabilityOverride,
  type MembershipRole,
} from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * Persistence for the §37 capability layer. Reads only what the resolver needs
 * and nothing more — the catalog is a separate, cacheable read because it is the
 * same answer for every caller in the product.
 */

export interface MembershipCapabilityRow {
  id: string;
  company_id: string;
  user_id: string;
  role: MembershipRole;
  status: string;
  bundle_key: string | null;
}

export function findMembershipForCapabilities(
  membershipId: string,
  runner?: Queryable
): Promise<MembershipCapabilityRow | null> {
  return queryOne<MembershipCapabilityRow>(
    `select id, company_id, user_id, role, status, bundle_key
       from memberships where id = $1`,
    [membershipId],
    runner
  );
}

export function findMembershipForUser(
  userId: string,
  companyId: string,
  runner?: Queryable
): Promise<MembershipCapabilityRow | null> {
  return queryOne<MembershipCapabilityRow>(
    `select id, company_id, user_id, role, status, bundle_key
       from memberships where user_id = $1 and company_id = $2`,
    [userId, companyId],
    runner
  );
}

/**
 * The capabilities of one bundle.
 *
 * The company scope is checked here rather than by the caller because this is
 * the only place a bundle key is turned into permissions: a company bundle
 * belonging to somebody else must resolve to nothing, not to its owner's grants.
 * A system bundle (`company_id is null`) is visible to everybody by design.
 */
export async function loadBundleCapabilities(
  bundleKey: string,
  companyId: string,
  runner?: Queryable
): Promise<CapabilityKey[]> {
  const rows = await query<{ capability_key: string }>(
    `select i.capability_key
       from capability_bundle_items i
       join capability_bundles b on b.key = i.bundle_key
      where i.bundle_key = $1
        and (b.company_id is null or b.company_id = $2)`,
    [bundleKey, companyId],
    runner
  );
  return keysOf(rows.map((r) => r.capability_key));
}

export async function loadOverrides(
  membershipId: string,
  runner?: Queryable
): Promise<CapabilityOverride[]> {
  const rows = await query<{ capability_key: string; granted: boolean; note: string | null }>(
    `select capability_key, granted, note
       from membership_capability_overrides
      where membership_id = $1
      order by capability_key asc`,
    [membershipId],
    runner
  );
  const out: CapabilityOverride[] = [];
  for (const row of rows) {
    const parsed = capabilityKeySchema.safeParse(row.capability_key);
    // A key retired from the code list is ignored rather than crashing a request.
    // The row stays: deleting somebody's recorded exception because a deploy no
    // longer recognises it would be a silent permission change.
    if (parsed.success) out.push({ capabilityKey: parsed.data, granted: row.granted, note: row.note });
  }
  return out;
}

export interface CapabilityCatalogRow {
  key: CapabilityKey;
  name: string;
  description: string | null;
  category: string;
}

export async function loadCapabilityCatalog(runner?: Queryable): Promise<CapabilityCatalogRow[]> {
  const rows = await query<{
    key: string;
    name: string;
    description: string | null;
    category: string;
  }>(`select key, name, description, category from capabilities order by sort_order asc, key asc`, [], runner);
  return rows.flatMap((r) => {
    const parsed = capabilityKeySchema.safeParse(r.key);
    return parsed.success
      ? [{ key: parsed.data, name: r.name, description: r.description, category: r.category }]
      : [];
  });
}

export interface BundleRow {
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
  capabilities: CapabilityKey[];
}

/** System bundles plus this company's own, each with its capability list. */
export async function loadBundles(companyId: string, runner?: Queryable): Promise<BundleRow[]> {
  const rows = await query<{
    key: string;
    name: string;
    description: string | null;
    is_system: boolean;
    capability_keys: string[] | null;
  }>(
    `select b.key, b.name, b.description, b.is_system,
            array_remove(array_agg(i.capability_key order by i.capability_key), null) as capability_keys
       from capability_bundles b
       left join capability_bundle_items i on i.bundle_key = b.key
      where b.company_id is null or b.company_id = $1
      group by b.key, b.name, b.description, b.is_system
      order by b.is_system desc, b.key asc`,
    [companyId],
    runner
  );
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    is_system: r.is_system,
    capabilities: keysOf(r.capability_keys ?? []),
  }));
}

/** Does this bundle key exist and is it usable by this company? */
export async function bundleIsAvailable(
  bundleKey: string,
  companyId: string,
  runner?: Queryable
): Promise<boolean> {
  const row = await queryOne<{ key: string }>(
    `select key from capability_bundles
      where key = $1 and (company_id is null or company_id = $2)`,
    [bundleKey, companyId],
    runner
  );
  return row !== null;
}

export async function setMembershipBundle(
  membershipId: string,
  bundleKey: string | null,
  runner?: Queryable
): Promise<void> {
  await query(`update memberships set bundle_key = $2, updated_at = now() where id = $1`, [
    membershipId,
    bundleKey,
  ], runner);
}

/**
 * Replace the whole override set for a membership.
 *
 * Whole-set replacement rather than per-key patching, deliberately: the screen
 * that edits these shows every exception at once, so a partial update would make
 * "remove this exception" indistinguishable from "leave it alone" in the request
 * body. The delete and the insert share a transaction from the caller.
 */
export async function replaceOverrides(
  membershipId: string,
  overrides: readonly CapabilityOverride[],
  actorUserId: string,
  runner?: Queryable
): Promise<void> {
  await query(`delete from membership_capability_overrides where membership_id = $1`, [membershipId], runner);
  if (overrides.length === 0) return;

  const values: unknown[] = [membershipId, actorUserId];
  const tuples = overrides.map((o) => {
    values.push(o.capabilityKey, o.granted, o.note ?? null);
    const i = values.length;
    return `($1, $${i - 2}, $${i - 1}, $${i}, $2)`;
  });
  await query(
    `insert into membership_capability_overrides
       (membership_id, capability_key, granted, note, created_by_user_id)
     values ${tuples.join(', ')}`,
    values,
    runner
  );
}

function keysOf(raw: readonly string[]): CapabilityKey[] {
  return raw.flatMap((k) => {
    const parsed = capabilityKeySchema.safeParse(k);
    return parsed.success ? [parsed.data] : [];
  });
}
