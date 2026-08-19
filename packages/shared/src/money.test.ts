import { describe, expect, it } from 'vitest';
import {
  TAX_IS_MANUAL_NOTICE,
  describeProjectCommitments,
  isCurrencyCode,
  reportingCurrencyPinRefusal,
} from './money';

/**
 * One test per rule (§13, §44).
 *
 * This file used to be 36 tests of exchange-rate arithmetic — exact `bigint`
 * conversion, as-of rate selection, unlike-currency refusals and citation guards.
 * All of it went on 2026-08-19 with the owner decision that **a company works in
 * exactly one currency and the currency is a label**. There is nothing to convert,
 * so there is nothing to get wrong about converting.
 *
 * What survives is the one way a pure label can still cause damage: relabelling
 * history. The stored minor units never move, so changing a project's currency
 * after money has committed leaves every number where it was and changes what all
 * of them *mean*.
 */

describe('currency codes', () => {
  it('accepts a three-letter uppercase code and nothing else', () => {
    expect(isCurrencyCode('USD')).toBe(true);
    expect(isCurrencyCode('usd')).toBe(false);
    expect(isCurrencyCode('US')).toBe(false);
    expect(isCurrencyCode('USDD')).toBe(false);
    expect(isCurrencyCode('')).toBe(false);
  });
});

describe('the project currency pin', () => {
  const empty = { approvedTimeLogs: 0, approvedExpenses: 0, liveInvoices: 0 };

  it('lets an empty project change its label', () => {
    expect(reportingCurrencyPinRefusal(empty)).toBeNull();
  });

  it('refuses once money is committed, and says what pins it', () => {
    const refusal = reportingCurrencyPinRefusal({ ...empty, approvedTimeLogs: 3 });
    expect(refusal).toContain('3 approved time logs');
    // The reason has to name the actual harm: the numbers do not move, their
    // meaning does.
    expect(refusal).toContain('relabel');
  });

  it('counts one of something as singular', () => {
    expect(reportingCurrencyPinRefusal({ ...empty, liveInvoices: 1 })).toContain('1 invoice');
    expect(reportingCurrencyPinRefusal({ ...empty, liveInvoices: 2 })).toContain('2 invoices');
  });

  it('lists every kind of commitment, not just the first', () => {
    expect(
      describeProjectCommitments({ approvedTimeLogs: 2, approvedExpenses: 1, liveInvoices: 4 })
    ).toBe('2 approved time logs, 1 approved expense and 4 invoices');
  });

  it('describes nothing as null rather than as an empty string', () => {
    // The caller branches on null; an empty string would read as "something is
    // committed, and it is nothing".
    expect(describeProjectCommitments(empty)).toBeNull();
  });
});

describe('the tax gate', () => {
  it('says the document is not a tax invoice, in those words', () => {
    // A half-built tax model is more dangerous than an honestly labelled manual
    // field, because it looks authoritative.
    expect(TAX_IS_MANUAL_NOTICE).toContain('not a tax invoice');
    expect(TAX_IS_MANUAL_NOTICE).toContain('does not calculate tax');
  });
});
