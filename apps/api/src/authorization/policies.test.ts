import { describe, expect, it } from 'vitest';
import {
  canManage,
  canManageAuditSettings,
  canProviderEditWork,
  canProviderSubmit,
  canReadBillRates,
  canReadCounterpartyAudit,
  canReviewWork,
  isEngagementClientSide,
  isEngagementParticipant,
  isEngagementProviderSide,
  isOwnerOrAdmin,
  type EngagementEdge,
} from './policies';

const CLIENT = 'client-co';
const PROVIDER = 'provider-co';
const OUTSIDER = 'outsider-co';
const edge: EngagementEdge = { clientCompanyId: CLIENT, providerCompanyId: PROVIDER };

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
