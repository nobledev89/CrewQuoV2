import type { Entitlements } from '@crewquo/shared';
import { resolveEntitlementsFromDb } from './repo';

/**
 * Resolve effective entitlements from the source of truth.
 *
 * The previous per-process TTL cache could knowingly serve different answers
 * from different API instances and depended on every mutation remembering a
 * manual invalidation call. CrewQuo resolves directly from Postgres until a
 * shared, revision-validated cache is justified by measured load.
 */
export function resolveEntitlements(companyId: string): Promise<Entitlements> {
  return resolveEntitlementsFromDb(companyId);
}
