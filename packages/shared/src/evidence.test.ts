import { describe, expect, it } from 'vitest';
import {
  ATTACHABLE_FILE_STATUSES,
  EVIDENCE_CATEGORIES,
  EVIDENCE_CATEGORY_LABELS,
  EVIDENCE_TIMESTAMP_PROVENANCE,
  applyBatchDefaults,
  compareEvidence,
  countByCategory,
  createEvidenceBatchSchema,
  disclosureNotice,
  evidenceBatchEventPayload,
  evidenceFilterSchema,
  groupByEvidenceDate,
  refuseAttachment,
  refuseFilter,
  summariseBatch,
  updateEvidenceSchema,
  type EvidenceView,
} from './evidence';
import { isServerAttested } from './sync';

function view(overrides: Partial<EvidenceView> = {}): EvidenceView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    companyId: '33333333-3333-4333-8333-333333333333',
    fileId: '44444444-4444-4444-8444-444444444444',
    webFileId: null,
    thumbFileId: null,
    category: 'BEFORE',
    caption: null,
    notes: null,
    evidenceDate: '2026-03-03',
    capturedAt: null,
    createdAt: '2026-03-05T09:00:00.000Z',
    locationId: null,
    gpsLat: null,
    gpsLng: null,
    gpsAccuracyM: null,
    clientVisible: false,
    firstPublishedAt: null,
    sortOrder: 0,
    uploadedByUserId: '55555555-5555-4555-8555-555555555555',
    batchClientId: null,
    revision: 1,
    deletedAt: null,
    updatedAt: '2026-03-05T09:00:00.000Z',
    fileStatus: 'READY',
    fileFailureReason: null,
    contentType: 'image/jpeg',
    byteSize: 1024,
    originalFilename: 'floor-3.jpg',
    ...overrides,
  };
}

describe('categories', () => {
  it('holds §22.2\'s fourteen and no more', () => {
    expect(EVIDENCE_CATEGORIES).toHaveLength(14);
    expect(EVIDENCE_CATEGORIES).toContain('BEFORE');
    expect(EVIDENCE_CATEGORIES).toContain('OTHER');
  });

  it('labels every one of them, so no screen invents a word', () => {
    for (const category of EVIDENCE_CATEGORIES) {
      expect(EVIDENCE_CATEGORY_LABELS[category]).toBeTruthy();
    }
  });
});

describe('applyBatchDefaults', () => {
  it('takes the batch value when the item says nothing', () => {
    const merged = applyBatchDefaults(
      { category: 'BEFORE', locationId: 'floor-3', evidenceDate: '2026-03-03' },
      {}
    );
    expect(merged.category).toBe('BEFORE');
    expect(merged.locationId).toBe('floor-3');
    expect(merged.evidenceDate).toBe('2026-03-03');
  });

  it('lets the item override the batch', () => {
    const merged = applyBatchDefaults({ locationId: 'floor-3' }, { locationId: 'room-3-12' });
    expect(merged.locationId).toBe('room-3-12');
  });

  /**
   * The bug this function exists to prevent, written as the test that catches it.
   * `item.locationId ?? defaults.locationId` reads an explicit clear as silence and
   * puts Floor 3 back on the one photograph that is not on Floor 3.
   */
  it('treats an explicit null as a clear, not as silence', () => {
    const merged = applyBatchDefaults({ locationId: 'floor-3' }, { locationId: null });
    expect(merged.locationId).toBeNull();
  });

  it('falls back to OTHER rather than losing a batch nobody categorised', () => {
    expect(applyBatchDefaults(undefined, {}).category).toBe('OTHER');
  });

  it('defaults sortOrder to 0 without a default of its own', () => {
    expect(applyBatchDefaults({}, {}).sortOrder).toBe(0);
    expect(applyBatchDefaults({ sortOrder: 5 }, {}).sortOrder).toBe(5);
    expect(applyBatchDefaults({ sortOrder: 5 }, { sortOrder: 0 }).sortOrder).toBe(0);
  });
});

describe('refuseAttachment', () => {
  const base = {
    fileStatus: 'READY',
    fileProjectId: 'p1',
    projectId: 'p1',
    alreadyAttached: false,
  };

  it('accepts a ready file on its own project', () => {
    expect(refuseAttachment(base)).toBeNull();
  });

  it('accepts a file whose bytes are still being scanned', () => {
    // The §9 rule applied to metadata: tagging forty photographs must not be lost
    // because the uploads behind them are still finishing.
    expect(refuseAttachment({ ...base, fileStatus: 'SCANNING' })).toBeNull();
    expect(refuseAttachment({ ...base, fileStatus: 'PENDING' })).toBeNull();
  });

  it('refuses a file the scanner rejected', () => {
    expect(refuseAttachment({ ...base, fileStatus: 'FAILED' })?.code).toBe('FILE_NOT_USABLE');
    expect(refuseAttachment({ ...base, fileStatus: 'EXPIRED' })?.code).toBe('FILE_NOT_USABLE');
  });

  it('refuses a file uploaded against a different project', () => {
    expect(refuseAttachment({ ...base, fileProjectId: 'p2' })?.code).toBe('FILE_WRONG_PROJECT');
    expect(refuseAttachment({ ...base, fileProjectId: null })?.code).toBe('FILE_WRONG_PROJECT');
  });

  it('refuses a second record for one file, which is what makes a replay safe', () => {
    expect(refuseAttachment({ ...base, alreadyAttached: true })?.code).toBe(
      'FILE_ALREADY_ATTACHED'
    );
  });

  it('checks the project before the status, so the message names the real problem', () => {
    // A failed file on the wrong project is reported as the wrong project: telling
    // somebody their file is unusable when it is simply somewhere else sends them
    // to re-take a photograph that was fine.
    const refusal = refuseAttachment({ ...base, fileProjectId: 'p2', fileStatus: 'FAILED' });
    expect(refusal?.code).toBe('FILE_WRONG_PROJECT');
  });

  it('lists exactly the statuses whose bytes are or may become real', () => {
    expect([...ATTACHABLE_FILE_STATUSES].sort()).toEqual(['PENDING', 'READY', 'SCANNING']);
  });
});

describe('disclosureNotice', () => {
  it('says publishing is a disclosure that cannot be recalled', () => {
    const notice = disclosureNotice({ count: 8, clientVisible: true, everPublished: false });
    expect(notice).toContain('8 files');
    expect(notice.toLowerCase()).toContain('cannot un-send');
  });

  it('refuses to imply that hiding withdraws anything', () => {
    const notice = disclosureNotice({ count: 3, clientVisible: false, everPublished: true });
    expect(notice.toLowerCase()).toContain('does not withdraw');
    expect(notice.toLowerCase()).not.toContain('undo');
  });

  it('says nothing is withdrawn when nothing was ever shared', () => {
    const notice = disclosureNotice({ count: 1, clientVisible: false, everPublished: false });
    expect(notice.toLowerCase()).toContain('nothing is withdrawn');
  });
});

describe('ordering and grouping', () => {
  it('puts the most recent project day first, not the most recent upload', () => {
    const friday = view({ id: 'a', evidenceDate: '2026-03-06', createdAt: '2026-03-09T08:00:00.000Z' });
    const saturday = view({ id: 'b', evidenceDate: '2026-03-07', createdAt: '2026-03-07T08:00:00.000Z' });
    expect([friday, saturday].sort(compareEvidence).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('honours sortOrder within a day, so a hero shot pins without a date edit', () => {
    const first = view({ id: 'a', sortOrder: 1 });
    const pinned = view({ id: 'b', sortOrder: 0 });
    expect([first, pinned].sort(compareEvidence).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('sorts undated evidence last rather than dropping or leading with it', () => {
    const dated = view({ id: 'a', evidenceDate: '2026-03-06' });
    const undated = view({ id: 'b', evidenceDate: null });
    expect([undated, dated].sort(compareEvidence).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('groups a timeline by project day, undated last and still present', () => {
    const days = groupByEvidenceDate([
      view({ id: 'a', evidenceDate: '2026-03-06' }),
      view({ id: 'b', evidenceDate: null }),
      view({ id: 'c', evidenceDate: '2026-03-07' }),
      view({ id: 'd', evidenceDate: '2026-03-06' }),
    ]);
    expect(days.map((d) => d.evidenceDate)).toEqual(['2026-03-07', '2026-03-06', null]);
    expect(days[1]?.items).toHaveLength(2);
    expect(days[2]?.items.map((i) => i.id)).toEqual(['b']);
  });

  it('counts by category over whatever it is given', () => {
    expect(
      countByCategory([view({ category: 'BEFORE' }), view({ category: 'BEFORE' }), view({ category: 'AFTER' })])
    ).toEqual({ BEFORE: 2, AFTER: 1 });
  });
});

describe('filters', () => {
  it('refuses a range that starts after it ends rather than returning nothing', () => {
    expect(refuseFilter({ from: '2026-03-09', to: '2026-03-01' })).toBeTruthy();
    expect(refuseFilter({ from: '2026-03-01', to: '2026-03-09' })).toBeNull();
    expect(refuseFilter({})).toBeNull();
  });

  it('accepts one day as both ends', () => {
    expect(refuseFilter({ from: '2026-03-03', to: '2026-03-03' })).toBeNull();
  });

  it('refuses a malformed date at the boundary', () => {
    expect(evidenceFilterSchema.safeParse({ from: '3 March' }).success).toBe(false);
    expect(evidenceFilterSchema.safeParse({ from: '2026-03-03' }).success).toBe(true);
  });
});

describe('schemas', () => {
  it('requires at least one item and caps a batch', () => {
    expect(createEvidenceBatchSchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      createEvidenceBatchSchema.safeParse({
        items: [{ fileId: '44444444-4444-4444-8444-444444444444' }],
      }).success
    ).toBe(true);
  });

  it('refuses an evidence date that is not a project day', () => {
    const parsed = createEvidenceBatchSchema.safeParse({
      items: [{ fileId: '44444444-4444-4444-8444-444444444444', evidenceDate: '2026-03-03T00:00:00Z' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses an empty update rather than writing nothing and reporting success', () => {
    expect(updateEvidenceSchema.safeParse({}).success).toBe(false);
    expect(updateEvidenceSchema.safeParse({ caption: 'North wall' }).success).toBe(true);
  });

  it('keeps expectedRevision optional, which is the browser-form case', () => {
    expect(updateEvidenceSchema.safeParse({ caption: 'x' }).success).toBe(true);
    expect(updateEvidenceSchema.safeParse({ caption: 'x', expectedRevision: 0 }).success).toBe(false);
  });
});

describe('the event payload', () => {
  const rows = [
    { category: 'BEFORE' as const, evidenceDate: '2026-03-06' },
    { category: 'AFTER' as const, evidenceDate: '2026-03-03' },
    { category: 'BEFORE' as const, evidenceDate: null },
  ];

  it('carries counts, categories and the date range', () => {
    const payload = evidenceBatchEventPayload({
      projectId: 'p',
      ownerCompanyId: 'owner',
      uploaderCompanyId: 'sub',
      actorUserId: 'u',
      batchClientId: 'b',
      rows,
    });
    expect(payload.count).toBe(3);
    expect(payload.categories).toEqual(['AFTER', 'BEFORE']);
    expect(payload.evidenceDateFrom).toBe('2026-03-03');
    expect(payload.evidenceDateTo).toBe('2026-03-06');
  });

  /**
   * §11's exclusion list, asserted as an allowlist. A filename looks harmless and
   * is not: `Ridley_Redundancy_Consultation_Floor3.pdf` is a fact about somebody's
   * job, typed by a customer, and it would travel as an ordinary string field.
   */
  it('cannot carry customer prose, whatever the rows hold', () => {
    const payload = evidenceBatchEventPayload({
      projectId: 'p',
      ownerCompanyId: 'owner',
      uploaderCompanyId: 'sub',
      actorUserId: 'u',
      batchClientId: null,
      rows: [
        {
          category: 'DAMAGE',
          evidenceDate: '2026-03-06',
          // Deliberately smuggled in: the builder takes named fields, so anything
          // else on the row is structurally unable to reach the payload.
          ...({ caption: 'Ade cracked the panel', originalFilename: 'Ridley_Redundancy.pdf' } as object),
        },
      ],
    });
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('Ade');
    expect(serialised).not.toContain('Ridley');
    expect(Object.keys(payload).sort()).toEqual([
      'actorUserId',
      'batchClientId',
      'categories',
      'count',
      'evidenceDateFrom',
      'evidenceDateTo',
      'ownerCompanyId',
      'projectId',
      'uploaderCompanyId',
    ]);
  });

  it('reports a null range when nothing claimed a project day', () => {
    const payload = evidenceBatchEventPayload({
      projectId: 'p',
      ownerCompanyId: 'o',
      uploaderCompanyId: 's',
      actorUserId: 'u',
      batchClientId: null,
      rows: [{ category: 'OTHER', evidenceDate: null }],
    });
    expect(payload.evidenceDateFrom).toBeNull();
    expect(payload.evidenceDateTo).toBeNull();
  });
});

describe('the batch summary', () => {
  it('says how many worked when some did not', () => {
    expect(
      summariseBatch({
        batchClientId: null,
        created: [view(), view()],
        rejected: [{ fileId: 'x', code: 'FILE_NOT_USABLE', message: 'no' }],
      })
    ).toBe('2 of 3 files added — 1 could not be used');
  });

  it('does not mention failures when there were none', () => {
    expect(summariseBatch({ batchClientId: null, created: [view()], rejected: [] })).toBe(
      '1 file added'
    );
  });
});

describe('the three timestamps', () => {
  it('names exactly one of them as attested, and it is the server\'s', () => {
    const attested = Object.entries(EVIDENCE_TIMESTAMP_PROVENANCE).filter(([, v]) => v.attested);
    expect(attested.map(([k]) => k)).toEqual(['createdAt']);
  });

  it('agrees with the sync contract about which one the platform stands behind', () => {
    expect(isServerAttested('recordedAt')).toBe(true);
    expect(isServerAttested('capturedAt')).toBe(false);
    expect(EVIDENCE_TIMESTAMP_PROVENANCE.capturedAt.attested).toBe(false);
    expect(EVIDENCE_TIMESTAMP_PROVENANCE.evidenceDate.attested).toBe(false);
  });
});
