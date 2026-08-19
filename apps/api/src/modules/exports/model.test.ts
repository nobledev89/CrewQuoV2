import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '@crewquo/shared';
import {
  EXPENSE_TABLE_HEAD,
  NOT_AVAILABLE,
  PRICING_GAP_NOTE,
  PROVIDER_TABLE_HEAD,
  TIME_TABLE_HEAD,
  exportFilename,
  expenseRows,
  formatDateRange,
  formatHours,
  formatMoney,
  formatPercent,
  formatTimestamp,
  hasPricingGap,
  headerRows,
  providerRows,
  summaryRows,
  timeRows,
  type ProjectExportModel,
} from './model';

/**
 * Export model tests (§13, §44 — tests written with the code).
 *
 * These pin the two things that would quietly corrupt a client-facing document:
 * a null rendering as zero, and money formatted differently in two places. The
 * SQL assembly and the two renderers are exercised by the live-Postgres
 * end-to-end script; everything decision-shaped lives here.
 */

function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: '11111111-1111-1111-1111-111111111111',
    currency: 'USD',
    approvedTimeLogs: 1,
    approvedExpenses: 0,
    laborCostCents: 40000,
    expenseCostCents: 0,
    totalCostCents: 40000,
    billCents: 64000,
    marginCents: 24000,
    marginPct: 37.5,
    byProvider: [
      {
        providerCompanyId: '22222222-2222-2222-2222-222222222222',
        providerCompanyName: 'Northgate Electrical',
        approvedTimeLogs: 1,
        laborCostCents: 40000,
        expenseCostCents: 0,
      },
    ],
    ...overrides,
  };
}

function model(overrides: Partial<ProjectExportModel> = {}): ProjectExportModel {
  return {
    generatedAt: '2026-08-17T09:30:00.000Z',
    generatedByName: 'Dana Reyes',
    ownerCompanyName: 'Meridian Contracts',
    clientCompanyName: 'Harbour Group',
    project: {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Pier 9 Fit-Out',
      status: 'ACTIVE',
      startsOn: '2026-07-20',
      endsOn: null,
      notes: null,
    },
    summary: summary(),
    timeLines: [
      {
        date: '2026-07-24',
        providerName: 'Northgate Electrical',
        roleName: 'Electrician',
        shiftType: 'NIGHT',
        rateLabel: 'FRI_SAT_NIGHT',
        hoursRegular: 8,
        hoursOt: 0,
        payCents: 40000,
      },
    ],
    expenseLines: [],
    ...overrides,
  };
}

describe('formatMoney', () => {
  it('renders minor units as major units with the currency code', () => {
    expect(formatMoney(40000, 'USD')).toBe('USD 400.00');
    expect(formatMoney(0, 'USD')).toBe('USD 0.00');
  });
  it('renders a null as n/a, never as zero', () => {
    // A missing BILL card means "not priced yet" (§6). Printing 0.00 would
    // understate an invoice and read as a complete total.
    expect(formatMoney(null, 'USD')).toBe(NOT_AVAILABLE);
    expect(formatMoney(null, 'USD')).not.toContain('0');
  });
  it('keeps whichever currency the company is on', () => {
    expect(formatMoney(5000, 'PHP')).toContain('PHP');
    expect(formatMoney(5000, 'GBP')).toContain('GBP');
  });
  it('passes an unrecognised but well-formed code straight through', () => {
    // Intl accepts any 3-letter code and echoes it, which is what we want: a
    // company on a currency ICU has never heard of still gets a readable export.
    expect(formatMoney(5000, 'ZZZ')).toBe('ZZZ 50.00');
  });
  it('falls back rather than throwing on a malformed code', () => {
    // `currencyCodeSchema` blocks these at the edge, so this only guards against
    // legacy rows — but an export must never 500 over a display label.
    expect(formatMoney(5000, 'US')).toBe('50.00 US');
  });
  it('rounds half-cent-free — cents in, exact decimals out', () => {
    expect(formatMoney(1, 'USD')).toBe('USD 0.01');
    expect(formatMoney(123456789, 'USD')).toBe('USD 1,234,567.89');
  });
});

describe('formatPercent / formatHours', () => {
  it('pins a margin to two decimals', () => {
    expect(formatPercent(37.5)).toBe('37.50%');
    expect(formatPercent(0)).toBe('0.00%');
  });
  it('renders a null margin as n/a', () => {
    expect(formatPercent(null)).toBe(NOT_AVAILABLE);
  });
  it('renders hours to two decimals', () => {
    expect(formatHours(8)).toBe('8.00');
    expect(formatHours(1.5)).toBe('1.50');
  });
});

describe('hasPricingGap', () => {
  it('is false when every line priced', () => {
    expect(hasPricingGap(model())).toBe(false);
  });
  it('is true when the bill total came back null', () => {
    expect(hasPricingGap(model({ summary: summary({ billCents: null }) }))).toBe(true);
  });
});

describe('summaryRows', () => {
  it('shows cost, bill and margin against the company currency', () => {
    const rows = summaryRows(model());
    expect(rows.find((r) => r.label === 'Total cost')?.value).toBe('USD 400.00');
    expect(rows.find((r) => r.label === 'Client bill (BILL)')?.value).toBe('USD 640.00');
    expect(rows.find((r) => r.label === 'Margin')?.value).toBe('USD 240.00');
    expect(rows.find((r) => r.label === 'Margin %')?.value).toBe('37.50%');
  });
  it('marks bill and margin n/a together when pricing is incomplete', () => {
    const rows = summaryRows(
      model({ summary: summary({ billCents: null, marginCents: null, marginPct: null }) })
    );
    expect(rows.find((r) => r.label === 'Client bill (BILL)')?.value).toBe(NOT_AVAILABLE);
    expect(rows.find((r) => r.label === 'Margin')?.value).toBe(NOT_AVAILABLE);
    expect(rows.find((r) => r.label === 'Margin %')?.value).toBe(NOT_AVAILABLE);
    // Cost is unaffected: PAY snapshots are frozen and always present.
    expect(rows.find((r) => r.label === 'Total cost')?.value).toBe('USD 400.00');
  });
  it('emphasises the totals a reader looks for first', () => {
    const emphasised = summaryRows(model())
      .filter((r) => r.emphasis)
      .map((r) => r.label);
    expect(emphasised).toEqual(['Total cost', 'Margin']);
  });
});

describe('headerRows', () => {
  it('states who generated the document, when, and for whom', () => {
    const rows = headerRows(model());
    expect(rows.find((r) => r.label === 'Project')?.value).toBe('Pier 9 Fit-Out');
    expect(rows.find((r) => r.label === 'Client')?.value).toBe('Harbour Group');
    expect(rows.find((r) => r.label === 'Generated by')?.value).toBe('Dana Reyes');
  });
  it('keeps the timestamp and the author in separate rows', () => {
    // Combined, the string is wide enough to be truncated out of the PDF header,
    // and provenance is the last thing that should lose a layout argument.
    const rows = headerRows(model());
    expect(rows.find((r) => r.label === 'Generated')?.value).toBe('2026-08-17 09:30 UTC');
    expect(rows.some((r) => r.value.includes('T09:30:00.000Z'))).toBe(false);
  });
  it('renders an open-ended project without inventing an end date', () => {
    expect(headerRows(model()).find((r) => r.label === 'Dates')?.value).toBe('2026-07-20 to open');
  });
  it('marks a client-less project n/a rather than leaving a blank', () => {
    const rows = headerRows(model({ clientCompanyName: null }));
    expect(rows.find((r) => r.label === 'Client')?.value).toBe(NOT_AVAILABLE);
  });
});

describe('providerRows / timeRows / expenseRows', () => {
  it('totals each provider as labour plus expenses', () => {
    const rows = providerRows(
      model({
        summary: summary({
          byProvider: [
            {
              providerCompanyId: '22222222-2222-2222-2222-222222222222',
              providerCompanyName: 'Northgate Electrical',
              approvedTimeLogs: 2,
              laborCostCents: 40000,
              expenseCostCents: 1550,
            },
          ],
        }),
      })
    );
    expect(rows[0]).toEqual([
      'Northgate Electrical',
      '2',
      'USD 400.00',
      'USD 15.50',
      'USD 415.50',
    ]);
  });

  it('prints the rate label frozen on the snapshot', () => {
    expect(timeRows(model())[0]).toEqual([
      '2026-07-24',
      'Northgate Electrical',
      'Electrician',
      'NIGHT',
      'FRI_SAT_NIGHT',
      '8.00',
      '0.00',
      'USD 400.00',
    ]);
  });

  it('dashes a line whose log carries no snapshot instead of costing it at zero', () => {
    const rows = timeRows(
      model({
        timeLines: [
          {
            date: '2026-07-24',
            providerName: 'Northgate Electrical',
            roleName: 'Electrician',
            shiftType: 'NIGHT',
            rateLabel: null,
            hoursRegular: 8,
            hoursOt: 2,
            payCents: null,
          },
        ],
      })
    );
    expect(rows[0]?.[4]).toBe(NOT_AVAILABLE);
    expect(rows[0]?.[7]).toBe(NOT_AVAILABLE);
  });

  it('falls back through description → category → dash on an expense', () => {
    const rows = expenseRows(
      model({
        expenseLines: [
          {
            date: '2026-07-24',
            providerName: 'Northgate Electrical',
            category: 'TRAVEL',
            description: null,
            amountCents: 1550,
          },
        ],
      })
    );
    expect(rows[0]).toEqual([
      '2026-07-24',
      'Northgate Electrical',
      'TRAVEL',
      NOT_AVAILABLE,
      'USD 15.50',
    ]);
  });
});

describe('exportFilename', () => {
  it('slugs the project name', () => {
    expect(exportFilename('Pier 9 Fit-Out', 'abcdef12-0000-0000-0000-000000000000', 'pdf')).toBe(
      'pier-9-fit-out.pdf'
    );
    expect(exportFilename('Pier 9 Fit-Out', 'abcdef12-0000-0000-0000-000000000000', 'xlsx')).toBe(
      'pier-9-fit-out.xlsx'
    );
  });
  it('strips characters that would break a Content-Disposition header', () => {
    const name = exportFilename('Ré"sumé; drop\r\nX-Evil: 1', '99999999-0000-0000-0000-0', 'pdf');
    expect(name).toBe('re-sume-drop-x-evil-1.pdf');
    expect(name).not.toMatch(/["\r\n;]/);
  });
  it('caps the length so a long name cannot run away with the header', () => {
    const long = exportFilename('x'.repeat(500), '99999999-0000-0000-0000-0', 'xlsx');
    expect(long.length).toBeLessThanOrEqual(60 + '.xlsx'.length);
  });
  it('falls back to the project id when a name slugs to nothing', () => {
    expect(exportFilename('日本語', 'abcdef12-3456-0000-0000-000000000000', 'pdf')).toBe(
      'project-abcdef12.pdf'
    );
  });
  it('folds accents instead of chopping the word at them', () => {
    expect(exportFilename('Café Refit', '99999999-0000-0000-0000-0', 'pdf')).toBe('cafe-refit.pdf');
  });
});

describe('ASCII-only output (jsPDF encodes Latin-1)', () => {
  /**
   * jsPDF's built-in Helvetica has no codepoint for an em dash, an ellipsis or an
   * arrow, and drops them from the page rather than substituting anything. That
   * failure is invisible — a truncated value reads as complete and an unpriced
   * line reads as blank — so the constraint is pinned here rather than left to
   * whoever next reaches for a nicer-looking dash.
   */
  const NON_ASCII = /[^\x20-\x7E]/;

  function everyStringFrom(m: ProjectExportModel): string[] {
    return [
      ...headerRows(m).flatMap((r) => [r.label, r.value]),
      ...summaryRows(m).flatMap((r) => [r.label, r.value]),
      ...PROVIDER_TABLE_HEAD,
      ...TIME_TABLE_HEAD,
      ...EXPENSE_TABLE_HEAD,
      ...providerRows(m).flat(),
      ...timeRows(m).flat(),
      ...expenseRows(m).flat(),
      PRICING_GAP_NOTE,
      NOT_AVAILABLE,
    ];
  }

  it('emits no character outside printable ASCII, fully populated', () => {
    expect(everyStringFrom(model()).filter((v) => NON_ASCII.test(v))).toEqual([]);
  });

  it('emits no character outside printable ASCII when everything is null', () => {
    const bare = model({
      clientCompanyName: null,
      summary: summary({ billCents: null, marginCents: null, marginPct: null }),
      project: {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Untitled',
        status: 'PLANNED',
        startsOn: null,
        endsOn: null,
        notes: null,
      },
      timeLines: [
        {
          date: '2026-07-24',
          providerName: 'Northgate',
          roleName: 'Electrician',
          shiftType: 'NIGHT',
          rateLabel: null,
          hoursRegular: 0,
          hoursOt: 0,
          payCents: null,
        },
      ],
      expenseLines: [
        {
          date: '2026-07-24',
          providerName: 'Northgate',
          category: null,
          description: null,
          amountCents: 0,
        },
      ],
    });
    expect(everyStringFrom(bare).filter((v) => NON_ASCII.test(v))).toEqual([]);
  });

  it('formats money without the non-breaking space Intl inserts', () => {
    expect(formatMoney(40000, 'USD')).toBe('USD 400.00');
    expect(NON_ASCII.test(formatMoney(40000, 'USD'))).toBe(false);
  });

  it('formats a date range and a timestamp in ASCII', () => {
    expect(NON_ASCII.test(formatDateRange('2026-07-20', null))).toBe(false);
    expect(formatTimestamp('2026-08-17T09:30:00.000Z')).toBe('2026-08-17 09:30 UTC');
  });
});
