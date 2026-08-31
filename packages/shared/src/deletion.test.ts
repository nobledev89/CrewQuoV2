import { describe, expect, it } from 'vitest';
import {
  CLOSURE_PLANS,
  COMPANY_CLOSURE_PLAN,
  COMPANY_CLOSURE_PROMISES,
  DELETION_COOLING_OFF_DAYS,
  DELETION_IMMINENT_NOTICE_HOURS,
  NEVER_REMOVED_TABLES,
  PERSONAL_CLOSURE_PLAN,
  PERSONAL_CLOSURE_PROMISES,
  WITHDRAWN_PERSON_NAME,
  canCancelDeletion,
  companyClosureBlocks,
  deletionIsExecutable,
  deletionScheduledFor,
  imminentNoticeDue,
  isTerminalDeletionStatus,
  personalClosureBlocks,
  requestDeletionSchema,
  withdrawnEmail,
} from './deletion';

const AT = new Date('2026-08-21T09:00:00.000Z');

describe('the cooling-off window', () => {
  it('lands the deadline a whole number of days out', () => {
    expect(deletionScheduledFor(AT).toISOString()).toBe('2026-08-28T09:00:00.000Z');
  });

  it('is long enough to survive a week on site', () => {
    // Not an arbitrary assertion on a constant: the argument in the source is that a
    // one-day window only protects people at their desks, so anything under a week is
    // the failure that reasoning describes.
    expect(DELETION_COOLING_OFF_DAYS).toBeGreaterThanOrEqual(7);
  });
});

describe('the one-day-out notice', () => {
  const scheduledFor = deletionScheduledFor(AT);

  it('is not due six days early', () => {
    expect(imminentNoticeDue({ now: AT, scheduledFor, alreadySent: false })).toBe(false);
  });

  it('is due inside the lead time', () => {
    const now = new Date(scheduledFor.getTime() - (DELETION_IMMINENT_NOTICE_HOURS - 1) * 3600_000);
    expect(imminentNoticeDue({ now, scheduledFor, alreadySent: false })).toBe(true);
  });

  it('is still due past the deadline, because a run can be blocked', () => {
    // A company whose engagements are still live sits past its deadline. The notice
    // having been missed is not a reason to never send it.
    const now = new Date(scheduledFor.getTime() + 3600_000);
    expect(imminentNoticeDue({ now, scheduledFor, alreadySent: false })).toBe(true);
  });

  it('goes exactly once, however often the job runs', () => {
    // The guard is the recorded send, not a window: an hourly job inside a 24-hour
    // lead would otherwise send twenty-four identical warnings.
    const now = new Date(scheduledFor.getTime() - 3600_000);
    expect(imminentNoticeDue({ now, scheduledFor, alreadySent: true })).toBe(false);
  });
});

describe('what the executor may pick up', () => {
  const scheduledFor = deletionScheduledFor(AT);
  const due = new Date(scheduledFor.getTime() + 1000);

  it('runs a scheduled request once its deadline passes', () => {
    expect(deletionIsExecutable({ status: 'SCHEDULED', scheduledFor, now: due })).toBe(true);
  });

  it('does not run one before its deadline', () => {
    expect(deletionIsExecutable({ status: 'SCHEDULED', scheduledFor, now: AT })).toBe(false);
  });

  /**
   * The assertion this whole two-state design exists for.
   *
   * `REQUESTED` means the notice to the holder has not been dispatched — the outbox
   * handler that sends it is what advances the state. A row still in `REQUESTED` on
   * day seven is one nobody was ever warned about, and running it would erase an
   * account in silence. Deleting this check would make a permanently dead-lettered
   * email into a silent deletion, and nothing else in the system would notice.
   */
  it('never runs a request the holder was never told about', () => {
    expect(deletionIsExecutable({ status: 'REQUESTED', scheduledFor, now: due })).toBe(false);
  });

  it('never re-runs a failed one — a failed deletion is never blind-retried', () => {
    expect(deletionIsExecutable({ status: 'FAILED', scheduledFor, now: due })).toBe(false);
    expect(deletionIsExecutable({ status: 'EXECUTING', scheduledFor, now: due })).toBe(false);
    expect(deletionIsExecutable({ status: 'COMPLETED', scheduledFor, now: due })).toBe(false);
  });
});

describe('cancellation', () => {
  it('is offered exactly while it can still be honoured', () => {
    expect(canCancelDeletion('REQUESTED')).toBe(true);
    expect(canCancelDeletion('SCHEDULED')).toBe(true);
    // Rows are being rewritten inside a transaction by now. A screen offering to
    // stop something that cannot be stopped is worse than one that says it is late.
    expect(canCancelDeletion('EXECUTING')).toBe(false);
    expect(canCancelDeletion('COMPLETED')).toBe(false);
    expect(canCancelDeletion('CANCELLED')).toBe(false);
    expect(canCancelDeletion('FAILED')).toBe(false);
  });

  it('agrees with the terminal set', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'FAILED'] as const) {
      expect(isTerminalDeletionStatus(status)).toBe(true);
      expect(canCancelDeletion(status)).toBe(false);
    }
    for (const status of ['REQUESTED', 'SCHEDULED', 'EXECUTING'] as const) {
      expect(isTerminalDeletionStatus(status)).toBe(false);
    }
  });
});

describe('the withdrawn identity', () => {
  const userId = '11111111-2222-3333-4444-555555555555';

  it('cannot be delivered to', () => {
    // RFC 2606 reserves `.invalid`. It matters because this value lands in a column
    // the notification path is perfectly willing to email.
    expect(withdrawnEmail(userId).endsWith('.invalid')).toBe(true);
  });

  it('carries nothing of the person', () => {
    const tombstone = withdrawnEmail(userId);
    for (const fragment of ['sam', 'example.com', '@gmail', 'Sam Okafor']) {
      expect(tombstone.toLowerCase()).not.toContain(fragment.toLowerCase());
    }
    // The id is the whole local part, so nothing about the old address survives —
    // not a hash of it, not a first initial, not the domain.
    expect(tombstone).toBe(`withdrawn-${userId}@closed.crewquo.invalid`);
  });

  it('is unique per account, so two closures cannot collide on the email index', () => {
    expect(withdrawnEmail('a')).not.toBe(withdrawnEmail('b'));
  });

  it('replaces the name with an attribution rather than a blank', () => {
    // §13.1 chose "attributed to a withdrawn person" over "attributed to nobody":
    // an empty actor column reads as a broken audit trail, not as somebody who left.
    expect(WITHDRAWN_PERSON_NAME.trim().length).toBeGreaterThan(0);
  });
});

describe('the closure plans', () => {
  const scopes = [
    { name: 'PERSONAL', plan: PERSONAL_CLOSURE_PLAN },
    { name: 'COMPANY', plan: COMPANY_CLOSURE_PLAN },
  ] as const;

  it.each(scopes)('$name names each table once', ({ plan }) => {
    const tables = plan.map((step) => step.table);
    // Two steps for one table is two answers to "what happens to this", and the
    // executor would obey whichever it reached second.
    expect(new Set(tables).size).toBe(tables.length);
  });

  it.each(scopes)('$name gives every step a reason worth reading', ({ plan }) => {
    for (const step of plan) {
      expect(step.because.length, `${step.table} has no argument`).toBeGreaterThan(40);
    }
  });

  /**
   * The canary, and the one failure in this file that would be a data-integrity
   * attack rather than an omission.
   *
   * §10: one tenant's closure may never remove another tenant's record of a shared
   * fact. The way a hand-written plan fails is somebody adding one plausible line,
   * and `time_logs` in a column of twenty table names does not look wrong at a
   * glance.
   */
  it.each(scopes)('$name never removes a jointly-held table', ({ plan }) => {
    for (const step of plan) {
      if (step.action !== 'REMOVE') continue;
      expect(
        NEVER_REMOVED_TABLES.includes(step.table),
        `${step.table} is jointly held and this plan removes it`
      ).toBe(false);
    }
  });

  it('preserves the hours on a personal closure, which is the whole policy', () => {
    const step = PERSONAL_CLOSURE_PLAN.find((s) => s.table === 'time_logs');
    expect(step?.action).toBe('PRESERVE');
  });

  it('ends a company but keeps the relationship record', () => {
    expect(COMPANY_CLOSURE_PLAN.find((s) => s.table === 'engagements')?.action).toBe('PRESERVE');
    expect(COMPANY_CLOSURE_PLAN.find((s) => s.table === 'projects')?.action).toBe('PRESERVE');
  });

  it('never lets a closure reset trial eligibility', () => {
    // §3.1.1(5). 0011 already refused to cascade these for exactly this loophole;
    // a plan that removed them would reopen it from the other end.
    for (const plan of Object.values(CLOSURE_PLANS)) {
      for (const table of ['trial_grants', 'company_creation_allowances']) {
        const step = plan.find((s) => s.table === table);
        if (step) expect(step.action, `${table} must survive a closure`).toBe('PRESERVE');
      }
    }
  });

  it('removes every credential on a personal closure', () => {
    for (const table of ['refresh_tokens', 'auth_factors', 'auth_recovery_codes', 'push_tokens']) {
      expect(
        PERSONAL_CLOSURE_PLAN.find((s) => s.table === table)?.action,
        `${table} is a credential and must not survive`
      ).toBe('REMOVE');
    }
  });
});

describe('what is said before the button', () => {
  /**
   * §13.1 committed the product to one specific sentence, *before* the button
   * rather than after it: "the hours you logged remain, without your name on them."
   * The place that commitment gets lost is a dialog saying "this cannot be undone"
   * and nothing else — which is equally true of a promise kept and a promise broken.
   */
  it('makes the promise that cannot be kept in full, explicitly', () => {
    const text = PERSONAL_CLOSURE_PROMISES.join(' ');
    expect(text).toContain('The hours you logged remain, without your name on them');
  });

  it('says the sign-in ends and the copy has to be taken first', () => {
    const text = PERSONAL_CLOSURE_PROMISES.join(' ').toLowerCase();
    expect(text).toContain('sign in');
    expect(text).toContain('download your data');
    expect(text).toContain(`${DELETION_COOLING_OFF_DAYS} days`);
  });

  it("tells a company it cannot erase somebody else's record of trading with it", () => {
    const text = COMPANY_CLOSURE_PROMISES.join(' ').toLowerCase();
    expect(text).toContain('remain theirs');
    expect(text).toContain('counterpart');
  });
});

describe('preconditions', () => {
  it('lets an ordinary person go', () => {
    expect(personalClosureBlocks({ soleOwnerOf: [] })).toEqual([]);
  });

  it('names the company a sole owner has to hand over', () => {
    const [block] = personalClosureBlocks({ soleOwnerOf: ['Northgate Interiors'] });
    // Named rather than counted: "you are the only owner of 1 company" tells
    // somebody nothing they can act on.
    expect(block).toContain('Northgate Interiors');
    expect(block).toContain('owner');
  });

  it('lets a settled company go', () => {
    expect(companyClosureBlocks({ liveEngagements: 0, unsettledInvoices: 0 })).toEqual([]);
  });

  it('blocks on a live engagement and on money outstanding, separately', () => {
    const blocks = companyClosureBlocks({ liveEngagements: 2, unsettledInvoices: 1 });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('2 engagements are still live');
    // Singular, because "1 issued invoices is" is the sentence a customer screenshots.
    expect(blocks[1]).toContain('1 issued invoice is');
  });
});

describe('the request contract', () => {
  it('requires the subject to be typed out', () => {
    // A checkbox is one click away from an accident on the most irreversible screen
    // in the product.
    expect(requestDeletionSchema.safeParse({}).success).toBe(false);
    expect(requestDeletionSchema.safeParse({ confirm: '' }).success).toBe(false);
    expect(requestDeletionSchema.safeParse({ confirm: 'Northgate' }).success).toBe(true);
  });

  it('carries a step-up proof when one is offered', () => {
    const parsed = requestDeletionSchema.parse({ confirm: 'x', password: 'hunter2' });
    expect(parsed.password).toBe('hunter2');
  });
});
