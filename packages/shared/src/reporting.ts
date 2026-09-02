import { z } from 'zod';
import type { MassUnit } from './assets';
import type { CarbonDisplayUnit, DataQualityComponentResult } from './carbon-engine';
import type { PortalLineItem } from './portal';
import type { FactorSetCitation } from './sustainability';

/**
 * Reporting & client sign-off (CREWQUO_V2_PLAN.md §29, §34, §38.2) — step 0 of the
 * Phase 10 build order in `docs/operating-model/reporting-signoff.md` §14.
 *
 * **The pure half of the phase, and it is written before the migration for the
 * reason §27.1 gave about the carbon engine: the seal has to be right before
 * anything is sealed.** Everything here is data, types and total functions. It
 * knows nothing about Postgres, nothing about HTTP, and — the one that matters —
 * nothing about `node:crypto`.
 *
 * Three things live here and nowhere else:
 *
 *  - **`canonicalJson`**, the one serialization a `content_hash` is ever taken
 *    over. §29.4 says the hash is *"sha256 of the canonicalized snapshot"* and
 *    nothing in this repository canonicalized anything; see the header on the
 *    function for the three separate ways the naive version never verifies.
 *  - **The section catalog**, with each section's phase, so a completion pack
 *    cannot assert "no variations" about a feature that does not exist yet.
 *  - **`findProhibitedClaims`**, §29.3's claim guard, which is the only thing
 *    standing between an editable text box and a PDF that says a client's
 *    emissions were independently certified.
 *
 * The **sha256 is deliberately not here.** This package is pure and has no
 * `node:crypto`; `totp.ts` established the seam by taking its HMAC as an injected
 * function, and this follows it. The canonical *string* is shared so the writer
 * and the verifier cannot disagree; the digest over it belongs to the API.
 */

// ── The canonical form (§29.4, packet finding 4) ──────────────────────────────

/**
 * The one serialization a content hash is taken over.
 *
 * **Three separate ways the obvious implementation produces a seal that never
 * verifies**, each of which is why this function exists rather than a
 * `JSON.stringify` at the call site:
 *
 *  1. **`jsonb` reorders keys.** Postgres stores `jsonb` in its own order — by key
 *     length, then bytewise — and drops duplicates. Hash `JSON.stringify(snapshot)`
 *     on the way in, read the row back to check for tampering, hash again, and the
 *     two differ on every row with more than one key. A tamper detector that fires
 *     on everything is a tamper detector somebody switches off.
 *  2. **Numbers do not survive the round trip byte-identically.** A `numeric`
 *     rendered into JSON as `1.50` parses back to `1.5`. Same value, different
 *     bytes. Normalising through `JSON.stringify` of the *parsed* number gives the
 *     shortest round-trip form on both sides, so `1.50`, `1.5` and `1.500` seal
 *     identically — which they must, because they are the same quantity.
 *  3. **Key insertion order is a property of the code that built the object.** A
 *     refactor that moves one assignment three lines up would otherwise change
 *     every future hash while changing no figure, and the diff would look like
 *     tidying.
 *
 * **`undefined` throws rather than being dropped.** `JSON.stringify` silently
 * removes an undefined property, so a builder with a typo'd field name would seal
 * a document that is missing a section and produce a hash that verifies perfectly.
 * The absence has to be deliberate — write `null`.
 *
 * Non-finite numbers, `bigint`, `Date`, `Map`, `Set` and functions all throw for
 * the same reason: each has more than one plausible serialization, and picking one
 * here would make the seal depend on which one a future caller assumed. A snapshot
 * carries ISO strings and finite numbers, both of which mean exactly one thing.
 */
export function canonicalJson(value: unknown): string {
  return write(value, []);
}

function write(value: unknown, path: string[]): string {
  const where = path.length === 0 ? 'the snapshot root' : `$.${path.join('.')}`;

  if (value === null) return 'null';
  if (value === undefined) {
    throw new Error(
      `canonicalJson: undefined at ${where}. Write null — an omitted key seals as a valid document with a section missing.`
    );
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJson: ${String(value)} at ${where} has no JSON form.`);
      }
      // `-0` and `0` are the same quantity and must seal the same way;
      // `JSON.stringify(-0)` is already "0", and adding zero makes that explicit
      // rather than incidental.
      return JSON.stringify(value + 0);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw new Error(
        `canonicalJson: bigint at ${where}. A snapshot holds finite numbers and strings; choose one.`
      );
    default:
      break;
  }

  if (Array.isArray(value)) {
    // Array order is content, never sorted: "the three photographs, in this
    // order" is part of what was sealed.
    return `[${value.map((item, i) => write(item, [...path, String(i)])).join(',')}]`;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${write(value[key], [...path, key])}`);
    return `{${parts.join(',')}}`;
  }

  throw new Error(
    `canonicalJson: ${Object.prototype.toString.call(value)} at ${where} is not JSON data. ` +
      'Dates cross the wire as ISO strings and quantities as numbers.'
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * The first 32 hex characters of a content hash, upper-cased — a PDF `/ID`.
 *
 * Packet finding 1. jsPDF generates a `/ID` from `Math.random()` on every render,
 * which alone makes *"regenerable byte-identical a year later"* impossible. Seeding
 * it from the seal makes the identifier mean what the PDF specification says it
 * means: two files with the same `/ID` are two renders of the same frozen content.
 */
export function fileIdFromContentHash(contentHash: string): string {
  const hex = contentHash.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 32) {
    throw new Error('fileIdFromContentHash: need at least 32 hex characters');
  }
  return hex.slice(0, 32).toUpperCase();
}

/**
 * An ISO instant as a PDF date string, pinned to UTC.
 *
 * The other half of finding 1. `jsPDF.setCreationDate(new Date())` formats in the
 * *rendering machine's* local zone, so the same document rendered on Render and on
 * a laptop differs in bytes within the same second. Passing the string form skips
 * jsPDF's `Date` conversion entirely and fixes the offset at `+00'00'`, which makes
 * the creation date a fact about the report rather than about the server.
 */
export function pdfCreationDate(iso: string): string {
  const digits = iso.replace(/[^0-9]/g, '').slice(0, 14);
  if (digits.length !== 14) {
    throw new Error(`pdfCreationDate: ${iso} is not a full ISO instant`);
  }
  return `D:${digits}+00'00'`;
}

// ── Kinds, audiences, statuses (§29.4) ────────────────────────────────────────

/**
 * §29.4 lists three. **`CLIENT_EXPORT` is the fourth, and it is packet finding 2.**
 *
 * §29.5 says the client-facing project export *"renders from a `generated_reports`
 * snapshot, never from live data"*, and none of §29.4's three kinds is a BILL-side
 * project statement. Built literally, either that export gets no snapshot and
 * recalculates — the exact behaviour the owner decision of 2026-08-17 moved it out
 * of Phase 4 to prevent — or a check constraint quietly widens later, in a
 * migration whose stated purpose is something else.
 */
export const REPORT_KINDS = [
  'SUSTAINABILITY',
  'EVIDENCE_PACK',
  'CLIENT_EXPORT',
  'CLIENT_PERIOD',
] as const;
export const reportKindSchema = z.enum(REPORT_KINDS);
export type ReportKind = z.infer<typeof reportKindSchema>;

/**
 * Who the snapshot was **assembled for**, fixed at generation and never updatable.
 *
 * Packet finding 3, and the first of the three layers standing between the money
 * boundary and a file that leaves the building. §29.1's Project overview names the
 * subcontractors; §29.5 forbids naming them to a client; and §29.4 gives the
 * document a `client_visible` flag anybody with `report.generate` can set. Without
 * this column, disclosure is a filter applied to a document built for a different
 * reader — which is exactly what §29.5 says the exclusion must not be.
 *
 * The other two layers are the check constraint in `0043` and the two type
 * families below, and all three are cheap against an event that cannot be undone.
 */
export const REPORT_AUDIENCES = ['INTERNAL', 'CLIENT'] as const;
export const reportAudienceSchema = z.enum(REPORT_AUDIENCES);
export type ReportAudience = z.infer<typeof reportAudienceSchema>;

export const REPORT_STATUSES = ['GENERATED', 'SUPERSEDED', 'VOID'] as const;
export const reportStatusSchema = z.enum(REPORT_STATUSES);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

/** The audience each kind is capable of. A kind that can only face one says so. */
export const KIND_AUDIENCES: Readonly<Record<ReportKind, readonly ReportAudience[]>> = {
  // Runs both ways: the internal copy names the subcontractors, the client copy
  // counts them (packet finding 3).
  SUSTAINABILITY: ['INTERNAL', 'CLIENT'],
  // The operational pack. Internal by default; a client copy exists because §29.2
  // is what a QS asks for at handover, and it carries the same workforce rule.
  EVIDENCE_PACK: ['INTERNAL', 'CLIENT'],
  // **Client only, by construction.** There is no internal version of §29.5: the
  // owner's own project export is Phase 4's live one, which shows PAY and margin.
  // Offering an INTERNAL client-export would be a second owner-side document with
  // the owner's figures deliberately removed, which is not a thing anybody wants.
  CLIENT_EXPORT: ['CLIENT'],
  CLIENT_PERIOD: ['INTERNAL', 'CLIENT'],
};

// ── The section catalog (§29.1, §29.2, packet finding 11) ─────────────────────

/**
 * The phase this build has reached.
 *
 * Not a constant somebody has to remember to bump: `availableSections` reads it,
 * and a section keyed to a later phase is **absent from the toggle list and absent
 * from the document** rather than rendering as empty. §29.2 lists variations and
 * incidents; variations arrive in Phase 11 and incidents have no table anywhere in
 * the plan's DDL. A completion pack that asserts *no variations* about a feature
 * that does not exist is §41.1's invented number wearing a different hat, and it is
 * the most quotable sentence in the document during a dispute.
 */
export const CURRENT_BUILD_PHASE = 10;

export const REPORT_SECTION_KEYS = [
  // §29.1 — the Sustainability & Completion report, in its stated order.
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
  // §29.2 — the operational counterpart.
  'PACK_PROJECT_DETAILS',
  'PACK_WORK_COMPLETED',
  'PACK_SITE_DIARY',
  'PACK_CREW',
  'PACK_HOURS',
  'PACK_PHOTOS',
  'PACK_ASSETS_REMOVED',
  'PACK_DESTINATION_RECORDS',
  'PACK_WASTE_TRANSFER',
  'PACK_RECYCLING_DOCS',
  'PACK_DONATION_EVIDENCE',
  'PACK_VARIATIONS',
  'PACK_INCIDENTS',
  'PACK_SIGNOFF',
  // §29.5 — the client's BILL-side statement.
  'STATEMENT_SUMMARY',
  'STATEMENT_LINE_ITEMS',
  // §38.2 — the client period roll-up.
  'PERIOD_SUMMARY',
  'PERIOD_PROJECTS',
  'PERIOD_MATERIALS',
  'PERIOD_CARBON',
] as const;
export const reportSectionKeySchema = z.enum(REPORT_SECTION_KEYS);
export type ReportSectionKey = z.infer<typeof reportSectionKeySchema>;

export interface ReportSectionSpec {
  key: ReportSectionKey;
  kind: ReportKind;
  label: string;
  /** Included unless the generator turns it off. */
  defaultOn: boolean;
  /**
   * False for the structural sections a document is not a document without — a
   * cover with no project name, or a methodology-free carbon page, is not a
   * shorter report but a misleading one.
   */
  toggleable: boolean;
  /**
   * The build phase that makes this section's source records exist. `null` means
   * **no table for it exists anywhere in the plan**, which is a stronger statement
   * than "later" and is why `PACK_INCIDENTS` is in this list rather than quietly
   * omitted: the next person to read §29.2 will look for it.
   */
  availableFrom: number | null;
}

export const REPORT_SECTIONS: readonly ReportSectionSpec[] = [
  // §29.1's twelve, in order. The order of this array is the order of the document.
  { key: 'COVER', kind: 'SUSTAINABILITY', label: 'Cover', defaultOn: true, toggleable: false, availableFrom: 10 },
  { key: 'EXECUTIVE_SUMMARY', kind: 'SUSTAINABILITY', label: 'Executive summary', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PROJECT_OVERVIEW', kind: 'SUSTAINABILITY', label: 'Project overview', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'SUSTAINABILITY_HIGHLIGHTS', kind: 'SUSTAINABILITY', label: 'Sustainability highlights', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'ASSET_OUTCOMES', kind: 'SUSTAINABILITY', label: 'Asset outcomes', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'MATERIAL_BREAKDOWN', kind: 'SUSTAINABILITY', label: 'Material breakdown', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'REUSE_DONATION', kind: 'SUSTAINABILITY', label: 'Reuse & donation', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'RECYCLING_WASTE', kind: 'SUSTAINABILITY', label: 'Recycling & waste', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'CARBON_SUMMARY', kind: 'SUSTAINABILITY', label: 'Carbon summary', defaultOn: true, toggleable: true, availableFrom: 10 },
  /*
   * **Not toggleable, and it is the one entry in this table that is a rule rather
   * than a preference.** §41.2 requires every published figure to be traceable to
   * its factor and version, and §29.3's disclaimer lives on this page. A carbon
   * summary with the methodology switched off is the document §41 exists to
   * prevent — two headline numbers with nothing behind them.
   */
  { key: 'CARBON_METHODOLOGY', kind: 'SUSTAINABILITY', label: 'Carbon methodology', defaultOn: true, toggleable: false, availableFrom: 10 },
  { key: 'EVIDENCE', kind: 'SUSTAINABILITY', label: 'Evidence', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PROJECT_COMPLETION', kind: 'SUSTAINABILITY', label: 'Project completion', defaultOn: true, toggleable: true, availableFrom: 10 },

  // §29.2's pack.
  { key: 'PACK_PROJECT_DETAILS', kind: 'EVIDENCE_PACK', label: 'Project details', defaultOn: true, toggleable: false, availableFrom: 10 },
  { key: 'PACK_WORK_COMPLETED', kind: 'EVIDENCE_PACK', label: 'Work completed', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PACK_SITE_DIARY', kind: 'EVIDENCE_PACK', label: 'Site diary', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PACK_CREW', kind: 'EVIDENCE_PACK', label: 'Crew', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PACK_HOURS', kind: 'EVIDENCE_PACK', label: 'Hours', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PACK_PHOTOS', kind: 'EVIDENCE_PACK', label: 'Before / during / after photographs', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PACK_ASSETS_REMOVED', kind: 'EVIDENCE_PACK', label: 'Assets removed', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PACK_DESTINATION_RECORDS', kind: 'EVIDENCE_PACK', label: 'Destination records', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PACK_WASTE_TRANSFER', kind: 'EVIDENCE_PACK', label: 'Waste transfer notes', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PACK_RECYCLING_DOCS', kind: 'EVIDENCE_PACK', label: 'Recycling documentation', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PACK_DONATION_EVIDENCE', kind: 'EVIDENCE_PACK', label: 'Donation evidence', defaultOn: true, toggleable: true, availableFrom: 10 },
  /*
   * §30.1, Phase 11. Absent from the toggle list until then — not offered, not
   * defaulted, not rendered empty (packet finding 11). When Phase 11 lands this
   * `11` needs no edit at all; `CURRENT_BUILD_PHASE` moves and the section appears
   * for reports generated afterwards, while every report generated before it keeps
   * its own stored `sections` array. That is why §29.2 stores the chosen set.
   */
  { key: 'PACK_VARIATIONS', kind: 'EVIDENCE_PACK', label: 'Variations', defaultOn: true, toggleable: true, availableFrom: 11 },
  /*
   * §29.2 names incidents and **no table for them exists anywhere in the plan's
   * DDL** — not in §3, not in §25, not in §30 through §35. `null` says so out loud
   * rather than guessing a phase, because the honest state is "unspecified", and
   * the next reader of §29.2 will come looking for exactly this line.
   */
  { key: 'PACK_INCIDENTS', kind: 'EVIDENCE_PACK', label: 'Incidents', defaultOn: true, toggleable: true, availableFrom: null },
  { key: 'PACK_SIGNOFF', kind: 'EVIDENCE_PACK', label: 'Client sign-off', defaultOn: true, toggleable: true, availableFrom: 10 },

  // §29.5.
  { key: 'STATEMENT_SUMMARY', kind: 'CLIENT_EXPORT', label: 'Summary', defaultOn: true, toggleable: false, availableFrom: 10 },
  { key: 'STATEMENT_LINE_ITEMS', kind: 'CLIENT_EXPORT', label: 'Line items', defaultOn: true, toggleable: true, availableFrom: 10 },

  // §38.2.
  { key: 'PERIOD_SUMMARY', kind: 'CLIENT_PERIOD', label: 'Period summary', defaultOn: true, toggleable: false, availableFrom: 10 },
  { key: 'PERIOD_PROJECTS', kind: 'CLIENT_PERIOD', label: 'Projects', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PERIOD_MATERIALS', kind: 'CLIENT_PERIOD', label: 'Materials', defaultOn: true, toggleable: true, availableFrom: 10 },
  { key: 'PERIOD_CARBON', kind: 'CLIENT_PERIOD', label: 'Carbon', defaultOn: true, toggleable: false, availableFrom: 10 },
];

/** The sections a document of this kind may carry in a build at `phase`. */
export function availableSections(
  kind: ReportKind,
  phase: number = CURRENT_BUILD_PHASE
): ReportSectionSpec[] {
  return REPORT_SECTIONS.filter(
    (s) => s.kind === kind && s.availableFrom !== null && s.availableFrom <= phase
  );
}

/** The default set, in document order. */
export function defaultSections(
  kind: ReportKind,
  phase: number = CURRENT_BUILD_PHASE
): ReportSectionKey[] {
  return availableSections(kind, phase)
    .filter((s) => s.defaultOn)
    .map((s) => s.key);
}

/**
 * Reconcile a requested set against what this kind and this build actually have.
 *
 * **Order comes from the catalog, never from the request.** A caller that sends
 * `['EVIDENCE','COVER']` gets a document with the cover first, because the order of
 * §29.1's twelve sections is part of what §29.1 specifies — and because two reports
 * of the same project with the same figures in a different order would seal to two
 * different hashes and read as a change.
 *
 * Unavailable and unknown keys are dropped rather than refused. A client that
 * remembers `PACK_VARIATIONS` from a newer build, or an older stored set replayed
 * into a regeneration, should produce the best document this build can make rather
 * than an error a person cannot act on.
 */
export function resolveSections(
  kind: ReportKind,
  requested: readonly string[] | null | undefined,
  phase: number = CURRENT_BUILD_PHASE
): ReportSectionKey[] {
  const available = availableSections(kind, phase);
  if (requested === null || requested === undefined) {
    return available.filter((s) => s.defaultOn).map((s) => s.key);
  }
  const asked = new Set(requested);
  return available
    .filter((s) => asked.has(s.key) || !s.toggleable)
    .map((s) => s.key);
}

// ── The claim guard (§29.3, packet finding 7) ─────────────────────────────────

export interface ProhibitedClaim {
  /** The text that matched, exactly as it appeared. */
  phrase: string;
  /** Which prohibition it fell under. */
  rule: ProhibitedClaimRule;
  /** Why it is refused, in a sentence a customer can act on. */
  why: string;
  /** The sentence it appeared in, so the customer can find it. */
  excerpt: string;
}

export const PROHIBITED_CLAIM_RULES = [
  'INDEPENDENT_ASSURANCE',
  'STANDARD_CERTIFICATION',
  'FORMAL_ASSURANCE_LEVEL',
  'FIRST_PARTY_CERTIFICATION',
] as const;
export type ProhibitedClaimRule = (typeof PROHIBITED_CLAIM_RULES)[number];

interface ClaimRule {
  rule: ProhibitedClaimRule;
  pattern: RegExp;
  why: string;
}

/**
 * §29.3's two prohibitions, as four narrow rules.
 *
 * **Narrow on purpose.** The obvious implementation refuses the word "verified",
 * and the word "verified" is part of this product's own vocabulary: §25.3 makes
 * `VERIFIED` a weight confidence, and *"asset weights recorded as VERIFIED are
 * supported by a weighbridge ticket"* is a sentence a disclaimer should be able to
 * contain. What §29.3 forbids is a claim about **this report's assurance status**,
 * so every rule here requires either an independence modifier or a named standard.
 *
 * Mentioning a standard is likewise fine and explicitly so — §29.3's whole
 * objection is to claiming certification *"because the methodology references those
 * standards"*, which means the reference itself is legitimate. `GHG Protocol
 * Corporate Standard` passes; `certified to the GHG Protocol` does not.
 */
const CLAIM_RULES: readonly ClaimRule[] = [
  {
    rule: 'INDEPENDENT_ASSURANCE',
    pattern:
      /\b(independent(?:ly)?|third[\s-]?party|external(?:ly)?)\s+(?:\w+\s+){0,2}?(verif\w*|assur\w*|audit\w*|certif\w*|validat\w*)\b/gi,
    why: 'CrewQuo does not independently verify, audit or assure a report (§29.3). Describe what the figures are based on instead.',
  },
  {
    rule: 'STANDARD_CERTIFICATION',
    pattern:
      /\b(?:certif\w*|accredit\w*|registered)\s+(?:to|under|against|by|with|in\s+accordance\s+with)\s+(?:the\s+)?(iso\b[\s\d:-]*|ghg\s+protocol|pas\s?2060|bs\s?\d+|en\s?\d+)|\b(?:iso\b[\s\d:-]*|ghg\s+protocol)[\s-]*(?:certified|accredited)\b/gi,
    why: 'Referencing a standard is not certification against it (§29.3). Say the methodology is aligned with it, not certified to it.',
  },
  {
    rule: 'FORMAL_ASSURANCE_LEVEL',
    pattern: /\b(limited|reasonable)\s+assurance\b|\bassurance\s+(statement|opinion)\b/gi,
    why: 'These are the formal assurance levels of ISAE 3000 and equivalent standards. No assurance engagement has been performed (§29.3).',
  },
  {
    rule: 'FIRST_PARTY_CERTIFICATION',
    pattern: /\b(we|crewquo|this\s+report)\s+(?:hereby\s+)?certif\w+\b/gi,
    why: 'A report cannot certify itself (§29.3). State the data sources and the assumptions instead.',
  },
];

/**
 * Words that turn a prohibited claim into an honest disclaimer of one.
 *
 * *"This report has **not** been independently verified"* is the sentence §29.3
 * most wants a customer to be able to write, and a guard that refuses it would push
 * people towards saying nothing — which is the worse outcome, because silence reads
 * as assurance to a reader who does not know to ask.
 *
 * Scoped to the text **preceding the match within its own sentence**, so a
 * negation two sentences earlier does not launder a claim later on.
 */
const NEGATORS = /\b(not|never|no|without|neither|nor|excludes?|absent|lacks?)\b/i;

/**
 * Sentence boundaries, roughly.
 *
 * Deliberately crude: a wrong split makes the *excerpt* less useful, never the
 * verdict wrong, because every rule matches within a phrase far shorter than a
 * sentence. A dependency for this would be a dependency in the one place where a
 * false negative publishes something.
 */
function sentencesOf(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let start = 0;
  const boundary = /[.!?](?=\s|$)|\n+/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length;
    out.push({ text: text.slice(start, end), start });
    start = end;
  }
  if (start < text.length) out.push({ text: text.slice(start), start });
  return out;
}

/**
 * Every prohibited claim in a piece of text, with the sentence it appeared in.
 *
 * Applied **twice** and the second time is the one that matters (packet finding 7):
 * on save, so the customer is told immediately and can fix it; and again at
 * generation, because a disclaimer edited before this guard shipped, restored from
 * a backup or written by an operator would otherwise be frozen into a snapshot,
 * rendered under a client's logo and handed over.
 *
 * Returns an empty array for text that is fine, so the call site reads as a list of
 * problems rather than as a boolean somebody has to remember to invert.
 */
export function findProhibitedClaims(text: string): ProhibitedClaim[] {
  const found: ProhibitedClaim[] = [];
  const seen = new Set<string>();

  for (const sentence of sentencesOf(text)) {
    for (const { rule, pattern, why } of CLAIM_RULES) {
      // A fresh regex per sentence: `lastIndex` on a shared global regex is state,
      // and shared mutable state in a validator is a validator that passes on
      // every second call.
      const re = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(sentence.text)) !== null) {
        const before = sentence.text.slice(0, match.index);
        if (NEGATORS.test(before)) continue;
        const key = `${rule}:${match.index + sentence.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          phrase: match[0].trim(),
          rule,
          why,
          excerpt: sentence.text.trim(),
        });
      }
    }
  }
  return found;
}

/** One sentence naming what has to change, for an error body. */
export function describeProhibitedClaims(claims: readonly ProhibitedClaim[]): string {
  if (claims.length === 0) return '';
  const first = claims[0]!;
  const rest =
    claims.length > 1 ? ` (and ${claims.length - 1} other${claims.length === 2 ? '' : 's'})` : '';
  return `“${first.phrase}”${rest} cannot appear in a report disclaimer. ${first.why}`;
}

// ── Staleness (§13.6 of project-evidence.md, packet finding 10) ───────────────

export const SOURCE_REVISION_KINDS = ['DIARY', 'ASSET', 'MOVEMENT', 'CALCULATIONS'] as const;
export type SourceRevisionKind = (typeof SOURCE_REVISION_KINDS)[number];

/**
 * One record class the snapshot cited, and the revision it was at when it did.
 *
 * The evidence packet's §13.6, generalised. §29.4 says a re-render never
 * recalculates; §23 says *"amended N times"* follows an entry everywhere including
 * into reports. A document can satisfy exactly one of those — so it satisfies §29.4
 * and reports the divergence instead, which is what §23 is actually protecting.
 *
 * Generalised past the diary because the same integer answers the same question for
 * an amended asset line, a corrected movement and a re-run calculation, and *"has
 * anything behind this document changed?"* has to be one query against integers
 * rather than a re-derivation that would itself violate §29.4.
 */
export interface SourceRevision {
  kind: SourceRevisionKind;
  /** The row, or `null` for `CALCULATIONS`, which is per-project. */
  id: string | null;
  /** What a reader recognises it by: a diary date, an asset name. */
  label: string;
  revision: number;
}

export interface StaleSource extends SourceRevision {
  /** What that record's revision is now. Always greater than `revision`. */
  currentRevision: number;
}

/**
 * The banner sentence, one per changed source.
 *
 * Deliberately says *"has been amended since this report was generated"* rather
 * than *"this report is out of date"*: the report is not out of date, it is a
 * correct record of what was said. The reader is being told there is a newer truth,
 * which is a different and more useful statement.
 */
export function describeStaleSources(sources: readonly StaleSource[]): string[] {
  return sources.map((s) => {
    switch (s.kind) {
      case 'DIARY':
        return `The site diary for ${s.label} has been amended since this report was generated.`;
      case 'ASSET':
        return `The asset line “${s.label}” has been corrected since this report was generated.`;
      case 'MOVEMENT':
        return `A recorded movement of “${s.label}” has been corrected since this report was generated.`;
      case 'CALCULATIONS':
        return 'The carbon calculations for this project have been re-run since this report was generated.';
    }
  });
}

// ── The two audience type families (packet finding 3) ─────────────────────────

/**
 * §29.1 section 3's workforce line, for a reader inside the tenancy.
 *
 * Names the subcontractors, because to the contractor's own project manager that is
 * simply who was on the job.
 */
export interface InternalWorkforce {
  audience: 'INTERNAL';
  people: number;
  hours: number;
  subcontractors: { companyId: string; name: string; hours: number }[];
}

/**
 * The same line for a reader outside it — **and the shape is the guarantee**.
 *
 * §29.5 requires the exclusion to be structural, *"so the exclusion cannot be
 * forgotten by a later edit the way a `select` list can"*. A provider's name is not
 * filtered out of a client's document here; there is no field it could occupy. The
 * fact §29.1 wanted — the size of the operation — survives as a count, which is what
 * a completion report is actually communicating.
 */
export interface ClientWorkforceSummary {
  audience: 'CLIENT';
  people: number;
  hours: number;
  subcontractedOrganisations: number;
}

export type WorkforceBlock = InternalWorkforce | ClientWorkforceSummary;

// ── Snapshot shapes (§29.4) ───────────────────────────────────────────────────

/**
 * Everything every snapshot carries, whatever its kind.
 *
 * `schemaVersion` is not decoration. A snapshot is read back years later by code
 * that has moved on, and the alternative to a version is a reader guessing from
 * which keys are present — which is how a missing section becomes an empty one.
 */
export interface ReportSnapshotMeta {
  schemaVersion: 1;
  kind: ReportKind;
  audience: ReportAudience;
  title: string;
  /** The instant the numbers were true as of. Also the PDF's creation date. */
  generatedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  contractor: { companyId: string; name: string; logoFileId: string | null };
  /**
   * Branding resolves client-first (decision #30): the client company's own
   * report logo is the default, a project override wins, and whichever won is
   * frozen here with the source that produced it — so a reader a year later can
   * see whose asset it was rather than only that there was one.
   */
  client: {
    companyId: string | null;
    name: string | null;
    logoFileId: string | null;
    logoSource: 'PROJECT_OVERRIDE' | 'CLIENT_DEFAULT' | 'NONE';
  };
  /** §29.3's text, frozen verbatim. Never re-read from settings at render. */
  disclaimer: string;
  sections: ReportSectionKey[];
  factorSets: FactorSetCitation[];
  sourceRevisions: SourceRevision[];
  /** Every file the document points at. Mirrored into `report_file_references`. */
  fileIds: string[];
  display: { carbonUnit: CarbonDisplayUnit; massUnit: MassUnit };
}

export interface SnapshotProject {
  id: string;
  name: string;
  reference: string | null;
  status: string;
  startsOn: string | null;
  endsOn: string | null;
  site: string | null;
  notes: string | null;
}

export interface SnapshotMassRow {
  label: string;
  massKg: number;
  /** Share of handled mass, 0–100, or null when nothing was handled. */
  pct: number | null;
}

export interface SnapshotEvidenceItem {
  fileId: string;
  caption: string;
  category: string;
  capturedAt: string | null;
}

export interface SnapshotDocumentRow {
  id: string;
  title: string;
  category: string;
  issuedOn: string | null;
  reference: string | null;
  fileId: string | null;
}

/** §29.1's two headlines, and the shape that keeps them apart. */
export interface SnapshotCarbon {
  /**
   * Null when nothing has been calculated. **Never zero** — §41.1, and the rule the
   * whole carbon engine was branded to protect. A project with no factor set has
   * not emitted nothing.
   */
  projectEmissionsKgCo2e: number | null;
  avoidedKgCo2e: number | null;
  byBucket: { bucket: string; kgCo2e: number; rowCount: number }[];
  byScope: { scope: string; kgCo2e: number }[];
  scope2Basis: 'LOCATION_BASED';
  methodologyWarning: string;
  gaps: string[];
  completeness: {
    pct: number | null;
    warnBelow: number;
    components: (DataQualityComponentResult & { label: string })[];
  };
  calculatedAt: string | null;
  /**
   * A fingerprint of the ledger the figures came from, so §41.3's *"a newer factor
   * set is never applied retrospectively"* is checkable rather than asserted.
   */
  ledgerFingerprint: string | null;
}

export interface SustainabilitySnapshot {
  kind: 'SUSTAINABILITY';
  project: SnapshotProject;
  overview: {
    projectManager: string | null;
    supervisor: string | null;
    workforce: WorkforceBlock;
  };
  executiveSummary: string[];
  highlights: { label: string; value: string; note: string | null }[];
  massHandledKg: number;
  outcomes: SnapshotMassRow[];
  materials: SnapshotMassRow[];
  reuse: SnapshotMassRow[];
  waste: SnapshotMassRow[];
  rates: { retainedInUsePct: number | null; diversionPct: number | null; reusePct: number | null; recyclingPct: number | null };
  carbon: SnapshotCarbon;
  evidence: SnapshotEvidenceItem[];
  completion: {
    completedOn: string | null;
    signoff: {
      signerName: string;
      signerCompany: string | null;
      signerRole: string | null;
      signedAt: string;
      completionStatement: string;
      comments: string | null;
      signatureFileId: string | null;
    } | null;
  };
}

export interface EvidencePackSnapshot {
  kind: 'EVIDENCE_PACK';
  project: SnapshotProject;
  workforce: WorkforceBlock;
  workCompleted: string[];
  diary: {
    entryId: string;
    date: string;
    revision: number;
    weather: string | null;
    narrative: string[];
    attendanceCount: number;
    status: string;
  }[];
  hours: { label: string; hoursRegular: number; hoursOt: number }[];
  photos: SnapshotEvidenceItem[];
  assets: {
    id: string;
    name: string;
    quantity: number;
    massKg: number | null;
    outcome: string;
    destinations: string[];
  }[];
  destinationRecords: {
    movementId: string;
    assetName: string;
    destination: string;
    organisation: string | null;
    movedOn: string;
    quantity: number;
    massKg: number | null;
    reference: string | null;
  }[];
  wasteTransferNotes: SnapshotDocumentRow[];
  recyclingDocuments: SnapshotDocumentRow[];
  donationEvidence: SnapshotDocumentRow[];
  signoff: SustainabilitySnapshot['completion']['signoff'];
}

/**
 * §29.5, and the reason it is a separate shape rather than a flag on the others.
 *
 * `lineItems` is `PortalLineItem[]` — the type the portal already uses, which
 * carries `amountCents` (BILL) and has no field for a PAY figure, a rate snapshot
 * or a provider name. That is not a convention; it is the whole mechanism §29.5
 * asks for, and it is why this snapshot cannot be built from `ProjectExportModel`.
 */
export interface ClientExportSnapshot {
  kind: 'CLIENT_EXPORT';
  project: {
    id: string;
    name: string;
    status: string;
    startsOn: string | null;
    endsOn: string | null;
  };
  currency: string;
  lineItems: PortalLineItem[];
  timeTotalCents: number;
  expenseTotalCents: number;
  totalCents: number;
  /** False when at least one line had no BILL rate. The total is a floor. */
  pricingComplete: boolean;
}

export interface ClientPeriodSnapshot {
  kind: 'CLIENT_PERIOD';
  client: { name: string; identities: { companyId: string; name: string; placeholder: boolean }[] };
  projectCount: number;
  projects: { id: string; name: string; startsOn: string | null; endsOn: string | null; massKg: number }[];
  totalMassKg: number;
  materials: SnapshotMassRow[];
  outcomes: SnapshotMassRow[];
  rates: { retainedInUsePct: number | null; diversionPct: number | null };
  carbon: { projectEmissionsKgCo2e: number | null; avoidedKgCo2e: number | null };
  /** §38.2: "a period spanning two factor sets says so." */
  mixedFactorYears: boolean;
  factorYears: number[];
}

export type ReportSnapshotBody =
  | SustainabilitySnapshot
  | EvidencePackSnapshot
  | ClientExportSnapshot
  | ClientPeriodSnapshot;

export interface ReportSnapshot {
  meta: ReportSnapshotMeta;
  body: ReportSnapshotBody;
}

// ── Wire views ────────────────────────────────────────────────────────────────

export interface GeneratedReportView {
  id: string;
  companyId: string;
  projectId: string | null;
  projectName: string | null;
  clientCompanyId: string | null;
  clientCompanyName: string | null;
  kind: ReportKind;
  audience: ReportAudience;
  title: string;
  periodStart: string | null;
  periodEnd: string | null;
  sections: ReportSectionKey[];
  contentHash: string;
  factorSetIds: string[];
  disclaimer: string;
  fileId: string | null;
  status: ReportStatus;
  supersedesId: string | null;
  supersededById: string | null;
  voidReason: string | null;
  clientVisible: boolean;
  generatedByUserId: string | null;
  generatedByName: string | null;
  generatedAt: string;
}

export interface GeneratedReportDetail {
  report: GeneratedReportView;
  snapshot: ReportSnapshot;
  /** Empty when nothing behind the document has moved. */
  staleSources: StaleSource[];
  /** `describeStaleSources`, resolved server-side so every client says it alike. */
  staleNotes: string[];
}

export interface ClientSignoffView {
  id: string;
  projectId: string;
  companyId: string;
  engagementId: string | null;
  phase: string | null;
  signerName: string;
  signerCompany: string | null;
  signerRole: string | null;
  signerEmail: string | null;
  signatureFileId: string | null;
  completionStatement: string;
  comments: string | null;
  signedAt: string;
  contentHash: string;
  supersedesId: string | null;
  supersededById: string | null;
  supersedeReason: string | null;
  capturedByUserId: string | null;
  capturedByName: string | null;
  createdAt: string;
}

export interface ClientSignoffDetail {
  signoff: ClientSignoffView;
  evidenceSnapshot: Record<string, unknown>;
}

// ── Request schemas ───────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const generateReportSchema = z
  .object({
    kind: reportKindSchema,
    audience: reportAudienceSchema,
    title: z.string().trim().min(1).max(200).optional(),
    sections: z.array(z.string().max(60)).max(60).optional(),
    periodStart: isoDate.optional(),
    periodEnd: isoDate.optional(),
    /** CLIENT_PERIOD only: whose year this is. */
    clientCompanyId: z.string().uuid().optional(),
    /** Supersede the current report of this kind rather than sitting beside it. */
    supersedes: z.boolean().optional(),
  })
  .refine((v) => KIND_AUDIENCES[v.kind].includes(v.audience), {
    message: 'That report kind cannot be produced for that audience',
    path: ['audience'],
  })
  .refine((v) => !(v.periodStart && v.periodEnd) || v.periodStart <= v.periodEnd, {
    message: 'periodStart must not be after periodEnd',
    path: ['periodEnd'],
  })
  .refine((v) => v.kind !== 'CLIENT_PERIOD' || (!!v.periodStart && !!v.periodEnd), {
    message: 'A client period report needs a period',
    path: ['periodStart'],
  });
export type GenerateReport = z.infer<typeof generateReportSchema>;

export const setReportVisibilitySchema = z.object({ clientVisible: z.boolean() });
export type SetReportVisibility = z.infer<typeof setReportVisibilitySchema>;

export const voidReportSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type VoidReport = z.infer<typeof voidReportSchema>;

export const listReportsQuerySchema = z.object({
  kind: reportKindSchema.optional(),
  status: reportStatusSchema.optional(),
  includeSuperseded: z.boolean().optional(),
});
export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;

/**
 * §34's capture.
 *
 * `evidenceSnapshot` is **required and comes from the device** (packet §8). If the
 * server assembled it at sync time, a signature captured at 14:02 on a tablet with
 * no signal would freeze the state at 18:40 — after that afternoon's photographs
 * were uploaded — and attest to an evidence set the signer never saw.
 *
 * `signedAt` is deliberately **absent from this schema**. The device says when it
 * captured through `capturedAt` inside its own snapshot; the row's `signed_at` is
 * the server's clock, because a timestamp a client chooses is a timestamp a client
 * can choose.
 */
export const createSignoffSchema = z.object({
  clientId: z.string().uuid().optional(),
  phase: z.string().trim().min(1).max(120).nullable().optional(),
  signerName: z.string().trim().min(1).max(200),
  signerCompany: z.string().trim().max(200).nullable().optional(),
  signerRole: z.string().trim().max(120).nullable().optional(),
  signerEmail: z.string().trim().email().max(320).nullable().optional(),
  signatureFileId: z.string().uuid().nullable().optional(),
  completionStatement: z.string().trim().min(1).max(4000),
  comments: z.string().trim().max(4000).nullable().optional(),
  evidenceSnapshot: z.record(z.unknown()),
  supersedesId: z.string().uuid().optional(),
  supersedeReason: z.string().trim().min(3).max(500).optional(),
});
export type CreateSignoff = z.infer<typeof createSignoffSchema>;

export const clientPeriodQuerySchema = z.object({
  clientCompanyId: z.string().uuid(),
  from: isoDate,
  to: isoDate,
});
export type ClientPeriodQuery = z.infer<typeof clientPeriodQuerySchema>;

// ── Event payloads ────────────────────────────────────────────────────────────

export const REPORT_EVENT_TOPICS = [
  'report.disclosed',
  'report.superseded',
  'signoff.captured',
  'signoff.superseded',
] as const;
export type ReportEventTopic = (typeof REPORT_EVENT_TOPICS)[number];

/**
 * What moved between two snapshots, computed inside the generating transaction.
 *
 * On the event rather than left to a consumer, because a consumer would have to
 * open both snapshots to answer *"what changed?"* — and the only recipient who
 * needs the answer is a client who was sent the earlier document and has no access
 * to either.
 */
export interface ChangedFigure {
  label: string;
  from: number | null;
  to: number | null;
}

export function describeChangedFigures(changes: readonly ChangedFigure[]): string {
  if (changes.length === 0) return 'The supporting records changed; no headline figure moved.';
  return changes
    .map((c) => `${c.label}: ${c.from ?? 'not calculated'} → ${c.to ?? 'not calculated'}`)
    .join('; ');
}
