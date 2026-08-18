import { describe, expect, it } from 'vitest';
import {
  COMPANY_RECOVERY_ROUTES,
  classifyDuplicateSignal,
  effectiveCompanyRequestStatus,
  isCompanyRequestOpen,
  isCompanyRequestPending,
  isCompanyRequestTerminal,
  nextCompanyRequestStatus,
  normalizeCompanyName,
  normalizeRegistrationId,
  resolveCompanyApprovalRoute,
  resolveCompanyCreationDecision,
  resolveTrialEligibility,
  type CompanyCreationFacts,
  type CompanyIdentityCandidate,
  type CompanyRequestStatus,
} from './company-creation';

/**
 * The company ownership & creation safeguard (§3.1.1), pinned without a database.
 *
 * §44 names the cases this file is answerable to: invited memberships never
 * consume the allowance; the automatic path works exactly once; ownership
 * transfer/archive/delete never restores it; additional creation refuses
 * missing/expired/reused approval; approval is single-use; a prior trial cannot
 * be reset through another company; and duplicate identifiers route to recovery
 * without name-only false positives.
 */

const NOW = new Date('2026-08-18T12:00:00.000Z');

function facts(over: Partial<CompanyCreationFacts> = {}): CompanyCreationFacts {
  return {
    isPlatformStaff: false,
    emailVerified: true,
    requireVerifiedEmail: false,
    allowanceConsumed: false,
    approvedRequest: null,
    now: NOW,
    ...over,
  };
}

describe('resolveCompanyCreationDecision — the automatic first company', () => {
  it('lets an identity with no ledger row create one', () => {
    expect(resolveCompanyCreationDecision(facts())).toEqual({ kind: 'ALLOWANCE' });
  });

  it('refuses the second one and names the flow that replaces it', () => {
    const decision = resolveCompanyCreationDecision(facts({ allowanceConsumed: true }));
    expect(decision.kind).toBe('REFUSED');
    if (decision.kind !== 'REFUSED') throw new Error('unreachable');
    expect(decision.code).toBe('CONFLICT');
    expect(decision.details).toEqual({ requires: 'company_creation_request' });
  });

  /**
   * The allowance is a property of the *identity*, so nothing about the company —
   * transferring it, leaving it, archiving or deleting it — is even an input here.
   * That is §3.1.1(1)'s "ledgered permanently" expressed as a type: there is no
   * field on `CompanyCreationFacts` a caller could set to undo it.
   */
  it('cannot be restored by anything that happens to the company afterwards', () => {
    expect(resolveCompanyCreationDecision(facts({ allowanceConsumed: true })).kind).toBe('REFUSED');
  });

  it('keeps platform staff out of the customer endpoint entirely', () => {
    const decision = resolveCompanyCreationDecision(facts({ isPlatformStaff: true }));
    expect(decision.kind).toBe('REFUSED');
    if (decision.kind !== 'REFUSED') throw new Error('unreachable');
    expect(decision.code).toBe('FORBIDDEN');
    expect(decision.message).toMatch(/Platform console/i);
  });

  it('excludes staff before it looks at anything else', () => {
    const decision = resolveCompanyCreationDecision(
      facts({ isPlatformStaff: true, allowanceConsumed: false, emailVerified: false })
    );
    if (decision.kind !== 'REFUSED') throw new Error('unreachable');
    expect(decision.code).toBe('FORBIDDEN');
  });

  it('gates the first company on a verified address only when the platform says so', () => {
    expect(resolveCompanyCreationDecision(facts({ emailVerified: false }))).toEqual({
      kind: 'ALLOWANCE',
    });
    const gated = resolveCompanyCreationDecision(
      facts({ emailVerified: false, requireVerifiedEmail: true })
    );
    if (gated.kind !== 'REFUSED') throw new Error('unreachable');
    expect(gated.code).toBe('VALIDATION');
    expect(gated.details).toEqual({ requires: 'email_verification' });
  });

  /** The setting is about the *automatic* path; an approval carries its own proof. */
  it('does not re-ask for verification on the approval path', () => {
    expect(
      resolveCompanyCreationDecision(
        facts({
          allowanceConsumed: true,
          emailVerified: false,
          requireVerifiedEmail: true,
          approvedRequest: { id: 'req-1', expiresAt: '2026-09-18T00:00:00.000Z' },
        })
      )
    ).toEqual({ kind: 'APPROVAL', requestId: 'req-1' });
  });
});

describe('resolveCompanyCreationDecision — the approval path', () => {
  it('creates on a live approval', () => {
    expect(
      resolveCompanyCreationDecision(
        facts({
          allowanceConsumed: true,
          approvedRequest: { id: 'req-9', expiresAt: new Date('2026-08-19T00:00:00.000Z') },
        })
      )
    ).toEqual({ kind: 'APPROVAL', requestId: 'req-9' });
  });

  it('refuses an expired approval and says when it lapsed', () => {
    const decision = resolveCompanyCreationDecision(
      facts({
        allowanceConsumed: true,
        approvedRequest: { id: 'req-9', expiresAt: '2026-08-17T00:00:00.000Z' },
      })
    );
    if (decision.kind !== 'REFUSED') throw new Error('unreachable');
    expect(decision.code).toBe('CONFLICT');
    expect(decision.message).toContain('2026-08-17');
  });

  /** Expiry is inclusive: an approval that expires *now* is spent, not usable. */
  it('treats an approval expiring exactly now as expired', () => {
    const decision = resolveCompanyCreationDecision(
      facts({ allowanceConsumed: true, approvedRequest: { id: 'r', expiresAt: NOW } })
    );
    expect(decision.kind).toBe('REFUSED');
  });

  it('accepts a Date and an ISO string identically', () => {
    const iso = resolveCompanyCreationDecision(
      facts({ allowanceConsumed: true, approvedRequest: { id: 'r', expiresAt: '2026-08-19T00:00:00.000Z' } })
    );
    const date = resolveCompanyCreationDecision(
      facts({ allowanceConsumed: true, approvedRequest: { id: 'r', expiresAt: new Date('2026-08-19T00:00:00.000Z') } })
    );
    expect(iso).toEqual(date);
  });
});

describe('the request state machine', () => {
  const ALL: CompanyRequestStatus[] = [
    'PENDING_CHECKOUT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED', 'CONSUMED',
  ];

  it('recognises which states hold the caller\'s single open slot', () => {
    expect(ALL.filter(isCompanyRequestOpen)).toEqual([
      'PENDING_CHECKOUT', 'PENDING_REVIEW', 'APPROVED',
    ]);
    expect(ALL.filter(isCompanyRequestPending)).toEqual(['PENDING_CHECKOUT', 'PENDING_REVIEW']);
    expect(ALL.filter(isCompanyRequestTerminal)).toEqual(['REJECTED', 'EXPIRED', 'CONSUMED']);
  });

  it('turns a recorded checkout into an approval, and only from PENDING_CHECKOUT', () => {
    expect(nextCompanyRequestStatus('PENDING_CHECKOUT', 'CHECKOUT_RECORDED')).toBe('APPROVED');
    for (const s of ALL.filter((s) => s !== 'PENDING_CHECKOUT')) {
      expect(nextCompanyRequestStatus(s, 'CHECKOUT_RECORDED')).toBeNull();
    }
  });

  /** §3.1.1(3)'s exceptional path: a legitimate free company should not be made to pay. */
  it('lets an admin approve out of either pending state', () => {
    expect(nextCompanyRequestStatus('PENDING_REVIEW', 'ADMIN_APPROVE')).toBe('APPROVED');
    expect(nextCompanyRequestStatus('PENDING_CHECKOUT', 'ADMIN_APPROVE')).toBe('APPROVED');
  });

  it('refuses to approve anything already decided', () => {
    for (const s of ['APPROVED', 'REJECTED', 'EXPIRED', 'CONSUMED'] as CompanyRequestStatus[]) {
      expect(nextCompanyRequestStatus(s, 'ADMIN_APPROVE')).toBeNull();
    }
  });

  /** An approval given in error must be retractable before it becomes a tenant. */
  it('allows rejecting an approved-but-unconsumed request', () => {
    expect(nextCompanyRequestStatus('APPROVED', 'ADMIN_REJECT')).toBe('REJECTED');
  });

  it('refuses to reject a request that already produced a company', () => {
    expect(nextCompanyRequestStatus('CONSUMED', 'ADMIN_REJECT')).toBeNull();
  });

  it('consumes only an approval, exactly once', () => {
    expect(nextCompanyRequestStatus('APPROVED', 'CONSUME')).toBe('CONSUMED');
    for (const s of ALL.filter((s) => s !== 'APPROVED')) {
      expect(nextCompanyRequestStatus(s, 'CONSUME')).toBeNull();
    }
  });

  it('expires anything still open and nothing that is settled', () => {
    for (const s of ALL) {
      expect(nextCompanyRequestStatus(s, 'EXPIRE')).toBe(isCompanyRequestOpen(s) ? 'EXPIRED' : null);
    }
  });

  it('never leaves a terminal state', () => {
    const events = ['CHECKOUT_RECORDED', 'ADMIN_APPROVE', 'ADMIN_REJECT', 'EXPIRE', 'CONSUME'] as const;
    for (const s of ALL.filter(isCompanyRequestTerminal)) {
      for (const e of events) expect(nextCompanyRequestStatus(s, e)).toBeNull();
    }
  });
});

describe('effectiveCompanyRequestStatus — lazy expiry', () => {
  it('reports an open request past its date as expired', () => {
    expect(effectiveCompanyRequestStatus('APPROVED', '2026-08-17T00:00:00Z', NOW)).toBe('EXPIRED');
    expect(effectiveCompanyRequestStatus('PENDING_REVIEW', '2026-08-17T00:00:00Z', NOW)).toBe('EXPIRED');
  });

  it('leaves a live request alone', () => {
    expect(effectiveCompanyRequestStatus('APPROVED', '2026-08-19T00:00:00Z', NOW)).toBe('APPROVED');
  });

  /** A company exists. Its request cannot later read as expired. */
  it('never expires a consumed request, however old', () => {
    expect(effectiveCompanyRequestStatus('CONSUMED', '2020-01-01T00:00:00Z', NOW)).toBe('CONSUMED');
  });

  it('leaves other terminal states untouched', () => {
    expect(effectiveCompanyRequestStatus('REJECTED', '2020-01-01T00:00:00Z', NOW)).toBe('REJECTED');
  });
});

describe('normalizeRegistrationId', () => {
  it('makes the same number written three ways compare equal', () => {
    expect(normalizeRegistrationId('SC 123 456')).toBe('SC123456');
    expect(normalizeRegistrationId('sc-123456')).toBe('SC123456');
    expect(normalizeRegistrationId('SC123456')).toBe('SC123456');
  });

  it('treats absent, empty and punctuation-only as no identifier at all', () => {
    expect(normalizeRegistrationId(null)).toBeNull();
    expect(normalizeRegistrationId(undefined)).toBeNull();
    expect(normalizeRegistrationId('')).toBeNull();
    expect(normalizeRegistrationId('   ')).toBeNull();
    expect(normalizeRegistrationId('--- ///')).toBeNull();
  });
});

describe('normalizeCompanyName', () => {
  it('ignores case, punctuation, spacing and the legal suffix', () => {
    expect(normalizeCompanyName('Northlight Rigging Ltd.')).toBe('northlight rigging');
    expect(normalizeCompanyName('  NORTHLIGHT   RIGGING  ')).toBe('northlight rigging');
    expect(normalizeCompanyName('Northlight Rigging Limited')).toBe('northlight rigging');
  });

  it('does not strip a suffix that is the entire name', () => {
    expect(normalizeCompanyName('Limited')).toBe('limited');
  });

  it('strips stacked suffixes', () => {
    expect(normalizeCompanyName('Meridian Plant Hire Co Ltd')).toBe('meridian plant hire');
  });

  it('keeps genuinely different names apart', () => {
    expect(normalizeCompanyName('Northlight Rigging')).not.toBe(normalizeCompanyName('Northlight Rentals'));
  });
});

describe('classifyDuplicateSignal', () => {
  const company = (over: Partial<CompanyIdentityCandidate> = {}): CompanyIdentityCandidate => ({
    kind: 'COMPANY',
    country: 'GB',
    registrationIdNormalized: 'SC123456',
    nameNormalized: 'northlight rigging',
    ...over,
  });

  it('blocks on country + registration identifier and offers a route', () => {
    const signal = classifyDuplicateSignal(
      { country: 'GB', registrationId: 'sc-123 456', legalName: 'Totally Different Name Ltd' },
      [company()]
    );
    expect(signal.level).toBe('BLOCK');
    expect(signal.matchedKind).toBe('COMPANY');
    expect(COMPANY_RECOVERY_ROUTES.length).toBe(3);
  });

  /** A registration number is only unique within its jurisdiction. */
  it('does not block the same number in a different country', () => {
    expect(
      classifyDuplicateSignal(
        { country: 'IE', registrationId: 'SC123456', legalName: 'Elsewhere Ltd' },
        [company()]
      ).level
    ).toBe('NONE');
  });

  it('warns, and does not block, on a name-only match', () => {
    const signal = classifyDuplicateSignal(
      { country: 'GB', registrationId: 'ZZ999', legalName: 'Northlight Rigging Limited' },
      [company()]
    );
    expect(signal.level).toBe('WARNING');
    expect(signal.reason).toMatch(/does not stop you/i);
  });

  it('produces no name false positive for a merely similar name', () => {
    expect(
      classifyDuplicateSignal(
        { country: 'GB', registrationId: null, legalName: 'Northlight Rigging Services' },
        [company()]
      ).level
    ).toBe('NONE');
  });

  it('says nothing at all when nothing matches', () => {
    expect(classifyDuplicateSignal({ country: 'GB', legalName: 'Fresh Co', registrationId: 'AB1' }, [])).toEqual({
      level: 'NONE',
      reason: null,
      matchedKind: null,
    });
  });

  it('blocks against another live request, not only against existing companies', () => {
    const signal = classifyDuplicateSignal(
      { country: 'GB', registrationId: 'SC123456', legalName: 'Anything' },
      [company({ kind: 'REQUEST' })]
    );
    expect(signal.level).toBe('BLOCK');
    expect(signal.reason).toMatch(/being reviewed/i);
  });

  /** The whole response is a boolean plus a route — never a company (packet §10). */
  it('discloses no company identity in a block', () => {
    const signal = classifyDuplicateSignal(
      { country: 'GB', registrationId: 'SC123456', legalName: 'X' },
      [company()]
    );
    expect(JSON.stringify(signal)).not.toContain('northlight');
  });

  it('never blocks when the applicant supplies no identifier', () => {
    expect(
      classifyDuplicateSignal({ country: 'GB', registrationId: null, legalName: 'Unrelated' }, [company()]).level
    ).toBe('NONE');
  });
});

describe('resolveCompanyApprovalRoute', () => {
  it('sends a paid request to checkout when checkout exists', () => {
    expect(resolveCompanyApprovalRoute({ checkoutEnabled: true, intendedPlanIsPaid: true })).toEqual({
      route: 'CHECKOUT',
      status: 'PENDING_CHECKOUT',
    });
  });

  it('sends a free-plan request to review even when checkout exists', () => {
    expect(resolveCompanyApprovalRoute({ checkoutEnabled: true, intendedPlanIsPaid: false }).route).toBe('ADMIN');
  });

  /** Checkout is off until Gumroad: every request lands in the audited-admin arm. */
  it('sends everything to review while checkout is disabled', () => {
    expect(resolveCompanyApprovalRoute({ checkoutEnabled: false, intendedPlanIsPaid: true })).toEqual({
      route: 'ADMIN',
      status: 'PENDING_REVIEW',
    });
  });
});

describe('resolveTrialEligibility', () => {
  it('treats the same company getting more days as an extension, not a new trial', () => {
    expect(
      resolveTrialEligibility({
        ownerUserIds: ['u1'],
        priorGrants: [{ userId: 'u1', companyId: 'c-other' }],
        targetCompanyId: 'c1',
        targetHasTrial: true,
        acknowledgeRepeat: false,
      })
    ).toEqual({ kind: 'EXTENSION' });
  });

  it('allows a first trial', () => {
    expect(
      resolveTrialEligibility({
        ownerUserIds: ['u1'],
        priorGrants: [],
        targetCompanyId: 'c1',
        targetHasTrial: false,
        acknowledgeRepeat: false,
      })
    ).toEqual({ kind: 'FIRST' });
  });

  /** The reset this ledger exists to stop: new company, same person, second trial. */
  it('refuses a second trial for an owner who trialled on another company', () => {
    const result = resolveTrialEligibility({
      ownerUserIds: ['u1'],
      priorGrants: [{ userId: 'u1', companyId: 'c-old' }],
      targetCompanyId: 'c-new',
      targetHasTrial: false,
      acknowledgeRepeat: false,
    });
    expect(result.kind).toBe('REFUSED');
    if (result.kind !== 'REFUSED') throw new Error('unreachable');
    expect(result.details).toEqual({ priorGrants: 1, requires: 'acknowledgeRepeatTrial' });
  });

  it('allows it once an operator acknowledges the repeat', () => {
    expect(
      resolveTrialEligibility({
        ownerUserIds: ['u1'],
        priorGrants: [{ userId: 'u1', companyId: 'c-old' }],
        targetCompanyId: 'c-new',
        targetHasTrial: false,
        acknowledgeRepeat: true,
      }).kind
    ).toBe('REPEAT_ALLOWED');
  });

  /** Any owner having trialled before makes it a repeat — the weakest link wins. */
  it('catches a repeat through a co-owner', () => {
    expect(
      resolveTrialEligibility({
        ownerUserIds: ['u1', 'u2'],
        priorGrants: [{ userId: 'u2', companyId: 'c-old' }],
        targetCompanyId: 'c-new',
        targetHasTrial: false,
        acknowledgeRepeat: false,
      }).kind
    ).toBe('REFUSED');
  });

  it('ignores a grant belonging to somebody who does not own this company', () => {
    expect(
      resolveTrialEligibility({
        ownerUserIds: ['u1'],
        priorGrants: [{ userId: 'stranger', companyId: 'c-old' }],
        targetCompanyId: 'c-new',
        targetHasTrial: false,
        acknowledgeRepeat: false,
      }).kind
    ).toBe('FIRST');
  });

  /** A stale ledger row for *this* company is not evidence of a prior trial. */
  it('ignores a prior grant recorded against the target company itself', () => {
    expect(
      resolveTrialEligibility({
        ownerUserIds: ['u1'],
        priorGrants: [{ userId: 'u1', companyId: 'c-new' }],
        targetCompanyId: 'c-new',
        targetHasTrial: false,
        acknowledgeRepeat: false,
      }).kind
    ).toBe('FIRST');
  });
});
