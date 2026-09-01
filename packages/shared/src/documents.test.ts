import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
  DOCUMENT_EXPIRY_THRESHOLDS,
  buildVersionChain,
  createDocumentSchema,
  daysUntil,
  describeExpiry,
  describeSupersession,
  documentExpiryEventPayload,
  documentSupersededEventPayload,
  expiryThreshold,
  refuseDocumentDates,
  refuseSupersede,
  supersedeDocumentSchema,
  updateDocumentSchema,
} from './documents';

const FILE_A = '11111111-1111-4111-8111-111111111111';
const FILE_B = '22222222-2222-4222-8222-222222222222';

describe('categories', () => {
  it('holds §24\'s sixteen', () => {
    expect(DOCUMENT_CATEGORIES).toHaveLength(16);
  });

  it('labels every one, because a label is all a notification may say', () => {
    for (const category of DOCUMENT_CATEGORIES) {
      expect(DOCUMENT_CATEGORY_LABELS[category]).toBeTruthy();
    }
  });

  it('includes the four that back a weight or a destination in Phase 8', () => {
    for (const key of [
      'WASTE_TRANSFER_NOTE',
      'WEIGHBRIDGE_TICKET',
      'RECYCLING_CERTIFICATE',
      'DONATION_RECEIPT',
    ] as const) {
      expect(DOCUMENT_CATEGORIES).toContain(key);
    }
  });
});

describe('the schemas', () => {
  /**
   * The one that matters most, and the reason `updateDocumentSchema` is `.strict()`.
   * Correcting a title is an edit; replacing the bytes is a new version. A `fileId`
   * accepted here would let a superseded RAMS quietly become the current one with
   * the version number and the chain both still claiming otherwise.
   */
  it('refuses a fileId on the metadata update path', () => {
    const parsed = updateDocumentSchema.safeParse({ title: 'RAMS', fileId: FILE_B });
    expect(parsed.success).toBe(false);
  });

  it('accepts a plain metadata edit', () => {
    expect(updateDocumentSchema.safeParse({ title: 'RAMS rev B' }).success).toBe(true);
  });

  it('refuses an empty update rather than reporting success for nothing', () => {
    expect(updateDocumentSchema.safeParse({}).success).toBe(false);
  });

  it('requires a file and a title to file a document at all', () => {
    expect(createDocumentSchema.safeParse({ category: 'RAMS', title: 'x' }).success).toBe(false);
    expect(createDocumentSchema.safeParse({ fileId: FILE_A, title: 'x' }).success).toBe(false);
    expect(
      createDocumentSchema.safeParse({ fileId: FILE_A, category: 'RAMS', title: 'Site RAMS' }).success
    ).toBe(true);
  });

  it('requires only a file to re-issue, because the rest is inherited', () => {
    expect(supersedeDocumentSchema.safeParse({ fileId: FILE_B }).success).toBe(true);
  });

  it('refuses a date that is not a calendar day', () => {
    expect(
      createDocumentSchema.safeParse({
        fileId: FILE_A,
        category: 'INSURANCE',
        title: 'Cover',
        expiresOn: '2027-01-01T00:00:00Z',
      }).success
    ).toBe(false);
  });
});

describe('refuseDocumentDates', () => {
  it('refuses an expiry before the issue date', () => {
    expect(refuseDocumentDates({ issuedOn: '2026-09-01', expiresOn: '2026-08-01' })).toBeTruthy();
  });

  it('allows same-day, which is a one-day permit and a real thing', () => {
    expect(refuseDocumentDates({ issuedOn: '2026-09-01', expiresOn: '2026-09-01' })).toBeNull();
  });

  it('has no opinion when either date is absent', () => {
    expect(refuseDocumentDates({ issuedOn: null, expiresOn: '2026-08-01' })).toBeNull();
    expect(refuseDocumentDates({ issuedOn: '2026-09-01', expiresOn: null })).toBeNull();
    expect(refuseDocumentDates({})).toBeNull();
  });
});

describe('refuseSupersede', () => {
  const base = {
    deletedAt: null,
    supersededById: null,
    currentFileId: FILE_A,
    newFileId: FILE_B,
  };

  it('allows a straightforward re-issue', () => {
    expect(refuseSupersede(base)).toBeNull();
  });

  /**
   * The fork, which is the failure this whole chain exists to prevent: two version
   * 2s claiming to replace one version 1, and "which is current" with no answer —
   * in a category where the answer is what somebody on site is relying on.
   */
  it('refuses re-issuing a version that already has a successor', () => {
    expect(refuseSupersede({ ...base, supersededById: 'x' })?.code).toBe('ALREADY_SUPERSEDED');
  });

  it('refuses re-issuing a deleted document', () => {
    expect(refuseSupersede({ ...base, deletedAt: '2026-09-01T00:00:00Z' })?.code).toBe('GONE');
  });

  it('refuses a new version pointing at the same bytes', () => {
    expect(refuseSupersede({ ...base, newFileId: FILE_A })?.code).toBe('FILE_REUSED');
  });

  it('reports GONE before ALREADY_SUPERSEDED, because deleted is the more useful answer', () => {
    const refusal = refuseSupersede({ ...base, deletedAt: '2026-09-01T00:00:00Z', supersededById: 'x' });
    expect(refusal?.code).toBe('GONE');
  });
});

describe('buildVersionChain', () => {
  const v1 = { id: 'v1', supersedesId: null };
  const v2 = { id: 'v2', supersedesId: 'v1' };
  const v3 = { id: 'v3', supersedesId: 'v2' };

  it('orders a chain oldest first', () => {
    expect(buildVersionChain([v3, v1, v2]).map((r) => r.id)).toEqual(['v1', 'v2', 'v3']);
  });

  it('finds the whole chain from any row in it', () => {
    expect(buildVersionChain([v2, v3, v1]).map((r) => r.id)).toEqual(['v1', 'v2', 'v3']);
  });

  it('handles a single version', () => {
    expect(buildVersionChain([v1]).map((r) => r.id)).toEqual(['v1']);
  });

  it('starts where it can when the predecessor is outside the set', () => {
    // An export or a scoped read can hand over a partial chain; returning nothing
    // would hide every version the caller *can* see.
    expect(buildVersionChain([v2, v3]).map((r) => r.id)).toEqual(['v2', 'v3']);
  });

  /**
   * `supersedes_id` cannot loop while the API is the only writer. This survives a
   * bad migration or a hand-written update, for the same reason `depthOf` does in
   * `locations.ts`: reading a chain must never be the thing that hangs the process.
   */
  it('terminates on a cycle rather than looping for ever', () => {
    const a = { id: 'a', supersedesId: 'b' };
    const b = { id: 'b', supersedesId: 'a' };
    const chain = buildVersionChain([a, b]);
    expect(chain.length).toBeLessThanOrEqual(2);
  });

  it('returns nothing for nothing', () => {
    expect(buildVersionChain([])).toEqual([]);
  });
});

describe('daysUntil', () => {
  it('counts whole days forward', () => {
    expect(daysUntil('2026-09-08', '2026-09-01')).toBe(7);
  });

  it('is zero on the day itself', () => {
    expect(daysUntil('2026-09-01', '2026-09-01')).toBe(0);
  });

  it('goes negative once it has passed', () => {
    expect(daysUntil('2026-08-30', '2026-09-01')).toBe(-2);
  });

  it('crosses a month and a year without drifting', () => {
    expect(daysUntil('2026-10-01', '2026-09-01')).toBe(30);
    expect(daysUntil('2027-01-01', '2026-12-31')).toBe(1);
  });

  /**
   * The one that would bite in production: a date range spanning a DST change is
   * not 24 hours per day in a local zone. Both sides are parsed as UTC midnight
   * precisely so the arithmetic cannot notice — whose day it is was already decided
   * upstream by Postgres, from the company's own IANA zone.
   */
  it('is unaffected by a daylight-saving change in between', () => {
    expect(daysUntil('2026-11-01', '2026-10-25')).toBe(7);
    expect(daysUntil('2026-04-01', '2026-03-25')).toBe(7);
  });
});

describe('expiryThreshold', () => {
  it('puts a document on the largest rung at or below its days remaining', () => {
    expect(expiryThreshold(45)).toBe(60);
    expect(expiryThreshold(60)).toBe(60);
    expect(expiryThreshold(30)).toBe(30);
    expect(expiryThreshold(29)).toBe(30);
    expect(expiryThreshold(8)).toBe(14);
    expect(expiryThreshold(7)).toBe(7);
    expect(expiryThreshold(1)).toBe(7);
  });

  it('is on no rung when the expiry is further out than the ladder reaches', () => {
    expect(expiryThreshold(91)).toBeNull();
    expect(expiryThreshold(365)).toBeNull();
  });

  it('reaches rung 0 on the day itself and stays there once lapsed', () => {
    // A ladder that warns at 7 days and then says nothing on the day itself goes
    // quiet exactly when the insurance lapses.
    expect(expiryThreshold(0)).toBe(0);
    expect(expiryThreshold(-1)).toBe(0);
    expect(expiryThreshold(-400)).toBe(0);
  });

  it('has a rung for every step of the plan\'s ladder plus the day itself', () => {
    expect([...DOCUMENT_EXPIRY_THRESHOLDS]).toEqual([90, 60, 30, 14, 7, 0]);
  });
});

describe('the wording', () => {
  it('says how long is left, in the category\'s own name', () => {
    expect(describeExpiry({ category: 'RAMS', daysRemaining: 30 })).toBe('RAMS expires in 30 days');
    expect(describeExpiry({ category: 'INSURANCE', daysRemaining: 1 })).toBe(
      'Insurance expires in 1 day'
    );
  });

  it('says "today" rather than "in 0 days"', () => {
    expect(describeExpiry({ category: 'INSURANCE', daysRemaining: 0 })).toBe(
      'Insurance expires today'
    );
  });

  it('says a lapsed document has lapsed, in the past tense', () => {
    expect(describeExpiry({ category: 'INSURANCE', daysRemaining: -3 })).toBe(
      'Insurance expired 3 days ago'
    );
  });

  it('produces §6\'s own supersession wording from the category and version alone', () => {
    expect(describeSupersession({ category: 'RAMS', version: 3 })).toBe('RAMS v3 replaced v2');
  });
});

describe('the event payloads', () => {
  /**
   * §11 names document **titles and references** in its exclusion list, and they are
   * the two fields anybody would reach for first when writing this payload: a title
   * is customer prose, and a reference is a waste transfer note number — a fact
   * about a real disposal at a real site.
   */
  it('the expiry event carries no title and no reference', () => {
    const payload = documentExpiryEventPayload({
      documentId: 'd',
      projectId: 'p',
      ownerCompanyId: 'o',
      providerCompanyId: 's',
      category: 'WASTE_TRANSFER_NOTE',
      version: 2,
      threshold: 30,
      daysRemaining: 21,
    });
    expect(Object.keys(payload).sort()).toEqual([
      'category',
      'daysRemaining',
      'documentId',
      'ownerCompanyId',
      'projectId',
      'providerCompanyId',
      'threshold',
      'version',
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/title|reference/i);
  });

  it('the supersession event carries ids, category and versions only', () => {
    const payload = documentSupersededEventPayload({
      documentId: 'new',
      supersededId: 'old',
      projectId: 'p',
      ownerCompanyId: 'o',
      actorUserId: 'u',
      category: 'RAMS',
      version: 3,
      clientVisible: true,
    });
    expect(Object.keys(payload).sort()).toEqual([
      'actorUserId',
      'category',
      'clientVisible',
      'documentId',
      'ownerCompanyId',
      'projectId',
      'supersededId',
      'version',
    ]);
  });

  it('a null provider survives as null rather than becoming a string', () => {
    const payload = documentExpiryEventPayload({
      documentId: 'd',
      projectId: 'p',
      ownerCompanyId: 'o',
      providerCompanyId: null,
      category: 'DRAWING',
      version: 1,
      threshold: 7,
      daysRemaining: 5,
    });
    expect(payload.providerCompanyId).toBeNull();
  });
});
