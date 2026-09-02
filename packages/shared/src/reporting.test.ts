import { describe, expect, it } from 'vitest';
import {
  CURRENT_BUILD_PHASE,
  REPORT_SECTIONS,
  availableSections,
  canonicalJson,
  defaultSections,
  describeChangedFigures,
  describeProhibitedClaims,
  describeStaleSources,
  fileIdFromContentHash,
  findProhibitedClaims,
  generateReportSchema,
  pdfCreationDate,
  resolveSections,
  type ReportKind,
} from './reporting';
import { DEFAULT_REPORT_DISCLAIMER } from './sustainability';

/**
 * Step 0 of the Phase 10 build order, tested **before anything is sealed** — the
 * rule §44 states for the carbon engine, applied to the thing that seals it.
 *
 * The two files that matter here are the canonical form (a seal that never
 * verifies is the same as no seal) and the claim guard (the only thing between an
 * editable text box and a PDF asserting a client's emissions were certified).
 */

describe('canonicalJson — key order', () => {
  it('is independent of insertion order', () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('sorts nested keys too, at every depth', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: [{ y: 1, x: 2 }] })).toBe(
      '{"a":[{"x":2,"y":1}],"b":{"c":2,"d":1}}'
    );
  });

  it('never sorts an array — order is content', () => {
    expect(canonicalJson(['c', 'a', 'b'])).toBe('["c","a","b"]');
  });

  /**
   * The `jsonb` round trip, which is packet finding 4's first limb. Postgres
   * reorders keys on write; this simulates it by re-serialising through a
   * shuffled reconstruction, because a real jsonb read gives an object whose key
   * order is Postgres's rather than ours.
   */
  it('survives a jsonb-style key reordering', () => {
    const snapshot = {
      meta: { kind: 'SUSTAINABILITY', audience: 'CLIENT', sections: ['COVER', 'EVIDENCE'] },
      body: { massHandledKg: 933.2, rates: { diversionPct: 91.8, reusePct: 62.4 } },
    };
    const before = canonicalJson(snapshot);
    // What comes back from pg: same values, arbitrary key order, numbers parsed.
    const roundTripped = JSON.parse(
      JSON.stringify({
        body: { rates: { reusePct: 62.4, diversionPct: 91.8 }, massHandledKg: 933.2 },
        meta: { sections: ['COVER', 'EVIDENCE'], audience: 'CLIENT', kind: 'SUSTAINABILITY' },
      })
    ) as unknown;
    expect(canonicalJson(roundTripped)).toBe(before);
  });
});

describe('canonicalJson — numbers', () => {
  it('normalises trailing-zero decimals to the same seal', () => {
    // `numeric(12,3)` renders 1.500 into jsonb; JSON.parse gives 1.5. The same
    // quantity has to seal the same way or every re-verification fails.
    expect(canonicalJson({ kg: JSON.parse('1.500') as number })).toBe(canonicalJson({ kg: 1.5 }));
  });

  it('treats -0 and 0 as one quantity', () => {
    expect(canonicalJson({ n: -0 })).toBe(canonicalJson({ n: 0 }));
  });

  it('keeps full precision', () => {
    expect(canonicalJson({ n: 0.1 + 0.2 })).toBe('{"n":0.30000000000000004}');
  });

  it('refuses non-finite numbers rather than emitting null', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/NaN/);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/Infinity/);
  });
});

describe('canonicalJson — what it refuses', () => {
  /**
   * The load-bearing refusal. `JSON.stringify` drops an undefined property
   * silently, so a builder with a typo'd field name would seal a document missing
   * a section and produce a hash that verifies perfectly for ever.
   */
  it('throws on undefined instead of dropping the key', () => {
    expect(() => canonicalJson({ a: 1, b: undefined })).toThrow(/undefined at \$\.b/);
  });

  it('names the path so the builder can be fixed', () => {
    expect(() => canonicalJson({ body: { rows: [{ massKg: undefined }] } })).toThrow(
      /\$\.body\.rows\.0\.massKg/
    );
  });

  it('throws on a Date rather than choosing a format for it', () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(/not JSON data/);
  });

  it('throws on bigint, Map and functions', () => {
    expect(() => canonicalJson({ n: 1n })).toThrow(/bigint/);
    expect(() => canonicalJson({ m: new Map() })).toThrow(/not JSON data/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/not JSON data/);
  });

  it('handles the scalars a snapshot actually contains', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson({ nested: null })).toBe('{"nested":null}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
  });
});

describe('the PDF determinism helpers (packet finding 1)', () => {
  it('derives a 32-character upper-case /ID from the content hash', () => {
    const id = fileIdFromContentHash(
      '43b17ae68315704ac903261f454526c4ba30970bc6d855c3acea3105d5ecf737'
    );
    expect(id).toBe('43B17AE68315704AC903261F454526C4');
    expect(id).toMatch(/^[A-F0-9]{32}$/);
  });

  it('refuses a hash too short to seed one', () => {
    expect(() => fileIdFromContentHash('abc')).toThrow(/32 hex/);
  });

  it('pins the creation date to UTC regardless of the rendering machine', () => {
    expect(pdfCreationDate('2026-09-03T07:21:26.482Z')).toBe("D:20260903072126+00'00'");
  });

  it('refuses a partial instant rather than padding one', () => {
    expect(() => pdfCreationDate('2026-09-03')).toThrow(/full ISO instant/);
  });
});

describe('the section catalog (packet finding 11)', () => {
  it('gives §29.1 its twelve sections, in order', () => {
    const keys = availableSections('SUSTAINABILITY').map((s) => s.key);
    expect(keys).toEqual([
      'COVER',
      'EXECUTIVE_SUMMARY',
      'PROJECT_OVERVIEW',
      'SUSTAINABILITY_HIGHLIGHTS',
      'ASSET_OUTCOMES',
      'MATERIAL_BREAKDOWN',
      'REUSE_DONATION',
      'RECYCLING_WASTE',
      'CARBON_SUMMARY',
      'CARBON_METHODOLOGY',
      'EVIDENCE',
      'PROJECT_COMPLETION',
    ]);
  });

  /**
   * The finding itself: a completion pack that asserts "no variations" about a
   * feature Phase 11 has not built is an invented fact, and it is the most
   * quotable line in the document during a dispute.
   */
  it('omits a Phase 11 section from a Phase 10 build entirely', () => {
    const keys = availableSections('EVIDENCE_PACK').map((s) => s.key);
    expect(keys).not.toContain('PACK_VARIATIONS');
    expect(defaultSections('EVIDENCE_PACK')).not.toContain('PACK_VARIATIONS');
  });

  it('offers it once the build reaches that phase', () => {
    expect(availableSections('EVIDENCE_PACK', 11).map((s) => s.key)).toContain('PACK_VARIATIONS');
  });

  it('never offers a section with no table anywhere in the plan', () => {
    for (const phase of [10, 11, 12, 13, 99]) {
      expect(availableSections('EVIDENCE_PACK', phase).map((s) => s.key)).not.toContain(
        'PACK_INCIDENTS'
      );
    }
  });

  it('drops an unknown or future key from a request rather than refusing it', () => {
    const resolved = resolveSections('EVIDENCE_PACK', [
      'PACK_SITE_DIARY',
      'PACK_VARIATIONS',
      'NOT_A_SECTION',
    ]);
    expect(resolved).toContain('PACK_SITE_DIARY');
    expect(resolved).not.toContain('PACK_VARIATIONS');
    expect(resolved).not.toContain('NOT_A_SECTION' as never);
  });

  /**
   * Order comes from the catalog, never from the caller: two reports of the same
   * project with the same figures in a different order would otherwise seal to
   * two different hashes and read as a change.
   */
  it('imposes catalog order on a shuffled request', () => {
    expect(resolveSections('SUSTAINABILITY', ['EVIDENCE', 'EXECUTIVE_SUMMARY'])).toEqual([
      'COVER',
      'EXECUTIVE_SUMMARY',
      'CARBON_METHODOLOGY',
      'EVIDENCE',
    ]);
  });

  it('keeps the non-toggleable sections even when they were not asked for', () => {
    const resolved = resolveSections('SUSTAINABILITY', []);
    expect(resolved).toEqual(['COVER', 'CARBON_METHODOLOGY']);
  });

  it('every catalog key belongs to exactly one kind', () => {
    const seen = new Map<string, ReportKind>();
    for (const spec of REPORT_SECTIONS) {
      expect(seen.has(spec.key)).toBe(false);
      seen.set(spec.key, spec.kind);
    }
  });

  it('nothing in the catalog is keyed to a phase this build has passed', () => {
    for (const spec of REPORT_SECTIONS) {
      if (spec.availableFrom !== null) expect(spec.availableFrom).toBeGreaterThanOrEqual(10);
    }
    expect(CURRENT_BUILD_PHASE).toBe(10);
  });
});

describe('findProhibitedClaims (§29.3)', () => {
  it('passes the shipped default disclaimer', () => {
    expect(findProhibitedClaims(DEFAULT_REPORT_DISCLAIMER)).toEqual([]);
  });

  it('refuses an independent-assurance claim', () => {
    const found = findProhibitedClaims(
      'These results have been independently verified by a competent third party.'
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe('INDEPENDENT_ASSURANCE');
    expect(found[0]!.phrase.toLowerCase()).toContain('independently verified');
  });

  it('refuses third-party and external variants', () => {
    expect(findProhibitedClaims('Third-party assured.')[0]!.rule).toBe('INDEPENDENT_ASSURANCE');
    expect(findProhibitedClaims('Externally audited results.')[0]!.rule).toBe(
      'INDEPENDENT_ASSURANCE'
    );
  });

  it('refuses certification against a named standard', () => {
    const found = findProhibitedClaims('This report is certified to ISO 14064-1.');
    expect(found[0]!.rule).toBe('STANDARD_CERTIFICATION');
  });

  it('refuses a GHG Protocol certification claim', () => {
    expect(findProhibitedClaims('GHG Protocol certified figures.')[0]!.rule).toBe(
      'STANDARD_CERTIFICATION'
    );
    expect(findProhibitedClaims('Accredited under the GHG Protocol.')[0]!.rule).toBe(
      'STANDARD_CERTIFICATION'
    );
  });

  it('refuses the formal assurance levels', () => {
    expect(findProhibitedClaims('A limited assurance engagement was performed.')[0]!.rule).toBe(
      'FORMAL_ASSURANCE_LEVEL'
    );
    expect(findProhibitedClaims('See the attached assurance statement.')[0]!.rule).toBe(
      'FORMAL_ASSURANCE_LEVEL'
    );
  });

  it('refuses a report certifying itself', () => {
    expect(findProhibitedClaims('We certify these emissions are complete.')[0]!.rule).toBe(
      'FIRST_PARTY_CERTIFICATION'
    );
  });

  // ── The near misses. Each of these is a sentence a disclaimer should be able
  //    to contain, and a guard that refuses the word "verified" refuses them all.

  it('allows VERIFIED as a weight confidence (§25.3)', () => {
    expect(
      findProhibitedClaims(
        'Asset weights recorded as VERIFIED are supported by a weighbridge ticket; others are estimated.'
      )
    ).toEqual([]);
  });

  it('allows referencing a standard the methodology follows', () => {
    expect(
      findProhibitedClaims(
        'The methodology is aligned with the GHG Protocol Corporate Standard and ISO 14064-1.'
      )
    ).toEqual([]);
  });

  /**
   * The sentence §29.3 most wants a customer to be able to write. A guard that
   * refused it would push people towards saying nothing at all, and silence reads
   * as assurance to a reader who does not know to ask.
   */
  it('allows an explicit denial of assurance', () => {
    expect(findProhibitedClaims('This report has not been independently verified.')).toEqual([]);
    expect(
      findProhibitedClaims('No third-party assurance has been obtained for these figures.')
    ).toEqual([]);
    expect(findProhibitedClaims('Prepared without external audit.')).toEqual([]);
  });

  it('does not launder a claim with a negation in an earlier sentence', () => {
    const found = findProhibitedClaims(
      'The waste figures are not estimated. These results have been independently verified.'
    );
    expect(found).toHaveLength(1);
  });

  it('allows an accredited waste carrier, which is about the carrier', () => {
    expect(
      findProhibitedClaims('Waste was collected by an accredited carrier under a transfer note.')
    ).toEqual([]);
  });

  /**
   * One report per overlapping match, not two. "A reasonable assurance opinion"
   * satisfies both halves of the assurance-level rule, and reporting it twice
   * would ask the customer to fix the same seven words in two places.
   */
  it('reports every distinct claim in a long disclaimer', () => {
    const found = findProhibitedClaims(
      'Independently verified. Certified to ISO 14064. A reasonable assurance opinion is attached.'
    );
    expect(found.map((c) => c.rule).sort()).toEqual([
      'FORMAL_ASSURANCE_LEVEL',
      'INDEPENDENT_ASSURANCE',
      'STANDARD_CERTIFICATION',
    ]);
  });

  it('carries the sentence so the customer can find it', () => {
    const found = findProhibitedClaims(
      'Figures are drawn from site records. These results have been independently verified. Contact us for detail.'
    );
    expect(found[0]!.excerpt).toBe('These results have been independently verified.');
  });

  it('is stable across repeated calls (no shared regex state)', () => {
    const text = 'Independently verified.';
    expect(findProhibitedClaims(text)).toHaveLength(1);
    expect(findProhibitedClaims(text)).toHaveLength(1);
    expect(findProhibitedClaims(text)).toHaveLength(1);
  });

  it('describes the first claim and counts the rest', () => {
    const claims = findProhibitedClaims('Independently verified. Certified to ISO 14064.');
    expect(describeProhibitedClaims(claims)).toMatch(/cannot appear in a report disclaimer/);
    expect(describeProhibitedClaims(claims)).toMatch(/and 1 other\)/);
    expect(describeProhibitedClaims([])).toBe('');
  });
});

describe('staleness sentences (§13.6)', () => {
  it('says a newer truth exists rather than that the document is wrong', () => {
    const [sentence] = describeStaleSources([
      { kind: 'DIARY', id: 'd1', label: '3 March 2026', revision: 2, currentRevision: 3 },
    ]);
    expect(sentence).toBe(
      'The site diary for 3 March 2026 has been amended since this report was generated.'
    );
    expect(sentence).not.toMatch(/out of date|incorrect|wrong/);
  });

  it('has a sentence for every source kind', () => {
    const sentences = describeStaleSources([
      { kind: 'ASSET', id: 'a', label: 'Task chair', revision: 1, currentRevision: 2 },
      { kind: 'MOVEMENT', id: 'm', label: 'Task chair', revision: 1, currentRevision: 2 },
      { kind: 'CALCULATIONS', id: null, label: 'project', revision: 1, currentRevision: 2 },
    ]);
    expect(sentences).toHaveLength(3);
    for (const s of sentences) expect(s).toMatch(/since this report was generated\.$/);
  });

  it('says nothing when nothing moved', () => {
    expect(describeStaleSources([])).toEqual([]);
  });
});

describe('generateReportSchema', () => {
  it('refuses an internal client-export, which has no meaning', () => {
    const parsed = generateReportSchema.safeParse({ kind: 'CLIENT_EXPORT', audience: 'INTERNAL' });
    expect(parsed.success).toBe(false);
  });

  it('accepts a client-facing sustainability report', () => {
    expect(
      generateReportSchema.safeParse({ kind: 'SUSTAINABILITY', audience: 'CLIENT' }).success
    ).toBe(true);
  });

  it('requires a period on a client-period report', () => {
    expect(
      generateReportSchema.safeParse({ kind: 'CLIENT_PERIOD', audience: 'CLIENT' }).success
    ).toBe(false);
    expect(
      generateReportSchema.safeParse({
        kind: 'CLIENT_PERIOD',
        audience: 'CLIENT',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
      }).success
    ).toBe(true);
  });

  it('refuses a backwards period', () => {
    expect(
      generateReportSchema.safeParse({
        kind: 'CLIENT_PERIOD',
        audience: 'CLIENT',
        periodStart: '2026-12-31',
        periodEnd: '2026-01-01',
      }).success
    ).toBe(false);
  });
});

describe('describeChangedFigures', () => {
  it('names both sides of a move', () => {
    expect(
      describeChangedFigures([{ label: 'Project emissions (kgCO2e)', from: 884.7, to: 901.2 }])
    ).toBe('Project emissions (kgCO2e): 884.7 → 901.2');
  });

  it('says "not calculated" rather than 0 for a null (§41.1)', () => {
    expect(describeChangedFigures([{ label: 'Avoided', from: null, to: 1656 }])).toBe(
      'Avoided: not calculated → 1656'
    );
  });

  it('is honest when only the supporting records moved', () => {
    expect(describeChangedFigures([])).toMatch(/no headline figure moved/);
  });
});
