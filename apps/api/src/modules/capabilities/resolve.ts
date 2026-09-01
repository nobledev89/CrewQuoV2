import {
  defaultBundleForRole,
  resolveCapabilities as mergeCapabilities,
  type CapabilityKey,
  type MembershipCapabilities,
} from '@crewquo/shared';
import type { Queryable } from '../../db';
import {
  findMembershipForCapabilities,
  findMembershipForUser,
  loadBundleCapabilities,
  loadOverrides,
  type MembershipCapabilityRow,
} from './repo';

/**
 * Resolve effective capabilities for a membership (§37): bundle ⊕ overrides,
 * with a null bundle deriving from the role.
 *
 * Mirrors `resolveEntitlements`, including the part that is deliberately
 * missing. **There is no cache**, for the reason already written down beside the
 * entitlement resolver: a per-process TTL cache can knowingly serve different
 * answers from different API instances, and it depends on every mutation
 * remembering to invalidate. That is a bad trade for a plan and a worse one for
 * a permission, where the stale answer is somebody still able to do a thing they
 * were just stopped from doing. §37 asks for the same TTL as entitlements, and
 * entitlements no longer have one.
 */

export interface ResolvedCapabilities extends MembershipCapabilities {
  companyId: string;
  userId: string;
}

async function resolveForRow(
  row: MembershipCapabilityRow,
  runner?: Queryable
): Promise<ResolvedCapabilities> {
  const derived = row.bundle_key === null;
  const effectiveBundleKey = row.bundle_key ?? defaultBundleForRole(row.role);

  const [bundleCapabilities, overrides] = await Promise.all([
    loadBundleCapabilities(effectiveBundleKey, row.company_id, runner),
    loadOverrides(row.id, runner),
  ]);

  return {
    membershipId: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    role: row.role,
    bundleKey: row.bundle_key,
    effectiveBundleKey,
    bundleIsDerived: derived,
    overrides,
    capabilities: mergeCapabilities({
      role: row.role,
      bundleKey: row.bundle_key,
      bundleCapabilities,
      overrides,
    }),
    locked: row.role === 'OWNER',
  };
}

export async function resolveMembershipCapabilities(
  membershipId: string,
  runner?: Queryable
): Promise<ResolvedCapabilities | null> {
  const row = await findMembershipForCapabilities(membershipId, runner);
  return row ? resolveForRow(row, runner) : null;
}

/**
 * The caller's own capabilities in their active company.
 *
 * A suspended or removed membership resolves to **no capabilities** rather than
 * to its bundle's. `requireAuth` already refuses a request whose membership is
 * not active, so this is defence in depth rather than the only guard — but a
 * resolver that answers "what may this person do" must not answer it as though
 * the person were still employed here.
 */
export async function resolveOwnCapabilities(
  userId: string,
  companyId: string,
  runner?: Queryable
): Promise<CapabilityKey[]> {
  const row = await findMembershipForUser(userId, companyId, runner);
  if (!row || row.status !== 'ACTIVE') return [];
  const resolved = await resolveForRow(row, runner);
  return resolved.capabilities;
}
