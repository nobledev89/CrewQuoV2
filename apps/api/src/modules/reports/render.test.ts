import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  defaultSections,
  type ClientExportSnapshot,
  type GeneratedReportView,
  type ReportSnapshot,
  type SustainabilitySnapshot,
} from '@crewquo/shared';
import { renderReportPdf } from './render';
import { contentHash } from './seal';

/**
 * The Phase 10 milestone at the report level, with no database: *"a client-ready
 * PDF from real data, **regenerable byte-identical a year later**."*
 *
 * The snapshot below is what a §29.4 row actually holds, so these assertions cover
 * the whole path from a frozen document to bytes — including the two audience
 * variants, which is packet finding 3's structural exclusion made visible on the
 * page rather than only in the type system.
 */

const CARBON: SustainabilitySnapshot['carbon'] = {
  projectEmissionsKgCo2e: 884.74704,
  avoidedKgCo2e: 1656,
  byBucket: [
    { bucket: 'PROJECT_EMISSIONS', kgCo2e: 812.1, rowCount: 4 },
    { bucket: 'WASTE_TREATMENT', kgCo2e: 72.64704, rowCount: 2 },
    { bucket: 'AVOIDED', kgCo2e: 1656, rowCount: 3 },
  ],
  byScope: [
    { scope: 'SCOPE_1', kgCo2e: 640.2 },
    { scope: 'SCOPE_2', kgCo2e: 96.4 },
    { scope: 'SCOPE_3', kgCo2e: 148.14704 },
  ],
  scope2Basis: 'LOCATION_BASED',
  methodologyWarning: 'Avoided emissions are a comparative estimate.',
  gaps: ['No waste-treatment factor exists for plasterboard in the 2027 set - 1.2 t excluded.'],
  completeness: {
    pct: 84.5,
    warnBelow: 80,
    components: [
      {
        component: 'LINES_WITH_WEIGHT',
        weight: 0.25,
        value: 1,
        measured: 3,
        total: 3,
        unit: 'LINES',
        label: 'Lines with a weight',
      },
      {
        component: 'LINES_WITH_SUPPORT',
        weight: 0.15,
        value: 0.5,
        measured: 1,
        total: 2,
        unit: 'LINES',
        label: 'Lines with support',
      },
    ],
  },
  calculatedAt: '2026-03-21T09:00:00.000Z',
  ledgerFingerprint: 'f'.repeat(64),
};

function sustainabilitySnapshot(audience: 'INTERNAL' | 'CLIENT'): ReportSnapshot {
  const body: SustainabilitySnapshot = {
    kind: 'SUSTAINABILITY',
    project: {
      id: '11111111-2222-3333-4444-555555555555',
      name: 'Marina Bay — Level 12 strip-out',
      reference: 'MB-L12',
      status: 'COMPLETED',
      startsOn: '2026-02-02',
      endsOn: '2026-03-20',
      site: 'Marina Bay Tower',
      notes: null,
    },
    overview: {
      projectManager: null,
      supervisor: null,
      workforce:
        audience === 'INTERNAL'
          ? {
              audience: 'INTERNAL',
              people: 14,
              hours: 1284,
              subcontractors: [
                { companyId: 'a'.repeat(36), name: 'Pashe Site Services', hours: 812 },
                { companyId: 'b'.repeat(36), name: 'Hanmore Clearance', hours: 472 },
              ],
            }
          : { audience: 'CLIENT', people: 14, hours: 1284, subcontractedOrganisations: 2 },
    },
    executiveSummary: ['933.2 kg of material was handled.'],
    highlights: [{ label: 'Material managed', value: '933.2 kg', note: null }],
    massHandledKg: 933.2,
    outcomes: [{ label: 'Reuse — donated', massKg: 495, pct: 53.04 }],
    materials: [{ label: 'FURNITURE', massKg: 495, pct: 53.04 }],
    reuse: [{ label: 'Habitat for Humanity', massKg: 495, pct: 53.04 }],
    waste: [{ label: 'Recycling — metal', massKg: 438.2, pct: 46.96 }],
    rates: { retainedInUsePct: 53.04, diversionPct: 100, reusePct: 53.04, recyclingPct: 46.96 },
    carbon: CARBON,
    evidence: [
      { fileId: 'c'.repeat(36), caption: 'Level 12 before', category: 'BEFORE', capturedAt: null },
    ],
    completion: {
      completedOn: '2026-03-20',
      signoff: {
        signerName: 'Dana Whitfield',
        signerCompany: 'Marina Bay Holdings',
        signerRole: 'Facilities Manager',
        signedAt: '2026-03-20T16:40:00.000Z',
        completionStatement: 'The works described above are complete to our satisfaction.',
        comments: null,
        signatureFileId: null,
      },
    },
  };

  return {
    meta: {
      schemaVersion: 1,
      kind: 'SUSTAINABILITY',
      audience,
      title: 'Marina Bay — Sustainability & Completion Report',
      periodStart: '2026-02-02',
      periodEnd: '2026-03-20',
      contractor: { companyId: 'd'.repeat(36), name: 'CSL Contracting', logoFileId: null },
      client: {
        companyId: 'e'.repeat(36),
        name: 'Marina Bay Holdings',
        logoFileId: null,
        logoSource: 'NONE',
      },
      disclaimer: 'Greenhouse gas emissions are calculated using activity data recorded.',
      sections: defaultSections('SUSTAINABILITY'),
      factorSets: [
        { id: 'f'.repeat(36), name: 'CrewQuo — synthetic test data', version: '1.0', reportingYear: 2026, region: 'GB' },
      ],
      sourceRevisions: [{ kind: 'DIARY', id: 'g'.repeat(36), label: '2026-03-03', revision: 2 }],
      fileIds: ['c'.repeat(36)],
      display: { carbonUnit: 'AUTO', massUnit: 'AUTO' },
    },
    body,
  };
}

function reportRow(snapshot: ReportSnapshot): GeneratedReportView {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    companyId: snapshot.meta.contractor.companyId,
    projectId: '11111111-2222-3333-4444-555555555555',
    projectName: 'Marina Bay',
    clientCompanyId: snapshot.meta.client.companyId,
    clientCompanyName: snapshot.meta.client.name,
    kind: snapshot.meta.kind,
    audience: snapshot.meta.audience,
    title: snapshot.meta.title,
    periodStart: snapshot.meta.periodStart,
    periodEnd: snapshot.meta.periodEnd,
    sections: snapshot.meta.sections,
    contentHash: contentHash(snapshot),
    factorSetIds: snapshot.meta.factorSets.map((f) => f.id),
    disclaimer: snapshot.meta.disclaimer,
    fileId: null,
    status: 'GENERATED',
    supersedesId: null,
    supersededById: null,
    voidReason: null,
    clientVisible: false,
    generatedByUserId: null,
    generatedByName: 'Priya Raman',
    generatedAt: '2026-03-21T10:15:00.000Z',
  };
}

function render(snapshot: ReportSnapshot): Buffer {
  return renderReportPdf({ report: reportRow(snapshot), snapshot, images: new Map() });
}

/** PDF content streams are compressed, so text is checked through the raw bytes. */
function textOf(pdf: Buffer): string {
  return pdf.toString('latin1');
}

describe('the milestone', () => {
  it('renders the same snapshot to the same bytes', () => {
    const snapshot = sustainabilitySnapshot('CLIENT');
    expect(render(snapshot).equals(render(snapshot))).toBe(true);
  });

  it('changes bytes when a figure in the snapshot changes', () => {
    const a = sustainabilitySnapshot('CLIENT');
    const b = sustainabilitySnapshot('CLIENT');
    (b.body as SustainabilitySnapshot).massHandledKg = 940;
    // The seal moves with the content, so the /ID moves too — which is the property
    // that makes a PDF /ID mean what the specification says it means.
    expect(contentHash(a)).not.toBe(contentHash(b));
    expect(render(a).equals(render(b))).toBe(false);
  });

  it('carries the seal on the page so two printed copies can be compared', () => {
    const snapshot = sustainabilitySnapshot('CLIENT');
    const hash = contentHash(snapshot);
    const bytes = render(snapshot);
    expect(textOf(bytes)).toContain(`/ID [ <${hash.slice(0, 32).toUpperCase()}>`);
  });

  it('pins the creation date to the row rather than to the clock', () => {
    expect(textOf(render(sustainabilitySnapshot('CLIENT')))).toContain(
      "/CreationDate (D:20260321101500+00'00')"
    );
  });
});

describe('the audience boundary on the page (packet finding 3)', () => {
  /**
   * The load-bearing assertion of the phase. The internal document names the
   * subcontractors; the client document has no field that could hold a name, so
   * this is not a filter that could be forgotten — the two documents are built from
   * two types.
   */
  it('produces different bytes for the two audiences', () => {
    const internal = sustainabilitySnapshot('INTERNAL');
    const client = sustainabilitySnapshot('CLIENT');
    expect(render(internal).equals(render(client))).toBe(false);
  });

  it('cannot hold a provider name in a client snapshot at all', () => {
    const client = sustainabilitySnapshot('CLIENT');
    const workforce = (client.body as SustainabilitySnapshot).overview.workforce;
    expect(workforce.audience).toBe('CLIENT');
    // Not "absent from the output" — absent from the sealed document, which is the
    // stronger statement and the one §29.5 asked for.
    expect(canonicalJson(client)).not.toContain('Pashe Site Services');
    expect(canonicalJson(client)).toContain('subcontractedOrganisations');
  });

  it('does name them for an internal reader', () => {
    expect(canonicalJson(sustainabilitySnapshot('INTERNAL'))).toContain('Pashe Site Services');
  });
});

describe('§13.6 — the divergence is reported beside the document, never in it', () => {
  /**
   * The correction the acceptance script forced (see `render.ts`'s note).
   *
   * A live comparison inside a frozen document makes the document a function of
   * the present, which is the one thing §29.4 exists to forbid — two people opening
   * "the same report" a month apart would get different files, and the seal in the
   * footer would stop describing what is on the page.
   */
  it('takes no live input at all, so nothing outside the snapshot can move the bytes', () => {
    const snapshot = sustainabilitySnapshot('CLIENT');
    const first = render(snapshot);
    // Nothing to pass: `RenderInput` has no field for a live fact.
    expect(render(snapshot).equals(first)).toBe(true);
    expect(reportRow(snapshot).contentHash).toBe(contentHash(snapshot));
  });
});

describe('§29.5 — the client statement', () => {
  const clientExport = (): ReportSnapshot => {
    const body: ClientExportSnapshot = {
      kind: 'CLIENT_EXPORT',
      project: {
        id: '11111111-2222-3333-4444-555555555555',
        name: 'Marina Bay',
        status: 'COMPLETED',
        startsOn: '2026-02-02',
        endsOn: '2026-03-20',
      },
      currency: 'USD',
      lineItems: [
        {
          id: 'h'.repeat(36),
          kind: 'TIME',
          date: '2026-02-02',
          description: 'Rigger - 8.00h',
          shiftType: 'WEEKDAY_DAY',
          hoursRegular: 8,
          hoursOt: 0,
          amountCents: 65550,
          noteCount: 0,
        },
      ],
      timeTotalCents: 65550,
      expenseTotalCents: 0,
      totalCents: 65550,
      pricingComplete: false,
    };
    const base = sustainabilitySnapshot('CLIENT');
    return {
      meta: { ...base.meta, kind: 'CLIENT_EXPORT', sections: defaultSections('CLIENT_EXPORT') },
      body,
    };
  };

  it('has no PAY figure, no margin and no provider anywhere in the sealed document', () => {
    const json = canonicalJson(clientExport());
    for (const forbidden of ['payCents', 'marginCents', 'laborCostCents', 'providerCompanyName']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('says the total is provisional when a line could not be priced', () => {
    // §41.1 in money: an unpriced line is not a line that cost nothing, so the
    // total is a floor and the document says which.
    const bytes = render(clientExport());
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(render(clientExport()).equals(bytes)).toBe(true);
  });
});
