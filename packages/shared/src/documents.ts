import { z } from 'zod';

/**
 * Project documents (CREWQUO_V2_PLAN.md §24) — step 5 of the Phase 7 build order
 * in `docs/operating-model/project-evidence.md` §14.
 *
 * **A document is a chain, not an edit** (§3). A new version inserts a row
 * pointing at the old one, which stays and is hidden by default; there is no
 * update path for `file_id` anywhere in this module or the API above it. A
 * document whose bytes can be replaced in place is a document whose history is a
 * claim rather than a record — and waste transfer notes, weighbridge tickets and
 * insurance certificates are precisely the documents somebody is later asked to
 * prove.
 *
 * Pure, like the rest of the phase: dates, thresholds and chain arithmetic, with
 * a unit test per branch.
 */

// ── Categories ───────────────────────────────────────────────────────────────

/**
 * §24's sixteen. Four of them — `WASTE_TRANSFER_NOTE`, `WEIGHBRIDGE_TICKET`,
 * `RECYCLING_CERTIFICATE`, `DONATION_RECEIPT` — are load-bearing beyond this
 * phase: §25.3 and §25.4 make them what turns an *estimated* weight or
 * destination into a **documented** one, so Phase 8's asset rows point at these
 * documents directly. They are not merely a filing category.
 */
export const DOCUMENT_CATEGORIES = [
  'RAMS',
  'RISK_ASSESSMENT',
  'METHOD_STATEMENT',
  'INSURANCE',
  'PURCHASE_ORDER',
  'DRAWING',
  'SITE_INSTRUCTION',
  'WASTE_TRANSFER_NOTE',
  'WEIGHBRIDGE_TICKET',
  'RECYCLING_CERTIFICATE',
  'DONATION_RECEIPT',
  'DELIVERY_NOTE',
  'COLLECTION_NOTE',
  'CLIENT_SIGNOFF',
  'INCIDENT',
  'OTHER',
] as const;
export const documentCategorySchema = z.enum(DOCUMENT_CATEGORIES);
export type DocumentCategory = z.infer<typeof documentCategorySchema>;

/**
 * What each is called on screen, and in a notification body.
 *
 * The label matters more here than it does for evidence, because it is the only
 * thing a notification is allowed to say about a document. §11 excludes document
 * **titles and references** from every payload — a title is customer prose and a
 * reference is a waste transfer note number — so *"RAMS v3 replaced v2"* is
 * composed from the category and the version and never from what somebody typed.
 */
export const DOCUMENT_CATEGORY_LABELS: Readonly<Record<DocumentCategory, string>> = {
  RAMS: 'RAMS',
  RISK_ASSESSMENT: 'Risk assessment',
  METHOD_STATEMENT: 'Method statement',
  INSURANCE: 'Insurance',
  PURCHASE_ORDER: 'Purchase order',
  DRAWING: 'Drawing',
  SITE_INSTRUCTION: 'Site instruction',
  WASTE_TRANSFER_NOTE: 'Waste transfer note',
  WEIGHBRIDGE_TICKET: 'Weighbridge ticket',
  RECYCLING_CERTIFICATE: 'Recycling certificate',
  DONATION_RECEIPT: 'Donation receipt',
  DELIVERY_NOTE: 'Delivery note',
  COLLECTION_NOTE: 'Collection note',
  CLIENT_SIGNOFF: 'Client sign-off',
  INCIDENT: 'Incident report',
  OTHER: 'Other',
};

// ── The record ───────────────────────────────────────────────────────────────

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const documentViewSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  /** Who uploaded it. Not who it is *about* — that is `providerCompanyId`. */
  companyId: z.string().uuid(),
  fileId: z.string().uuid(),

  category: documentCategorySchema,
  title: z.string(),
  /** A WTN number, a PO number, a ticket number. Customer prose; never in a payload. */
  reference: z.string().nullable(),
  notes: z.string().nullable(),

  version: z.number().int().min(1),
  /** The row this one replaced, or null for a first version. */
  supersedesId: z.string().uuid().nullable(),
  /**
   * The row that replaced *this* one, **derived and never stored**.
   *
   * A `superseded` boolean column beside `supersedes_id` would be two answers to
   * one question, and they disagree the first time a successor is deleted. This
   * is a join, so retracting a bad version restores its predecessor to current
   * with nothing to back-fill.
   */
  supersededById: z.string().uuid().nullable(),

  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
  /**
   * Days until expiry **in the owning company's own zone**, or null when the
   * document has no expiry. Negative once it has passed, which is a state a
   * screen has to render differently from "expiring soon".
   */
  daysUntilExpiry: z.number().int().nullable(),

  /** The subcontractor this document is about, if any. See `defaultProviderScope`. */
  providerCompanyId: z.string().uuid().nullable(),
  locationId: z.string().uuid().nullable(),
  clientVisible: z.boolean(),

  uploadedByUserId: z.string().uuid().nullable(),

  revision: z.number().int().min(1),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),

  /** Carried through from `stored_files` rather than copied into a column. */
  fileStatus: z.string(),
  fileFailureReason: z.string().nullable(),
  contentType: z.string(),
  byteSize: z.number().int(),
  originalFilename: z.string(),
});
export type DocumentView = z.infer<typeof documentViewSchema>;

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * The metadata a document carries. **`fileId` is not in here**, and its absence
 * is the design rather than an omission — see `updateDocumentSchema`.
 */
const documentMetadata = z.object({
  category: documentCategorySchema,
  title: z.string().trim().min(1).max(300),
  reference: z.string().trim().max(200).nullable(),
  notes: z.string().trim().max(4000).nullable(),
  issuedOn: dateOnly.nullable(),
  expiresOn: dateOnly.nullable(),
  providerCompanyId: z.string().uuid().nullable(),
  locationId: z.string().uuid().nullable(),
  clientVisible: z.boolean(),
});

export const createDocumentSchema = documentMetadata.partial().extend({
  fileId: z.string().uuid(),
  category: documentCategorySchema,
  title: z.string().trim().min(1).max(300),
  /** Idempotency key for a retry that could not tell whether it landed (item 7.7). */
  clientId: z.string().uuid().optional(),
});
export type CreateDocument = z.infer<typeof createDocumentSchema>;

/**
 * Metadata only, and **there is deliberately no `fileId` here.**
 *
 * Correcting a title is an edit; replacing the bytes is a new version. Allowing
 * the second through this route would let a superseded RAMS quietly become the
 * current one, with the version number and the chain both still claiming
 * otherwise — the exact failure `supersedes_id` exists to prevent, reachable
 * through a field somebody added because it seemed symmetrical.
 */
export const updateDocumentSchema = documentMetadata
  .partial()
  .extend({ expectedRevision: z.number().int().min(1).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateDocument = z.infer<typeof updateDocumentSchema>;

/**
 * A new version of an existing document.
 *
 * Metadata is optional and **inherited from the predecessor when omitted**: a
 * re-issued insurance certificate is the same document with new dates, and making
 * somebody retype its category, title and provider is how the second version ends
 * up filed as something else.
 */
export const supersedeDocumentSchema = documentMetadata.partial().extend({
  fileId: z.string().uuid(),
  clientId: z.string().uuid().optional(),
});
export type SupersedeDocument = z.infer<typeof supersedeDocumentSchema>;

export const documentFilterSchema = z.object({
  category: z.array(documentCategorySchema).optional(),
  providerCompanyId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  clientVisible: z.boolean().optional(),
  /**
   * Superseded versions are hidden by default (§24), which is what "the old one
   * stays and is hidden" means in practice. Asking for them is deliberate.
   */
  includeSuperseded: z.boolean().optional(),
  /** Only documents expiring within this many days, or already expired. */
  expiringWithinDays: z.number().int().min(0).max(3650).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});
export type DocumentFilter = z.infer<typeof documentFilterSchema>;

/** A document that expires before it was issued is a typo, not a record. */
export function refuseDocumentDates(args: {
  issuedOn?: string | null;
  expiresOn?: string | null;
}): string | null {
  if (args.issuedOn && args.expiresOn && args.expiresOn < args.issuedOn) {
    return 'That document expires before it was issued';
  }
  return null;
}

// ── Superseding ──────────────────────────────────────────────────────────────

export interface SupersedeRefusal {
  code: 'ALREADY_SUPERSEDED' | 'GONE' | 'FILE_REUSED';
  message: string;
}

/**
 * May this document be replaced by a new version?
 *
 * **`ALREADY_SUPERSEDED` is the one that matters, and it is a fork rather than a
 * duplicate.** Two people re-issuing the same RAMS at once would otherwise leave
 * two version 2s claiming to replace one version 1, and *"which is current"*
 * stops having an answer — in a category where the answer is what somebody is
 * standing on site relying on. The API refuses it here and a partial unique index
 * refuses it in the database, because a race is not a validation problem.
 *
 * `FILE_REUSED` catches the other direction: pointing a new version at the bytes
 * the old one already uses produces a chain whose two links are the same file, so
 * "what changed" is unanswerable and deleting one version breaks the other.
 */
export function refuseSupersede(args: {
  deletedAt: string | null;
  supersededById: string | null;
  currentFileId: string;
  newFileId: string;
}): SupersedeRefusal | null {
  if (args.deletedAt !== null) {
    return { code: 'GONE', message: 'That document was deleted, so it cannot be re-issued.' };
  }
  if (args.supersededById !== null) {
    return {
      code: 'ALREADY_SUPERSEDED',
      message: 'A newer version of this document already exists. Re-issue that one instead.',
    };
  }
  if (args.currentFileId === args.newFileId) {
    return {
      code: 'FILE_REUSED',
      message: 'A new version needs a new file. Nothing would change.',
    };
  }
  return null;
}

/**
 * The chain, oldest first, from any row in it.
 *
 * **Guarded against a cycle it should never see**, for the same reason
 * `depthOf` is in `locations.ts`: `supersedes_id` cannot loop while the API is
 * the only writer, and a tree read must never be the thing that hangs the
 * process. A bad migration or a hand-written `update` is what this survives.
 */
export function buildVersionChain<T extends { id: string; supersedesId: string | null }>(
  rows: readonly T[]
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const successors = new Map<string, T>();
  for (const row of rows) {
    if (row.supersedesId !== null) successors.set(row.supersedesId, row);
  }

  // Walk back to the first version, then forward through the successors.
  let root: T | undefined = rows[0];
  const seenBack = new Set<string>();
  while (root && root.supersedesId !== null && !seenBack.has(root.id)) {
    seenBack.add(root.id);
    const parent: T | undefined = byId.get(root.supersedesId);
    if (!parent) break; // the predecessor is outside this set; start where we are
    root = parent;
  }

  const chain: T[] = [];
  const seen = new Set<string>();
  let current: T | undefined = root;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = successors.get(current.id);
  }
  return chain;
}

// ── Expiry ───────────────────────────────────────────────────────────────────

/**
 * §24's expiry ladder, which Phase 12 owns the *escalation* of and this phase
 * owns the *shape* of.
 *
 * `0` is included and is not one of the plan's four warning steps: it is the day
 * the document stops being valid, and a ladder that warns at 7 days and then says
 * nothing on the day itself is a ladder that goes quiet exactly when the
 * insurance lapses. Descending, because the crossing test takes the first match.
 */
export const DOCUMENT_EXPIRY_THRESHOLDS = [90, 60, 30, 14, 7, 0] as const;
export type DocumentExpiryThreshold = (typeof DOCUMENT_EXPIRY_THRESHOLDS)[number];

/**
 * Whole days from `today` to `expiresOn`, both `YYYY-MM-DD`.
 *
 * **Parsed as UTC midnight and subtracted**, which is safe precisely because both
 * sides are date-only strings with no clock in them: whose day it is has already
 * been decided upstream, by asking Postgres for `now() at time zone <the
 * company's zone>`. Doing that decision here — from a `Date` built in the
 * server's locale — is how a document expires a day early for everybody east of
 * the server.
 */
export function daysUntil(expiresOn: string, today: string): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const a = Date.parse(`${expiresOn}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Math.round((a - b) / MS_PER_DAY);
}

/**
 * Which rung of the ladder a document is on, or null when it is not on one yet.
 *
 * **The tightest rung it has reached: the SMALLEST threshold still at or above the
 * days remaining.** A document 45 days out has passed the 90 and 60 marks and is
 * on 60; at 29 days it moves to 30; at 7 to 7; on the day itself to 0. Six
 * distinct rungs, each a distinct outbox key, so each fires exactly once as the
 * date approaches.
 *
 * **Written the other way round first, and the unit test is what disagreed.** The
 * first version returned the largest rung at or below the days remaining, which
 * for the descending list means *everything* inside 90 days answers 90 — one
 * notification when the document first enters the window and then total silence
 * through 30, 14, 7 and the day it lapses. The ladder would have collapsed to a
 * single rung while every part of the code around it went on calling itself a
 * ladder. The bug was in the description and the loop equally, which is why they
 * agreed with each other.
 *
 * Each rung fires once because the outbox key is `(document, threshold)` — a
 * document sitting at 45 days for a fortnight re-enqueues `:60` every morning and
 * enqueues nothing new, which is what makes a daily scan safe to run daily.
 *
 * An expired document stays on rung `0` for ever rather than escalating further:
 * there is one fact to report — it has lapsed — and repeating it louder each day
 * is how a person learns to filter the sender.
 */
export function expiryThreshold(daysRemaining: number): DocumentExpiryThreshold | null {
  if (daysRemaining <= 0) return 0;
  // The list is descending, so the LAST rung that still contains this document is
  // the smallest one — the tightest warning it has earned.
  let rung: DocumentExpiryThreshold | null = null;
  for (const step of DOCUMENT_EXPIRY_THRESHOLDS) {
    if (daysRemaining <= step) rung = step;
  }
  return rung;
}

/** How a screen or a notification says it, from the category and the number alone. */
export function describeExpiry(args: {
  category: DocumentCategory;
  daysRemaining: number;
}): string {
  const label = DOCUMENT_CATEGORY_LABELS[args.category];
  if (args.daysRemaining < 0) {
    const days = Math.abs(args.daysRemaining);
    return `${label} expired ${days} ${days === 1 ? 'day' : 'days'} ago`;
  }
  if (args.daysRemaining === 0) return `${label} expires today`;
  return `${label} expires in ${args.daysRemaining} ${args.daysRemaining === 1 ? 'day' : 'days'}`;
}

// ── Events ───────────────────────────────────────────────────────────────────

/**
 * `document.expiring`, built by an allowlist like the evidence batch event.
 *
 * §11 names **document titles and references** in its exclusion list, and they
 * are the two fields somebody would reach for first when writing this payload:
 * a title is customer prose, and a reference is a waste transfer note number,
 * which is a fact about a real disposal at a real site. The category and the
 * version carry everything a notification needs to say.
 */
export function documentExpiryEventPayload(args: {
  documentId: string;
  projectId: string;
  ownerCompanyId: string;
  providerCompanyId: string | null;
  category: DocumentCategory;
  version: number;
  threshold: DocumentExpiryThreshold;
  daysRemaining: number;
}): Record<string, string | number | null> {
  return {
    documentId: args.documentId,
    projectId: args.projectId,
    ownerCompanyId: args.ownerCompanyId,
    providerCompanyId: args.providerCompanyId,
    category: args.category,
    version: args.version,
    threshold: args.threshold,
    daysRemaining: args.daysRemaining,
  };
}

/** `document.superseded`, same rule: ids, category and versions, never prose. */
export function documentSupersededEventPayload(args: {
  documentId: string;
  supersededId: string;
  projectId: string;
  ownerCompanyId: string;
  actorUserId: string;
  category: DocumentCategory;
  version: number;
  clientVisible: boolean;
}): Record<string, string | number | boolean> {
  return {
    documentId: args.documentId,
    supersededId: args.supersededId,
    projectId: args.projectId,
    ownerCompanyId: args.ownerCompanyId,
    actorUserId: args.actorUserId,
    category: args.category,
    version: args.version,
    clientVisible: args.clientVisible,
  };
}

/** "RAMS v3 replaced v2" — §6's Action Centre wording, from non-prose fields only. */
export function describeSupersession(args: {
  category: DocumentCategory;
  version: number;
}): string {
  return `${DOCUMENT_CATEGORY_LABELS[args.category]} v${args.version} replaced v${args.version - 1}`;
}
