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
