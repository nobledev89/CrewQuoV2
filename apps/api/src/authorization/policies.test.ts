import { describe, expect, it } from 'vitest';
import {
  canEditLineItemNoteBody,
  canManage,
  canManageAuditSettings,
  canManageInvoice,
  canProviderEditWork,
  canProviderSubmit,
  canReadBillRates,
  canReadCounterpartyAudit,
  canReadInvoice,
  canReadPortal,
  canResolveLineItemNote,
  canReviewWork,
  canWriteLineItemNote,
  decideMerge,
  isEngagementClientSide,
  isEngagementParticipant,
  isEngagementProviderSide,
  isOwnerOrAdmin,
  membershipChangeRefusal,
  membershipRemovalRefusal,
  type EngagementEdge,
  type MembershipSubject,
} from './policies';

const CLIENT = 'client-co';
const PROVIDER = 'provider-co';
const OUTSIDER = 'outsider-co';
const edge: EngagementEdge = { clientCompanyId: CLIENT, providerCompanyId: PROVIDER };

describe('invoice boundary', () => {
  it('lets the issuer see drafts but hides them from the billed client', () => {
    expect(canReadInvoice(PROVIDER, edge, 'DRAFT')).toBe(true);
    expect(canReadInvoice(CLIENT, edge, 'DRAFT')).toBe(false);
    expect(canReadInvoice(CLIENT, edge, 'ISSUED')).toBe(true);
    expect(canReadInvoice(OUTSIDER, edge, 'ISSUED')).toBe(false);
  });

  it('allows only issuer-side managers to mutate drafts', () => {
    expect(canManageInvoice(PROVIDER, 'OWNER', edge, 'DRAFT')).toBe(true);
    expect(canManageInvoice(PROVIDER, 'MEMBER', edge, 'DRAFT')).toBe(false);
    expect(canManageInvoice(CLIENT, 'OWNER', edge, 'DRAFT')).toBe(false);
    expect(canManageInvoice(PROVIDER, 'OWNER', edge, 'ISSUED')).toBe(false);
  });
});

describe('role gates', () => {
  it('OWNER/ADMIN/MANAGER can manage, MEMBER cannot', () => {
    expect(canManage('OWNER')).toBe(true);
    expect(canManage('ADMIN')).toBe(true);
    expect(canManage('MANAGER')).toBe(true);
    expect(canManage('MEMBER')).toBe(false);
  });

  it('isOwnerOrAdmin excludes MANAGER and MEMBER', () => {
    expect(isOwnerOrAdmin('OWNER')).toBe(true);
    expect(isOwnerOrAdmin('ADMIN')).toBe(true);
    expect(isOwnerOrAdmin('MANAGER')).toBe(false);
    expect(isOwnerOrAdmin('MEMBER')).toBe(false);
  });
});

describe('engagement one-hop visibility (§3.2)', () => {
  it('only the two endpoints participate', () => {
    expect(isEngagementParticipant(CLIENT, edge)).toBe(true);
    expect(isEngagementParticipant(PROVIDER, edge)).toBe(true);
    expect(isEngagementParticipant(OUTSIDER, edge)).toBe(false);
  });

  it('distinguishes client and provider sides', () => {
    expect(isEngagementClientSide(CLIENT, edge)).toBe(true);
    expect(isEngagementClientSide(PROVIDER, edge)).toBe(false);
    expect(isEngagementProviderSide(PROVIDER, edge)).toBe(true);
    expect(isEngagementProviderSide(CLIENT, edge)).toBe(false);
  });
});

describe('PAY/BILL guard (§3.3)', () => {
  it('only the client side reads BILL rates', () => {
    expect(canReadBillRates(CLIENT, edge)).toBe(true);
    expect(canReadBillRates(PROVIDER, edge)).toBe(false);
    expect(canReadBillRates(OUTSIDER, edge)).toBe(false);
  });
});

describe('work workflow invariant (§3.4)', () => {
  it('provider edits only DRAFT/REJECTED', () => {
    expect(canProviderEditWork('DRAFT')).toBe(true);
    expect(canProviderEditWork('REJECTED')).toBe(true);
    expect(canProviderEditWork('SUBMITTED')).toBe(false);
    expect(canProviderEditWork('APPROVED')).toBe(false);
  });

  it('provider submits only from DRAFT', () => {
    expect(canProviderSubmit('DRAFT')).toBe(true);
    expect(canProviderSubmit('REJECTED')).toBe(false);
    expect(canProviderSubmit('SUBMITTED')).toBe(false);
  });

  it('client side manager reviews only SUBMITTED work', () => {
    expect(canReviewWork(CLIENT, 'ADMIN', edge, 'SUBMITTED')).toBe(true);
    expect(canReviewWork(CLIENT, 'MANAGER', edge, 'SUBMITTED')).toBe(true);
    // wrong status
    expect(canReviewWork(CLIENT, 'ADMIN', edge, 'DRAFT')).toBe(false);
    // provider side may never approve
    expect(canReviewWork(PROVIDER, 'ADMIN', edge, 'SUBMITTED')).toBe(false);
    // MEMBER cannot approve even on the client side
    expect(canReviewWork(CLIENT, 'MEMBER', edge, 'SUBMITTED')).toBe(false);
    // outsider cannot approve
    expect(canReviewWork(OUTSIDER, 'ADMIN', edge, 'SUBMITTED')).toBe(false);
  });
});

describe('portal audit visibility (§3.6)', () => {
  const both = { providerHasAuditVisibility: true, showAuditTrail: true };

  it('client side reads the provider trail only when feature and setting both allow it', () => {
    expect(canReadCounterpartyAudit({ companyId: CLIENT, edge, ...both })).toBe(true);
    // provider's plan lacks audit_visibility
    expect(
      canReadCounterpartyAudit({ ...both, companyId: CLIENT, edge, providerHasAuditVisibility: false })
    ).toBe(false);
    // provider has not switched the trail on for this engagement
    expect(
      canReadCounterpartyAudit({ ...both, companyId: CLIENT, edge, showAuditTrail: false })
    ).toBe(false);
  });

  it('never exposes a trail to the provider itself or to an outsider', () => {
    expect(canReadCounterpartyAudit({ companyId: PROVIDER, edge, ...both })).toBe(false);
    expect(canReadCounterpartyAudit({ companyId: OUTSIDER, edge, ...both })).toBe(false);
  });

  it('only the provider side manages portal settings, and only its managers', () => {
    expect(canManageAuditSettings(PROVIDER, 'OWNER', edge)).toBe(true);
    expect(canManageAuditSettings(PROVIDER, 'MANAGER', edge)).toBe(true);
    expect(canManageAuditSettings(PROVIDER, 'MEMBER', edge)).toBe(false);
    // the client cannot decide what is shown to itself
    expect(canManageAuditSettings(CLIENT, 'OWNER', edge)).toBe(false);
    expect(canManageAuditSettings(OUTSIDER, 'OWNER', edge)).toBe(false);
  });
});

describe('portal read (§3.6)', () => {
  it('only the client side, and only when the provider sells a portal', () => {
    expect(
      canReadPortal({ companyId: CLIENT, edge, providerHasClientPortal: true })
    ).toBe(true);
    // the provider's plan, not the client's, is what gates the surface
    expect(
      canReadPortal({ companyId: CLIENT, edge, providerHasClientPortal: false })
    ).toBe(false);
    // the provider does not have a portal onto itself
    expect(
      canReadPortal({ companyId: PROVIDER, edge, providerHasClientPortal: true })
    ).toBe(false);
    expect(
      canReadPortal({ companyId: OUTSIDER, edge, providerHasClientPortal: true })
    ).toBe(false);
  });
});

describe('line-item notes (§3.6)', () => {
  const open = { providerHasNotes: true, clientCanComment: true };

  it('needs the provider’s client_portal_notes feature on both sides', () => {
    expect(canWriteLineItemNote({ companyId: CLIENT, role: 'ADMIN', edge, ...open })).toBe(true);
    expect(canWriteLineItemNote({ companyId: PROVIDER, role: 'ADMIN', edge, ...open })).toBe(true);
    expect(
      canWriteLineItemNote({ ...open, companyId: CLIENT, role: 'ADMIN', edge, providerHasNotes: false })
    ).toBe(false);
    expect(
      canWriteLineItemNote({ ...open, companyId: PROVIDER, role: 'ADMIN', edge, providerHasNotes: false })
    ).toBe(false);
  });

  it('client_can_comment silences the client but never the provider', () => {
    expect(
      canWriteLineItemNote({ ...open, companyId: CLIENT, role: 'ADMIN', edge, clientCanComment: false })
    ).toBe(false);
    expect(
      canWriteLineItemNote({ ...open, companyId: PROVIDER, role: 'ADMIN', edge, clientCanComment: false })
    ).toBe(true);
  });

  it('MEMBERs and outsiders never write', () => {
    expect(canWriteLineItemNote({ companyId: CLIENT, role: 'MEMBER', edge, ...open })).toBe(false);
    expect(canWriteLineItemNote({ companyId: OUTSIDER, role: 'OWNER', edge, ...open })).toBe(false);
  });

  it('a body belongs to its author; resolved is shared', () => {
    expect(canEditLineItemNoteBody('u1', { authorUserId: 'u1' })).toBe(true);
    expect(canEditLineItemNoteBody('u2', { authorUserId: 'u1' })).toBe(false);
    expect(canResolveLineItemNote(CLIENT, edge)).toBe(true);
    expect(canResolveLineItemNote(PROVIDER, edge)).toBe(true);
    expect(canResolveLineItemNote(OUTSIDER, edge)).toBe(false);
  });
});

describe('placeholder merge decision (owner decision 2026-08-17)', () => {
  const base = {
    placeholderCompanyId: 'placeholder-co',
    counterpartyCompanyId: CLIENT,
    edgeExists: false,
    assignmentClash: false,
  };

  it('claims the placeholder when the invitee has no company of their own', () => {
    expect(decideMerge({ ...base, targetCompanyId: null })).toEqual({
      outcome: 'CLAIMED',
      reason: null,
    });
  });

  it('merges when a single real company is identified and nothing collides', () => {
    expect(decideMerge({ ...base, targetCompanyId: 'real-co' })).toEqual({
      outcome: 'MERGED',
      reason: null,
    });
  });

  it('claims rather than merging a placeholder into itself', () => {
    expect(
      decideMerge({ ...base, targetCompanyId: base.placeholderCompanyId }).outcome
    ).toBe('CLAIMED');
  });

  it('declines the merge that would make a company engage itself', () => {
    const d = decideMerge({ ...base, targetCompanyId: CLIENT });
    expect(d.outcome).toBe('SKIPPED');
    expect(d.reason).toMatch(/itself/);
  });

  it('declines when the edge or an assignment already exists', () => {
    expect(decideMerge({ ...base, targetCompanyId: 'real-co', edgeExists: true })).toEqual({
      outcome: 'SKIPPED',
      reason: 'An engagement between these two companies already exists',
    });
    expect(decideMerge({ ...base, targetCompanyId: 'real-co', assignmentClash: true })).toEqual({
      outcome: 'SKIPPED',
      reason: 'That company is already assigned to one of these projects',
    });
  });

  it('never reports MERGED without a target to merge into', () => {
    for (const targetCompanyId of [null, base.placeholderCompanyId, CLIENT]) {
      const d = decideMerge({ ...base, targetCompanyId });
      expect(d.outcome).not.toBe('MERGED');
    }
  });
});

// ── Member management (§3.1, §7) ────────────────────────────────────────────────

describe('membershipChangeRefusal', () => {
  const owner: MembershipSubject = { userId: 'u-owner', role: 'OWNER', status: 'ACTIVE' };
  const member: MembershipSubject = { userId: 'u-member', role: 'MEMBER', status: 'ACTIVE' };

  it('lets an owner change an ordinary member', () => {
    expect(
      membershipChangeRefusal({
        actorRole: 'OWNER',
        target: member,
        activeOwnerCount: 1,
        patch: { role: 'MANAGER' },
      })
    ).toBeNull();
  });

  it('lets an admin change an ordinary member', () => {
    expect(
      membershipChangeRefusal({
        actorRole: 'ADMIN',
        target: member,
        activeOwnerCount: 1,
        patch: { role: 'MANAGER' },
      })
    ).toBeNull();
  });

  it('refuses a manager or a member outright', () => {
    for (const actorRole of ['MANAGER', 'MEMBER'] as const) {
      expect(
        membershipChangeRefusal({
          actorRole,
          target: member,
          activeOwnerCount: 2,
          patch: { role: 'ADMIN' },
        })
      ).toMatch(/owner or admin/);
    }
  });

  it('stops an admin touching an owner even when another owner remains', () => {
    expect(
      membershipChangeRefusal({
        actorRole: 'ADMIN',
        target: owner,
        activeOwnerCount: 3,
        patch: { role: 'ADMIN' },
      })
    ).toMatch(/admin cannot change an owner/);
  });

  it('stops an admin minting an owner', () => {
    expect(
      membershipChangeRefusal({
        actorRole: 'ADMIN',
        target: member,
        activeOwnerCount: 2,
        patch: { role: 'OWNER' },
      })
    ).toMatch(/cannot grant ownership/);
  });

  it('keeps the last active owner: no demotion, no suspension', () => {
    for (const patch of [{ role: 'ADMIN' as const }, { status: 'SUSPENDED' as const }]) {
      expect(
        membershipChangeRefusal({ actorRole: 'OWNER', target: owner, activeOwnerCount: 1, patch })
      ).toMatch(/at least one active owner/);
    }
  });

  it('allows an owner to step down once a second active owner exists', () => {
    expect(
      membershipChangeRefusal({
        actorRole: 'OWNER',
        target: owner,
        activeOwnerCount: 2,
        patch: { role: 'ADMIN' },
      })
    ).toBeNull();
  });

  it('allows a no-op patch on the last owner — it loses nothing', () => {
    expect(
      membershipChangeRefusal({
        actorRole: 'OWNER',
        target: owner,
        activeOwnerCount: 1,
        patch: { role: 'OWNER', status: 'ACTIVE' },
      })
    ).toBeNull();
  });

  it('does not count a suspended owner as the one being protected', () => {
    // A suspended owner cannot act, so promoting someone else out of that row is
    // not what strands the company — the count is what matters, and it is zero here.
    expect(
      membershipChangeRefusal({
        actorRole: 'OWNER',
        target: { userId: 'u', role: 'OWNER', status: 'SUSPENDED' },
        activeOwnerCount: 0,
        patch: { role: 'MEMBER' },
      })
    ).toBeNull();
  });
});

describe('membershipRemovalRefusal', () => {
  const owner: MembershipSubject = { userId: 'u-owner', role: 'OWNER', status: 'ACTIVE' };
  const member: MembershipSubject = { userId: 'u-member', role: 'MEMBER', status: 'ACTIVE' };

  it('removes an ordinary member', () => {
    expect(
      membershipRemovalRefusal({ actorRole: 'ADMIN', target: member, activeOwnerCount: 1 })
    ).toBeNull();
  });

  it('refuses a manager', () => {
    expect(
      membershipRemovalRefusal({ actorRole: 'MANAGER', target: member, activeOwnerCount: 2 })
    ).toMatch(/owner or admin/);
  });

  it('stops an admin removing an owner', () => {
    expect(
      membershipRemovalRefusal({ actorRole: 'ADMIN', target: owner, activeOwnerCount: 4 })
    ).toMatch(/cannot remove an owner/);
  });

  it('never removes the last active owner', () => {
    expect(
      membershipRemovalRefusal({ actorRole: 'OWNER', target: owner, activeOwnerCount: 1 })
    ).toMatch(/at least one active owner/);
  });

  it('removes an owner once a second one exists', () => {
    expect(
      membershipRemovalRefusal({ actorRole: 'OWNER', target: owner, activeOwnerCount: 2 })
    ).toBeNull();
  });
});
