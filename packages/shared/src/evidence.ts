import { z } from 'zod';

/**
 * Project evidence (CREWQUO_V2_PLAN.md §22.2–§22.4) — step 4 of the Phase 7
 * build order in `docs/operating-model/project-evidence.md` §14.
 *
 * A photograph is the only artefact in this product that somebody points at
 * years later and says *"that is what the floor looked like"*. Everything here
 * exists to keep that claim honest: the three timestamps stay three timestamps,
 * a disclosure to a client stays recorded after it is withdrawn, and no free
 * text a customer typed ever reaches an analytics payload.
 *
 * Pure, like the rate engine, the tree arithmetic and the storage policy: the
 * API loads rows and calls these, so every branch below is a unit test rather
 * than a fixture and a live bucket.
 */

// ── Categories ───────────────────────────────────────────────────────────────

/**
 * §22.2's fourteen, in the plan's order, which is roughly the order of a job:
 * the site before work, during it, after it; the movements of material off it;
 * and the four that are exceptions rather than stages.
 *
 * A closed list rather than free text, because the categories are what a report
 * groups by and a filter offers — and a customer typing "Before " with a
 * trailing space creates a fifteenth category nobody can see is a duplicate.
 */
export const EVIDENCE_CATEGORIES = [
  'BEFORE',
  'DURING',
  'AFTER',
  'COLLECTION',
  'DELIVERY',
  'INSTALLATION',
  'REUSE',
  'DONATION',
  'RECYCLING',
  'WASTE',
  'DAMAGE',
  'INCIDENT',
  'ASSET',
  'OTHER',
] as const;
export const evidenceCategorySchema = z.enum(EVIDENCE_CATEGORIES);
export type EvidenceCategory = z.infer<typeof evidenceCategorySchema>;

/**
 * What each category is called on screen.
 *
 * Here rather than in the web app because a report (§29), an export column and a
 * gallery filter all have to say the same word, and three copies of a label are
 * three chances for one of them to drift.
 */
export const EVIDENCE_CATEGORY_LABELS: Readonly<Record<EvidenceCategory, string>> = {
  BEFORE: 'Before',
  DURING: 'During',
  AFTER: 'After',
  COLLECTION: 'Collection',
  DELIVERY: 'Delivery',
  INSTALLATION: 'Installation',
  REUSE: 'Reuse',
  DONATION: 'Donation',
  RECYCLING: 'Recycling',
  WASTE: 'Waste',
  DAMAGE: 'Damage',
  INCIDENT: 'Incident',
  ASSET: 'Asset',
  OTHER: 'Other',
};

// ── The record ───────────────────────────────────────────────────────────────

export const evidenceViewSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  /** The uploader's company — **not** the company charged for the bytes (§13.3). */
  companyId: z.string().uuid(),

  fileId: z.string().uuid(),
  webFileId: z.string().uuid().nullable(),
  thumbFileId: z.string().uuid().nullable(),

  category: evidenceCategorySchema,
  caption: z.string().nullable(),
  notes: z.string().nullable(),

  /**
   * The three timestamps, and they are three fields on purpose (§22.2, §8).
   *
   * `createdAt` is when the server accepted it and is the only one the platform
   * attests to. `capturedAt` is what the device's clock said, and a device clock
   * is settable by the person holding it. `evidenceDate` is a human's claim about
   * which project day the photograph belongs to — a supervisor uploading Friday's
   * photos on Monday sets Friday.
   *
   * Reports order by `evidenceDate`; disputes rely on `createdAt` and
   * `capturedAt`. The naive implementation stamps one and treats the other two as
   * decoration, which is exactly the implementation that cannot answer a dispute.
   */
  evidenceDate: z.string().nullable(),
  capturedAt: z.string().nullable(),
  createdAt: z.string(),

  locationId: z.string().uuid().nullable(),

  /**
   * GPS, captured by nothing in this phase (§13.7).
   *
   * The columns exist because the shape of the record is decided here and a
   * governed setting arriving in Phase 9 must not also be a migration. They are
   * always null until `capture_gps_on_evidence` has somewhere to live, and that
   * is a product rule rather than an oversight: GPS is a worker-surveillance
   * surface before it is a data field.
   */
  gpsLat: z.number().nullable(),
  gpsLng: z.number().nullable(),
  gpsAccuracyM: z.number().nullable(),

  clientVisible: z.boolean(),
  /**
   * When this was **first** disclosed to the client, and it is never cleared.
   *
   * Un-publishing sets `clientVisible` back to false and this stays, because
   * un-publishing is not a retraction — Tunde may already have downloaded the
   * file. A record that forgets it was published would let a screen imply a
   * disclosure had been undone, which is the one thing this flag must never say.
   */
  firstPublishedAt: z.string().nullable(),

  sortOrder: z.number().int(),
  uploadedByUserId: z.string().uuid().nullable(),
  /** The client-supplied id shared by one selection (§8). The batch is the unit. */
  batchClientId: z.string().uuid().nullable(),

  /** The sync contract's two columns (0029). */
  revision: z.number().int().min(1),
  deletedAt: z.string().nullable(),
  updatedAt: z.string(),

  /**
   * The file's own state, carried through rather than duplicated.
   *
   * A gallery has to render a photograph that is still being scanned and one
   * whose bytes were refused, and both are facts about `stored_files` — so they
   * are joined on read and never copied into a column that would then be a second
   * answer to the same question.
   */
  fileStatus: z.string(),
  fileFailureReason: z.string().nullable(),
  contentType: z.string(),
  byteSize: z.number().int(),
  originalFilename: z.string(),
});
export type EvidenceView = z.infer<typeof evidenceViewSchema>;

// ── Attaching a file ─────────────────────────────────────────────────────────

/**
 * The file statuses a record may be created against.
 *
 * `SCANNING` and `PENDING` are included deliberately, and it is the §9 rule
 * applied to metadata rather than to bytes: Ade tags forty photographs in a
 * stairwell while their uploads are still finishing, and a rule that only
 * accepted `READY` would throw away the tagging every time a PUT was slow. The
 * record is metadata *about* a file, and metadata is worth keeping while the
 * bytes are in flight.
 *
 * `FAILED` and `EXPIRED` are refused, because there is nothing to be evidence
 * of; `DELETED` likewise.
 */
export const ATTACHABLE_FILE_STATUSES: readonly string[] = ['PENDING', 'SCANNING', 'READY'];

export interface AttachmentRefusal {
  code: 'FILE_NOT_USABLE' | 'FILE_WRONG_PROJECT' | 'FILE_ALREADY_ATTACHED';
  message: string;
}

/**
 * May this file become evidence on this project?
 *
 * Everything the answer depends on is passed in, so the decision is testable
 * without a database — and so the three refusals stay distinguishable, which is
 * what lets a partial batch tell the user *which* files it could not take and
 * why (§9).
 */
export function refuseAttachment(args: {
  fileStatus: string;
  fileProjectId: string | null;
  projectId: string;
  alreadyAttached: boolean;
}): AttachmentRefusal | null {
  if (args.fileProjectId !== args.projectId) {
    return {
      code: 'FILE_WRONG_PROJECT',
      message: 'That upload belongs to a different project',
    };
  }
  if (args.alreadyAttached) {
    return {
      code: 'FILE_ALREADY_ATTACHED',
      message: 'That upload is already on this project',
    };
  }
  if (!ATTACHABLE_FILE_STATUSES.includes(args.fileStatus)) {
    return {
      code: 'FILE_NOT_USABLE',
      message: `That upload is ${args.fileStatus.toLowerCase()} and cannot be used as evidence`,
    };
  }
  return null;
}

// ── Batch metadata ───────────────────────────────────────────────────────────

/**
 * The metadata a whole selection can carry, and each photograph can override.
 *
 * §22.3 is blunt about why this exists: *"Tagging 40 photos individually is the
 * failure mode that kills evidence capture."* So the batch carries defaults and
 * the item carries exceptions, and the merge below is the one piece of arithmetic
 * that has to be right.
 */
export const evidenceMetadataSchema = z.object({
  category: evidenceCategorySchema,
  caption: z.string().trim().max(500).nullable(),
  notes: z.string().trim().max(4000).nullable(),
  evidenceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'evidenceDate must be YYYY-MM-DD')
    .nullable(),
  capturedAt: z.string().datetime({ offset: true }).nullable(),
  locationId: z.string().uuid().nullable(),
  sortOrder: z.number().int().min(0).max(100000),
});
export type EvidenceMetadata = z.infer<typeof evidenceMetadataSchema>;

export const evidenceBatchItemSchema = evidenceMetadataSchema.partial().extend({
  fileId: z.string().uuid(),
});
export type EvidenceBatchItem = z.infer<typeof evidenceBatchItemSchema>;

export const createEvidenceBatchSchema = z.object({
  /**
   * The client-supplied id shared by one selection (§5, §8).
   *
   * It is the idempotency key for the whole act and the key of the single
   * `evidence.batch_uploaded` event. Forty photographs is one act by one person;
   * forty events would be forty notifications, forty audit rows and a projection
   * nobody can read.
   */
  batchClientId: z.string().uuid().optional(),
  /** Applied to every item that does not say otherwise. */
  defaults: evidenceMetadataSchema.partial().optional(),
  items: z.array(evidenceBatchItemSchema).min(1).max(200),
});
export type CreateEvidenceBatch = z.infer<typeof createEvidenceBatchSchema>;

/**
 * One item's metadata, after the batch defaults are applied.
 *
 * **`undefined` and `null` are different answers and conflating them is the bug
 * this function exists to prevent.** `undefined` means the item said nothing and
 * takes the batch's value; `null` means the item explicitly cleared a field the
 * batch set — Ade applying Floor 3 to forty photographs and then saying *this*
 * one has no location. A merge written as `item.locationId ?? defaults.locationId`
 * reads the explicit clear as silence and re-applies Floor 3, which is a wrong
 * location on a piece of evidence and unfixable through the same screen.
 *
 * `category` is the one field with a fallback rather than a requirement: a
 * selection dropped onto the gallery with nothing chosen is `OTHER`, which is
 * honest and re-taggable, where refusing the upload would lose the batch.
 */
export function applyBatchDefaults(
  defaults: Partial<EvidenceMetadata> | undefined,
  item: Partial<EvidenceMetadata>
): EvidenceMetadata {
  const pick = <K extends keyof EvidenceMetadata>(key: K): EvidenceMetadata[K] | undefined =>
    key in item ? item[key] : defaults?.[key];

  return {
    category: pick('category') ?? 'OTHER',
    caption: pick('caption') ?? null,
    notes: pick('notes') ?? null,
    evidenceDate: pick('evidenceDate') ?? null,
    capturedAt: pick('capturedAt') ?? null,
    locationId: pick('locationId') ?? null,
    sortOrder: pick('sortOrder') ?? 0,
  };
}

// ── Editing ──────────────────────────────────────────────────────────────────

export const updateEvidenceSchema = evidenceMetadataSchema
  .partial()
  .extend({
    /** The revision this edit was composed against (item 7.7). Optional by design. */
    expectedRevision: z.number().int().min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateEvidence = z.infer<typeof updateEvidenceSchema>;

/**
 * The same edit applied to a selection (§22.3's "then overridden per photo",
 * read backwards — re-tagging a filtered set in one pass).
 *
 * No `expectedRevision` here, and that is deliberate rather than an omission. A
 * bulk edit is composed against a *selection*, not against one record's version,
 * and demanding a version per id would make the request unbuildable from a
 * gallery. The audit row still records both sides of every field for every row
 * touched, so a bulk change is as recoverable as a single one.
 */
export const bulkUpdateEvidenceSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  patch: evidenceMetadataSchema
    .partial()
    .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' }),
});
export type BulkUpdateEvidence = z.infer<typeof bulkUpdateEvidenceSchema>;

export const publishEvidenceSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  clientVisible: z.boolean(),
});
export type PublishEvidence = z.infer<typeof publishEvidenceSchema>;

/**
 * What the publish confirmation has to say, in both directions.
 *
 * §3's rule is that **publishing is a disclosure and unpublishing does not undo
 * it** — the client may already have downloaded the file. A screen that offers
 * "unpublish" without saying so implies a retraction the product cannot perform,
 * and the person who believes it is the person who publishes the wrong photograph
 * and thinks they have fixed it.
 *
 * Returned as a sentence rather than a boolean because there is exactly one right
 * wording and it should not be re-invented per screen.
 */
export function disclosureNotice(args: {
  count: number;
  clientVisible: boolean;
  everPublished: boolean;
}): string {
  const noun = args.count === 1 ? 'this file' : `these ${args.count} files`;
  if (args.clientVisible) {
    return `Sharing ${noun} makes it visible to the client and available to download. You can hide it again, but you cannot un-send what has already been downloaded.`;
  }
  return args.everPublished
    ? `Hiding ${noun} removes it from the client's view from now on. It does not withdraw anything they have already seen or downloaded.`
    : `${args.count === 1 ? 'This file has' : 'These files have'} not been shared, so nothing is withdrawn.`;
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * §22.4's filters. Every one of them is a column or a join, so this is a schema
 * rather than a predicate — a second, JavaScript implementation of the same
 * filtering would be a second answer that drifts from the SQL on the first
 * change.
 */
export const evidenceFilterSchema = z.object({
  category: z.array(evidenceCategorySchema).optional(),
  /** Inclusive, against `evidence_date`, which is the project day (§22.2). */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  uploadedByUserId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  /** `true` shows only what the client can see; `false` only what it cannot. */
  clientVisible: z.boolean().optional(),
  /** The batch a selection arrived in, which is how "what did I just upload" is asked. */
  batchClientId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});
export type EvidenceFilter = z.infer<typeof evidenceFilterSchema>;

/**
 * A date range given backwards is a mistake, not an empty result.
 *
 * Silently returning nothing for `from > to` produces the worst possible support
 * conversation: *"the photos are gone"*. Swapping them is worse still, because it
 * answers a question nobody asked. So it is refused, by name, at the boundary.
 */
export function refuseFilter(filter: EvidenceFilter): string | null {
  if (filter.from && filter.to && filter.from > filter.to) {
    return 'The date range starts after it ends';
  }
  return null;
}

/**
 * Gallery and report order: the project day first, then the moment it arrived.
 *
 * **Ordered by `evidenceDate`, not by `createdAt`**, because the question a
 * gallery answers is "what did Friday look like" and Friday's photographs may
 * have been uploaded on Monday, after Saturday's. `sortOrder` comes first so a
 * person can pin a hero shot to the front of a day without editing its date.
 *
 * Undated evidence sorts **last** rather than first. It is real and must be
 * visible — dropping it would hide a photograph somebody took — but it has made
 * no claim about which day it belongs to, and putting an unclaimed thing at the
 * top of a chronology asserts something on its behalf.
 */
export function compareEvidence(a: EvidenceView, b: EvidenceView): number {
  if (a.evidenceDate !== b.evidenceDate) {
    if (a.evidenceDate === null) return 1;
    if (b.evidenceDate === null) return -1;
    return a.evidenceDate < b.evidenceDate ? 1 : -1; // most recent day first
  }
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

export interface EvidenceDay {
  /** `null` is the undated group, and it is a group rather than a silence. */
  evidenceDate: string | null;
  items: EvidenceView[];
}

/** §22.4's timeline: the same rows, grouped by the project day they claim. */
export function groupByEvidenceDate(rows: readonly EvidenceView[]): EvidenceDay[] {
  /*
   * Keyed on `null` itself rather than on a sentinel string, and the first attempt
   * is worth recording: a `'￿'` placeholder chosen to "sort after every real
   * date" sorts *before* them under a descending comparator, so the undated group
   * led the timeline instead of ending it. A magic value that has to be ordered
   * correctly is a rule hidden inside a character; an explicit branch is the rule.
   */
  const days = new Map<string | null, EvidenceView[]>();
  for (const row of rows) {
    const bucket = days.get(row.evidenceDate);
    if (bucket) bucket.push(row);
    else days.set(row.evidenceDate, [row]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return a < b ? 1 : -1; // most recent project day first
    })
    .map(([evidenceDate, items]) => ({
      evidenceDate,
      items: [...items].sort(compareEvidence),
    }));
}

/** How many of each category a filtered set holds, for the filter bar's counts. */
export function countByCategory(
  rows: readonly EvidenceView[]
): Partial<Record<EvidenceCategory, number>> {
  const counts: Partial<Record<EvidenceCategory, number>> = {};
  for (const row of rows) counts[row.category] = (counts[row.category] ?? 0) + 1;
  return counts;
}

// ── The batch outcome ────────────────────────────────────────────────────────

export interface EvidenceBatchRejection {
  fileId: string;
  code: AttachmentRefusal['code'];
  message: string;
}

export interface EvidenceBatchResult {
  batchClientId: string | null;
  created: EvidenceView[];
  rejected: EvidenceBatchRejection[];
}

/**
 * **A partial batch never loses the files that worked**, and this shape is that
 * rule made structural (§9).
 *
 * The endpoint returns 201 with both lists rather than refusing the request when
 * one of forty files is bad. An "upload failed" that discards thirty-nine
 * successful photographs is a product that trains Ade to stop using it, and he is
 * the person this phase exists for.
 */
export function summariseBatch(result: EvidenceBatchResult): string {
  const stored = result.created.length;
  const refused = result.rejected.length;
  if (refused === 0) return `${stored} ${stored === 1 ? 'file' : 'files'} added`;
  return `${stored} of ${stored + refused} files added — ${refused} could not be used`;
}

// ── Events and analytics ─────────────────────────────────────────────────────

/**
 * The payload of `evidence.batch_uploaded`, built by an **allowlist**.
 *
 * §11's exclusion list is long — captions, notes, filenames, attendance names,
 * GPS, bucket keys — and a denylist of it would have to be extended by whoever
 * adds the next field, who is exactly the person who has not read the rule.
 * `scrubEvent` already made that argument for Sentry; analytics and log lines are
 * a separate surface with the same rule, so they get the same shape.
 *
 * **A filename is the field this protects that looks harmless.**
 * `Ridley_Redundancy_Consultation_Floor3.pdf` is a fact about somebody's job,
 * typed by a customer, and it would travel as an ordinary string.
 */
export function evidenceBatchEventPayload(args: {
  projectId: string;
  ownerCompanyId: string;
  uploaderCompanyId: string;
  actorUserId: string;
  batchClientId: string | null;
  rows: readonly Pick<EvidenceView, 'category' | 'evidenceDate'>[];
}): Record<string, string | number | string[] | null> {
  const dates = args.rows
    .map((r) => r.evidenceDate)
    .filter((d): d is string => d !== null)
    .sort();
  return {
    projectId: args.projectId,
    ownerCompanyId: args.ownerCompanyId,
    uploaderCompanyId: args.uploaderCompanyId,
    actorUserId: args.actorUserId,
    batchClientId: args.batchClientId,
    count: args.rows.length,
    categories: [...new Set(args.rows.map((r) => r.category))].sort(),
    evidenceDateFrom: dates[0] ?? null,
    evidenceDateTo: dates[dates.length - 1] ?? null,
  };
}

/**
 * Which of the three timestamps the platform stands behind, for a label on a
 * screen or a column in an export manifest.
 *
 * `sync.ts` already owns the general rule (`isServerAttested`); this is the
 * evidence record's three fields named against it, so a UI does not have to
 * decide for itself which of `capturedAt` and `createdAt` is the claim.
 */
export const EVIDENCE_TIMESTAMP_PROVENANCE = {
  createdAt: { label: 'Uploaded', attested: true },
  capturedAt: { label: 'Taken (device)', attested: false },
  evidenceDate: { label: 'Project day', attested: false },
} as const;
