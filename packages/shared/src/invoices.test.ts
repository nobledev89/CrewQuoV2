import { describe, expect, it } from 'vitest';
import {
  calculateInvoiceItemAmount,
  calculateInvoiceTotals,
  createInvoiceItemSchema,
} from './invoices';

describe('invoice calculations', () => {
  it('rounds a fractional quantity to the nearest cent', () => {
    expect(calculateInvoiceItemAmount(1.25, 999)).toBe(1249);
  });

  it('derives subtotal and total only from line amounts and tax', () => {
    expect(calculateInvoiceTotals([40_000, 24_000, 1_500], 7_860)).toEqual({
      subtotalCents: 65_500,
      taxCents: 7_860,
      totalCents: 73_360,
    });
  });

  it('does not accept client-supplied amounts for sourced work', () => {
    expect(
      createInvoiceItemSchema.safeParse({
        sourceType: 'TIME_LOG',
        sourceId: '1f67bba5-d5df-4c43-8e91-c22daf45cf12',
        unitAmountCents: 1,
      }).success
    ).toBe(false);
  });
});

/**
 * The regression for the defect Phase 11's packet found in Phase 6's arithmetic.
 *
 * `invoice_items` has carried `check (amount_cents = round(quantity *
 * unit_amount_cents))` since `0008`, and this function used to compute
 * `Math.round(quantity * unit)` — which disagrees with Postgres at the half-cent
 * boundary and reaches the caller as a 500 on a line somebody typed perfectly.
 */
describe('calculateInvoiceItemAmount agrees with the check constraint', () => {
  it('matches Postgres where IEEE 754 does not', () => {
    // 0.29 × 50 is exactly 14.50; the float is 14.499999999999998.
    expect(Math.round(0.29 * 50)).toBe(14);
    expect(calculateInvoiceItemAmount(0.29, 50)).toBe(15);
    expect(calculateInvoiceItemAmount(0.58, 25)).toBe(15);
    expect(calculateInvoiceItemAmount(1.13, 50)).toBe(57);
  });

  it('is unchanged for every ordinary line', () => {
    expect(calculateInvoiceItemAmount(1, 65_550)).toBe(65_550);
    expect(calculateInvoiceItemAmount(2, 4000)).toBe(8000);
    expect(calculateInvoiceItemAmount(7.5, 1200)).toBe(9000);
  });
});
