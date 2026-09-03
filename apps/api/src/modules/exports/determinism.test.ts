import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDocument, seedFromParts } from './document';
import { renderProjectPdf } from './pdf';
import type { ProjectExportModel } from './model';

/**
 * The Phase 10 milestone, asserted at the lowest level it can be: *"regenerable
 * byte-identical a year later."*
 *
 * `docs/operating-model/reporting-signoff.md` §0 finding 1. Without
 * `document.ts`, every assertion in this file fails — jsPDF stamps a wall-clock
 * `/CreationDate` carrying the rendering machine's UTC offset, and a `/ID` of 32
 * hex characters from `Math.random()`. The pages are identical; the files are not.
 *
 * These tests are cheap and they guard the whole phase, because everything §29.4
 * promises rests on the renderer being a pure function of its input.
 */

const MODEL: ProjectExportModel = {
  generatedAt: '2026-09-03T07:21:26.482Z',
  generatedByName: 'Priya Raman',
  ownerCompanyName: 'CSL Contracting',
  clientCompanyName: 'Marina Bay Holdings',
  project: {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'Marina Bay — Level 12 strip-out',
    status: 'COMPLETED',
    startsOn: '2026-02-02',
    endsOn: '2026-03-20',
    notes: 'Handover pack issued to the client on completion.',
  },
  summary: {
    currency: 'USD',
    projectId: '11111111-2222-3333-4444-555555555555',
    approvedTimeLogs: 2,
    approvedExpenses: 1,
    laborCostCents: 40000,
    expenseCostCents: 5000,
    totalCostCents: 45000,
    billCents: 65550,
    // Phase 11's four, at the values a project with no variations has.
    approvedVariations: 0,
    variationSellCents: 0,
    variationCostCents: 0,
    revenueCents: 65550,
    marginCents: 20550,
    marginPct: 31.35,
    byProvider: [
      {
        providerCompanyId: '99999999-8888-7777-6666-555555555555',
        providerCompanyName: 'Pashe Site Services',
        approvedTimeLogs: 2,
        laborCostCents: 40000,
        expenseCostCents: 5000,
      },
    ],
  },
  timeLines: [
    {
      date: '2026-02-02',
      providerName: 'Pashe Site Services',
      roleName: 'Rigger',
      shiftType: 'WEEKDAY_DAY',
      rateLabel: 'MON_FRI_DAY',
      hoursRegular: 8,
      hoursOt: 2,
      payCents: 24000,
    },
    {
      date: '2026-02-03',
      providerName: 'Pashe Site Services',
      roleName: 'Rigger',
      shiftType: 'NIGHT',
      rateLabel: 'MON_THU_NIGHT',
      hoursRegular: 8,
      hoursOt: 0,
      payCents: 16000,
    },
  ],
  expenseLines: [
    {
      date: '2026-02-04',
      providerName: 'Pashe Site Services',
      category: 'Plant hire',
      description: 'Scissor lift, one day',
      amountCents: 5000,
    },
  ],
};

describe('createDocument', () => {
  it('produces identical bytes for identical content', () => {
    const render = (): Buffer => {
      const doc = createDocument({ seal: 'a'.repeat(64), createdAt: '2026-09-03T07:21:26.482Z' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(12);
      doc.text('One frozen document', 40, 60);
      doc.addPage();
      doc.text('Page two', 40, 60);
      return Buffer.from(doc.output('arraybuffer'));
    };
    expect(render().equals(render())).toBe(true);
  });

  it('writes the seal into the /ID rather than a random value', () => {
    const doc = createDocument({
      seal: '43b17ae68315704ac903261f454526c4ba30970bc6d855c3acea3105d5ecf737',
      createdAt: '2026-09-03T07:21:26.482Z',
    });
    const bytes = Buffer.from(doc.output('arraybuffer')).toString('latin1');
    expect(bytes).toContain('/ID [ <43B17AE68315704AC903261F454526C4>');
  });

  it('pins /CreationDate to UTC so the rendering machine cannot change the bytes', () => {
    const doc = createDocument({ seal: 'b'.repeat(64), createdAt: '2026-09-03T07:21:26.482Z' });
    const bytes = Buffer.from(doc.output('arraybuffer')).toString('latin1');
    expect(bytes).toContain("/CreationDate (D:20260903072126+00'00')");
    expect(bytes).not.toMatch(/CreationDate \(D:\d{14}[+-](?!00'00')/);
  });

  it('gives different documents different identities', () => {
    const a = seedFromParts('project-export', 'p1', '2026-09-03T00:00:00.000Z');
    const b = seedFromParts('project-export', 'p2', '2026-09-03T00:00:00.000Z');
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
  });
});

describe('renderProjectPdf', () => {
  it('is a pure function of its model', () => {
    const first = renderProjectPdf(MODEL);
    const second = renderProjectPdf(MODEL);
    expect(first.equals(second)).toBe(true);
    expect(first.byteLength).toBeGreaterThan(1000);
  });

  it('changes bytes when a figure changes', () => {
    const changed: ProjectExportModel = {
      ...MODEL,
      summary: { ...MODEL.summary, billCents: 70000 },
    };
    expect(renderProjectPdf(MODEL).equals(renderProjectPdf(changed))).toBe(false);
  });

  /**
   * The rule this file protects, stated as a test rather than as a comment
   * somebody has to find: a `new jsPDF()` outside `document.ts` is a document
   * nobody can reproduce, and the next renderer added to this codebase will be
   * written by someone who has not read the header above.
   */
  it('is the only way a PDF is constructed in this module', () => {
    const dir = join(import.meta.dirname, '.');
    for (const file of ['pdf.ts', 'model.ts', 'routes.ts', 'data.ts', 'xlsx.ts']) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source).not.toMatch(/new jsPDF\s*\(/);
    }
  });
});
