import type { Entitlements } from '@crewquo/shared';
import { resolveEntitlementsFromDb } from './repo';

/**
 * Entitlement cache. Redis lands in Phase 2 (§2 stack table); until then a small
 * in-process TTL map fronts the resolver. The interface is intentionally the
 * shape a Redis-backed implementation will satisfy, so swapping is a one-file change.
 */
const TTL_MS = 60_000;

interface Entry {
  value: Entitlements;
  expiresAt: number;
}

const store = new Map<string, Entry>();

/** Resolve entitlements for a company, memoized for TTL_MS. */
export async function resolveEntitlements(companyId: string): Promise<Entitlements> {
  const hit = store.get(companyId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const value = await resolveEntitlementsFromDb(companyId);
  store.set(companyId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

/** Invalidate a company's cached entitlements (on plan/override/subscription change). */
export function invalidateEntitlements(companyId: string): void {
  store.delete(companyId);
}

/** Clear the whole cache (e.g. after a bulk plan edit). */
export function clearEntitlementsCache(): void {
  store.clear();
}
