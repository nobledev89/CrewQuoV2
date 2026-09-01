import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_KEYS,
  SYSTEM_BUNDLE_CAPABILITIES,
  SYSTEM_BUNDLE_KEYS,
  defaultBundleForRole,
  resolveCapabilities,
  updateMembershipCapabilitiesSchema,
  type CapabilityKey,
} from './capabilities';
import { MEMBERSHIP_ROLES } from './enums';

const worker = SYSTEM_BUNDLE_CAPABILITIES.worker;

describe('the capability catalog', () => {
  it('holds §37\'s 29 keys, with no duplicates', () => {
    expect(CAPABILITY_KEYS).toHaveLength(29);
    expect(new Set(CAPABILITY_KEYS).size).toBe(29);
  });

  it('every bundle grants only real keys', () => {
    for (const bundleKey of SYSTEM_BUNDLE_KEYS) {
      for (const key of SYSTEM_BUNDLE_CAPABILITIES[bundleKey]) {
        expect(CAPABILITY_KEYS).toContain(key);
      }
    }
  });

  it('admin grants everything, which is what makes the OWNER rule consistent', () => {
    expect([...SYSTEM_BUNDLE_CAPABILITIES.admin].sort()).toEqual([...CAPABILITY_KEYS].sort());
  });
});

describe('every bundle is a superset of Worker', () => {
  // The rule that makes the role-derived default safe. Without it, §37's bundle
  // rows read literally give a Finance user who cannot log their own hours — and
  // since every existing MANAGER derives Project Manager, shipping that would
  // remove an ability people have today.
  it.each(SYSTEM_BUNDLE_KEYS)('%s contains the worker floor', (bundleKey) => {
    for (const key of worker) {
      expect(SYSTEM_BUNDLE_CAPABILITIES[bundleKey]).toContain(key);
    }
  });
});

describe('§44\'s named separations', () => {
  it('a Supervisor cannot read commercial figures', () => {
    expect(SYSTEM_BUNDLE_CAPABILITIES.supervisor).not.toContain('commercial.read');
    // …but can do the thing the bundle exists for.
    expect(SYSTEM_BUNDLE_CAPABILITIES.supervisor).toContain('diary.close');
  });

  it('a Worker cannot set a destination', () => {
    expect(SYSTEM_BUNDLE_CAPABILITIES.worker).not.toContain('asset.destination.set');
  });

  it('Finance cannot close a day', () => {
    expect(SYSTEM_BUNDLE_CAPABILITIES.finance).not.toContain('diary.close');
    expect(SYSTEM_BUNDLE_CAPABILITIES.finance).toContain('commercial.read');
  });

  it('only the sustainability function and admins may verify a weight', () => {
    // §25.3 makes a VERIFIED weight a documented claim rather than an opinion.
    expect(SYSTEM_BUNDLE_CAPABILITIES.supervisor).not.toContain('asset.weight.verify');
    expect(SYSTEM_BUNDLE_CAPABILITIES.sustainability).toContain('asset.weight.verify');
  });
});

describe('defaultBundleForRole', () => {
  it('maps §37\'s three cases', () => {
    expect(defaultBundleForRole('OWNER')).toBe('admin');
    expect(defaultBundleForRole('ADMIN')).toBe('admin');
    expect(defaultBundleForRole('MANAGER')).toBe('project_manager');
    expect(defaultBundleForRole('MEMBER')).toBe('worker');
  });

  it('answers for every role there is', () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(SYSTEM_BUNDLE_KEYS).toContain(defaultBundleForRole(role));
    }
  });
});

describe('resolveCapabilities', () => {
  it('returns the bundle when there are no overrides', () => {
    const result = resolveCapabilities({
      role: 'MEMBER',
      bundleKey: 'worker',
      bundleCapabilities: worker,
      overrides: [],
    });
    expect(result).toEqual([...CAPABILITY_KEYS].filter((k) => worker.includes(k)));
  });

  it('an override grants', () => {
    const result = resolveCapabilities({
      role: 'MEMBER',
      bundleKey: 'worker',
      bundleCapabilities: worker,
      overrides: [{ capabilityKey: 'diary.write', granted: true }],
    });
    expect(result).toContain('diary.write');
  });

  it('an override revokes', () => {
    const result = resolveCapabilities({
      role: 'MEMBER',
      bundleKey: 'worker',
      bundleCapabilities: worker,
      overrides: [{ capabilityKey: 'evidence.upload', granted: false }],
    });
    expect(result).not.toContain('evidence.upload');
    expect(result).toContain('time.log.own');
  });

  it('returns keys in catalog order, whatever order they arrived in', () => {
    const shuffled: CapabilityKey[] = ['report.generate', 'project.read', 'diary.close'];
    const result = resolveCapabilities({
      role: 'MANAGER',
      bundleKey: 'custom',
      bundleCapabilities: shuffled,
      overrides: [],
    });
    // A response body, a log line and a test all have to agree on the order.
    expect(result).toEqual(['project.read', 'diary.close', 'report.generate']);
  });

  it('never returns a duplicate, even when an override grants what the bundle has', () => {
    const result = resolveCapabilities({
      role: 'MEMBER',
      bundleKey: 'worker',
      bundleCapabilities: worker,
      overrides: [{ capabilityKey: 'time.log.own', granted: true }],
    });
    expect(result.filter((k) => k === 'time.log.own')).toHaveLength(1);
  });

  it('an unknown bundle resolves to nothing rather than to everything', () => {
    // The failure mode worth pinning: a bundle key that resolves to no rows must
    // fail closed. A resolver that treated "no grants found" as "unrestricted"
    // would turn a typo into a promotion.
    const result = resolveCapabilities({
      role: 'MEMBER',
      bundleKey: 'does_not_exist',
      bundleCapabilities: [],
      overrides: [],
    });
    expect(result).toEqual([]);
  });
});

describe('an OWNER is not configurable', () => {
  // A capability layer able to strip an owner of `project.manage` can lock the
  // only person with authority out of their own company — and access.md §13.3
  // refused platform support access, so there is deliberately nobody who could
  // put it back.
  it('holds every capability whatever bundle is assigned', () => {
    const result = resolveCapabilities({
      role: 'OWNER',
      bundleKey: 'worker',
      bundleCapabilities: worker,
      overrides: [],
    });
    expect(result).toEqual([...CAPABILITY_KEYS]);
  });

  it('ignores a revoking override', () => {
    const result = resolveCapabilities({
      role: 'OWNER',
      bundleKey: null,
      bundleCapabilities: SYSTEM_BUNDLE_CAPABILITIES.admin,
      overrides: [
        { capabilityKey: 'commercial.read', granted: false },
        { capabilityKey: 'project.manage', granted: false },
      ],
    });
    expect(result).toContain('commercial.read');
    expect(result).toContain('project.manage');
  });

  it('but an ADMIN is configurable — the rule is about the owner, not about power', () => {
    const result = resolveCapabilities({
      role: 'ADMIN',
      bundleKey: null,
      bundleCapabilities: SYSTEM_BUNDLE_CAPABILITIES.admin,
      overrides: [{ capabilityKey: 'commercial.read', granted: false }],
    });
    expect(result).not.toContain('commercial.read');
  });
});

describe('updateMembershipCapabilitiesSchema', () => {
  it('accepts a bundle alone, overrides alone, and both', () => {
    expect(updateMembershipCapabilitiesSchema.safeParse({ bundleKey: 'supervisor' }).success).toBe(true);
    expect(
      updateMembershipCapabilitiesSchema.safeParse({
        overrides: [{ capabilityKey: 'diary.close', granted: true }],
      }).success
    ).toBe(true);
    expect(
      updateMembershipCapabilitiesSchema.safeParse({
        bundleKey: null,
        overrides: [],
      }).success
    ).toBe(true);
  });

  it('refuses an empty patch, which would be an audited no-op', () => {
    expect(updateMembershipCapabilitiesSchema.safeParse({}).success).toBe(false);
  });

  it('refuses two rows for one capability', () => {
    // Two rows would let array order silently decide a permission — the defect
    // overlapping rate-label rules were rejected for in Phase 2.
    const result = updateMembershipCapabilitiesSchema.safeParse({
      overrides: [
        { capabilityKey: 'diary.close', granted: true },
        { capabilityKey: 'diary.close', granted: false },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a capability key that does not exist', () => {
    const result = updateMembershipCapabilitiesSchema.safeParse({
      overrides: [{ capabilityKey: 'diary.destroy', granted: true }],
    });
    expect(result.success).toBe(false);
  });
});
