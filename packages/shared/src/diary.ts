import { z } from 'zod';
import { mergeFieldwise, type FieldMergeResult } from './sync';

/**
 * The site diary (CREWQUO_V2_PLAN.md §23) — step 6 of the Phase 7 build order in
 * `docs/operating-model/project-evidence.md` §14, and the last record in the
 * phase.
 *
 * **A per-project, per-day record of what actually happened**, and the first
 * thing anyone reaches for in a dispute. Three rules follow from that and they
 * are the whole design:
 *
 *  - **There is no reopen.** A day goes `OPEN → CLOSED` and stays closed. A
 *    post-close change is an *amendment* — a recorded change to a closed record —
 *    which is a different and more honest object than a closed day becoming open
 *    again.
 *  - **Every post-close change carries a reason and is counted.** "Amended 2
 *    times — view history" renders wherever the entry appears, including in a
 *    report, and the count is derived from the revisions rather than stored
 *    beside them.
 *  - **Two companies on one site keep two diaries.** A subcontractor's entry is
 *    its own record, not a draft of the hiring company's, and both are true.
 *
 * Pure, like the rest of the phase: the API loads rows and calls these.
 */

// ── The narrative ────────────────────────────────────────────────────────────

/**
 * §23's free-text fields, in the plan's order, as **one list every consumer
 * reads**.
 *
 * The merge, the audit diff, the "is this day empty" check and the screens all
 * need to know which fields are narrative. Written out four times, one of the
 * four is wrong within a phase — and the one that is wrong is whichever a later
 * author did not know existed.
 *
 * **Thirteen, not fourteen.** The packet's §3 and §8 both say "fourteen
 * independent free-text fields"; §23's column list defines thirteen. The list
 * follows the columns, because inventing a fourteenth field to make a sentence
 * true is the wrong correction — and the count matters only as the argument for
 * merging per field, which thirteen makes exactly as well.
 */
export const DIARY_NARRATIVE_FIELDS = [
  'workCompleted',
  'areasCompleted',
  'activities',
  'delays',
  'clientInstructions',
  'issues',
  'deliveries',
  'collections',
  'vehicleMovements',
  'wasteMovements',
  'hsNotes',
  'weather',
  'notes',
] as const;
export type DiaryNarrativeField = (typeof DIARY_NARRATIVE_FIELDS)[number];

/** What each is called on a screen, in an export column and in a history panel. */
export const DIARY_FIELD_LABELS: Readonly<Record<DiaryNarrativeField, string>> = {
  workCompleted: 'Work completed',
  areasCompleted: 'Areas completed',
  activities: 'Activities',
  delays: 'Delays',
  clientInstructions: 'Client instructions',
  issues: 'Issues',
  deliveries: 'Deliveries',
  collections: 'Collections',
  vehicleMovements: 'Vehicle movements',
  wasteMovements: 'Waste movements',
  hsNotes: 'Health & safety',
  weather: 'Weather',
  notes: 'Notes',
};

export const DIARY_STATUSES = ['OPEN', 'CLOSED'] as const;
export const diaryStatusSchema = z.enum(DIARY_STATUSES);
export type DiaryStatus = z.infer<typeof diaryStatusSchema>;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
/** `HH:MM`, which is what a time input produces and what a diary needs. */
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

// ── The record ───────────────────────────────────────────────────────────────

export const diaryAttendanceViewSchema = z.object({
  id: z.string().uuid(),
  diaryEntryId: z.string().uuid(),
  /** An employee, when the platform knows them. */
  userId: z.string().uuid().nullable(),
  /** A subcontractor's crew, counted as a crew rather than named person by person. */
  providerCompanyId: z.string().uuid().nullable(),
  /**
   * Free text when neither is known, and resolved from the user when one is.
   *
   * A person who has since closed their account resolves to their tombstoned
   * identity rather than disappearing from the day they worked — which is the
   * closure promise of 2026-08-20 read from the other end.
   */
  name: z.string().nullable(),
  roleId: z.string().uuid().nullable(),
  roleName: z.string().nullable(),
  headcount: z.number(),
  hours: z.number().nullable(),
  /** The timesheet row this line came from, when it was prefilled rather than typed. */
  timeLogId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type DiaryAttendanceView = z.infer<typeof diaryAttendanceViewSchema>;

export const diaryEntryViewSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  /** The **authoring** company. Two companies on one site keep two diaries. */
  companyId: z.string().uuid(),
  companyName: z.string().nullable(),
  entryDate: z.string(),

  startTime: z.string().nullable(),
  finishTime: z.string().nullable(),
  supervisorUserId: z.string().uuid().nullable(),

  workCompleted: z.string().nullable(),
  areasCompleted: z.string().nullable(),
  activities: z.string().nullable(),
  delays: z.string().nullable(),
  clientInstructions: z.string().nullable(),
  issues: z.string().nullable(),
  deliveries: z.string().nullable(),
  collections: z.string().nullable(),
  vehicleMovements: z.string().nullable(),
  wasteMovements: z.string().nullable(),
  hsNotes: z.string().nullable(),
  weather: z.string().nullable(),
  notes: z.string().nullable(),

  status: diaryStatusSchema,
  closedByUserId: z.string().uuid().nullable(),
  closedByName: z.string().nullable(),
  closedAt: z.string().nullable(),

  attendance: z.array(diaryAttendanceViewSchema),
  locationIds: z.array(z.string().uuid()),
  documentIds: z.array(z.string().uuid()),
  evidenceCount: z.number().int(),

  /**
   * §23's two counters, **derived rather than stored**.
   *
   * The plan has them as columns "denormalized from attendance for quick
   * display". They are the same shape as the `superseded` boolean 0031 refused —
   * two answers to one question — and they disagree the first time an attendance
   * row is corrected on a closed day, which is precisely the day somebody is
   * reading them for evidence.
   */
  workersPresentCount: z.number(),
  subcontractorsPresentCount: z.number(),

  /**
   * How many times this closed day has been changed since, and the number a
   * screen renders as "amended 2 times — view history".
   *
   * `max(revision)` over `record_revisions` for this entry. Zero for a day that
   * has never been amended, including every `OPEN` one — edits while open are
   * ordinary work, not corrections to a record anybody has relied on.
   */
  amendedTimes: z.number().int().min(0),

  createdByUserId: z.string().uuid().nullable(),
  updatedByUserId: z.string().uuid().nullable(),
  /** The sync contract's expected version (0029). There is no `deletedAt`: see below. */
  revision: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DiaryEntryView = z.infer<typeof diaryEntryViewSchema>;

// ── Writing ──────────────────────────────────────────────────────────────────

const narrativeShape = Object.fromEntries(
  DIARY_NARRATIVE_FIELDS.map((field) => [field, z.string().trim().max(8000).nullable()])
) as Record<DiaryNarrativeField, z.ZodNullable<z.ZodString>>;

const diaryBody = z.object({
  ...narrativeShape,
  startTime: timeOfDay.nullable(),
  finishTime: timeOfDay.nullable(),
  supervisorUserId: z.string().uuid().nullable(),
  /**
   * Set replacement rather than add/remove, and only for these two.
   *
   * A day's locations and its cited documents are small sets a person edits as a
   * set — ticking Floor 3 and Floor 4 on the entry they are already looking at.
   * Attendance is not, which is why it has rows with their own ids: an attendance
   * line carries hours, a role and a link to a timesheet, and replacing the list
   * wholesale would re-mint ids that other records point at.
   */
  locationIds: z.array(z.string().uuid()).max(200),
  documentIds: z.array(z.string().uuid()).max(200),
});

export const createDiaryEntrySchema = diaryBody.partial().extend({
  entryDate: dateOnly,
  /** Idempotency key for a retry that could not tell whether it landed (item 7.7). */
  clientId: z.string().uuid().optional(),
});
export type CreateDiaryEntry = z.infer<typeof createDiaryEntrySchema>;

/**
 * An edit, `OPEN` or `CLOSED`.
 *
 * `.strict()` for the reason `updateDocumentSchema` is: the fields that are *not*
 * here are the design. `status` is not settable — closing is its own route with
 * its own capability, and a status somebody can PATCH is a day that can be closed
 * by anybody who can write to it. `closedAt` and `closedByUserId` are not here
 * either, for the same reason a receipt is not editable by whoever holds it.
 */
export const updateDiaryEntrySchema = diaryBody
  .partial()
  .extend({
    /** The revision this edit was composed against (item 7.7). Optional by design. */
    expectedRevision: z.number().int().min(1).optional(),
    /**
     * What the editor started from, for the per-field merge on the `OPEN` path.
     *
     * §8 reserves field-wise merging for the diary and refuses it everywhere
     * else, and a merge needs three sides: what I read, what I changed it to, and
     * what it says now. The first of those is the client's, because the client is
     * the only party that knows it — the server never stored a snapshot of an
     * open entry, and §36's revisions begin at the first *amendment*.
     *
     * Omitted, the edit takes the ordinary contract: matching revision applies,
     * stale revision refuses.
     */
    base: diaryBody.partial().optional(),
    /**
     * **Required on a closed day**, and the requirement is the point of the
     * amendment machinery rather than a field validation.
     */
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      Object.keys(v).some(
        (key) => key !== 'expectedRevision' && key !== 'base' && key !== 'reason'
      ),
    { message: 'Nothing to update' }
  );
export type UpdateDiaryEntry = z.infer<typeof updateDiaryEntrySchema>;

export const createDiaryAttendanceSchema = z
  .object({
    userId: z.string().uuid().nullable().optional(),
    providerCompanyId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(200).nullable().optional(),
    roleId: z.string().uuid().nullable().optional(),
    headcount: z.number().positive().max(9999).optional(),
    hours: z.number().min(0).max(24).nullable().optional(),
    timeLogId: z.string().uuid().nullable().optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
    clientId: z.string().uuid().optional(),
  })
  .refine((v) => Boolean(v.userId || v.providerCompanyId || v.name), {
    message: 'An attendance line has to name somebody: a person, a crew, or a name',
  });
export type CreateDiaryAttendance = z.infer<typeof createDiaryAttendanceSchema>;

export const updateDiaryAttendanceSchema = z
  .object({
    roleId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(200).nullable().optional(),
    headcount: z.number().positive().max(9999).optional(),
    hours: z.number().min(0).max(24).nullable().optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((key) => key !== 'reason'), {
    message: 'Nothing to update',
  });
export type UpdateDiaryAttendance = z.infer<typeof updateDiaryAttendanceSchema>;

export const closeDiaryEntrySchema = z.object({
  /** Optional and honest: the person may confirm times as part of closing. */
  startTime: timeOfDay.nullable().optional(),
  finishTime: timeOfDay.nullable().optional(),
  expectedRevision: z.number().int().min(1).optional(),
  clientId: z.string().uuid().optional(),
});
export type CloseDiaryEntry = z.infer<typeof closeDiaryEntrySchema>;

export const diaryFilterSchema = z.object({
  /** Inclusive, against `entry_date` — the project day, not the day a row was written. */
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  /** One company's diary out of the two or more a project may carry. */
  companyId: z.string().uuid().optional(),
  status: diaryStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});
export type DiaryFilter = z.infer<typeof diaryFilterSchema>;

/** A day that finishes before it starts is a typo, not a shift. */
export function refuseDiaryTimes(args: {
  startTime?: string | null;
  finishTime?: string | null;
}): string | null {
  if (args.startTime && args.finishTime && args.finishTime < args.startTime) {
    return 'That day finishes before it starts';
  }
  return null;
}

/**
 * A diary entry cannot be written for a day that has not happened.
 *
 * **`today` is the project owner's**, resolved in Postgres from their IANA zone,
 * for the reason `documents.ts` gives about expiry: a subcontractor in Manila and
 * a hiring company in London must not disagree about which days exist. A
 * tolerance of one day is deliberate — a night shift finishing at 02:00 is
 * written up as the day it started, and the person writing it may be on the other
 * side of the date line from the project.
 */
export function refuseFutureEntryDate(entryDate: string, today: string): string | null {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const ahead =
    (Date.parse(`${entryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_DAY;
  if (ahead > 1) return 'A diary entry cannot be written for a day that has not happened yet';
  return null;
}

// ── Closing, and amending what was closed ────────────────────────────────────

export interface DiaryWriteRefusal {
  code: 'ALREADY_CLOSED' | 'REASON_REQUIRED';
  message: string;
}

/**
 * May this change be made, given the day's state and whether a reason came with
 * it?
 *
 * **The capability half is the route's**, not this function's: §37's rule is that
 * a capability never widens scope and is checked beside `policies.ts` rather than
 * inside a policy helper. What is decided here is the part that is a property of
 * the *record* — a closed day needs a reason, an open one does not.
 *
 * `REASON_REQUIRED` is a 422 rather than a 403 on purpose. The caller is allowed
 * to make this change; they have not yet said why, and the recovery is a sentence
 * rather than a permission.
 */
export function refuseDiaryEdit(args: {
  status: DiaryStatus;
  reason?: string | null;
}): DiaryWriteRefusal | null {
  if (args.status === 'CLOSED' && !args.reason?.trim()) {
    return {
      code: 'REASON_REQUIRED',
      message:
        'This day is closed. Changing it is an amendment, and an amendment needs a reason.',
    };
  }
  return null;
}

/**
 * The sentence the loser of a close race is shown (packet §9).
 *
 * Composed from resolved facts — a name and a time — rather than from anything
 * the customer typed, and it ends in the offer rather than the refusal: the
 * person's notes are not lost, they are an amendment away from landing.
 */
export function describeCloseRace(args: {
  closedByName: string | null;
  closedAt: string;
  zone?: string;
}): string {
  const who = args.closedByName ?? 'Somebody else';
  const at = new Date(args.closedAt);
  const time = Number.isNaN(at.getTime())
    ? ''
    : ` at ${at.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: args.zone ?? 'UTC',
      })}`;
  return `${who} closed this day${time}. Amend it with a reason?`;
}

/** "amended 3 times", "amended 1 time", or nothing at all. §23 renders it everywhere. */
export function describeAmendments(count: number): string | null {
  if (count <= 0) return null;
  return `amended ${count} ${count === 1 ? 'time' : 'times'}`;
}

/** "Tuesday 3 March" — how §6's Action Centre item names a day. */
export function describeDiaryDay(entryDate: string): string {
  const parsed = new Date(`${entryDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return entryDate;
  return parsed.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

// ── The per-field merge ──────────────────────────────────────────────────────

export interface DiaryMergeOutcome {
  merged: Partial<Record<DiaryNarrativeField, string | null>>;
  applied: DiaryNarrativeField[];
  conflicted: Array<{
    field: DiaryNarrativeField;
    label: string;
    mine: string | null;
    theirs: string | null;
  }>;
}

/**
 * Merge an edit into an entry that moved underneath it, field by field (§8).
 *
 * **Narrative fields only, and everything else is left to the ordinary
 * contract.** Two people who disagree about the start time have one number and
 * one of them is wrong; two people who wrote different paragraphs into `delays`
 * and `deliveries` have both written something true. Merging a time would be
 * inventing an answer; merging paragraphs is refusing to throw one away.
 *
 * **All or nothing when anything conflicts, and this is the part that was decided
 * rather than assumed.** Applying the clean fields and reporting the contested
 * one is tempting — the failure matrix's "a partial batch must never lose the
 * files that worked" points that way — but a 409 that has already written is a
 * status code that lies, and a 200 carrying a `conflicted` array is a discard
 * waiting for the first client that does not read it. Nothing is lost either way:
 * §8's queued item stays on the device with its reason, so refusing the whole
 * patch costs one round trip and keeps the response honest.
 *
 * What the merge actually buys is the *other* case, and it is the common one: an
 * edit composed against a stale revision that touches nothing anybody else
 * touched now applies silently, where whole-row optimistic concurrency would have
 * raised a conflict prompt about a change nobody made.
 */
export function mergeDiaryEdit(args: {
  base: Partial<Record<DiaryNarrativeField, string | null>>;
  incoming: Partial<Record<DiaryNarrativeField, string | null>>;
  current: Record<DiaryNarrativeField, string | null>;
}): DiaryMergeOutcome {
  const narrativeOnly: Partial<Record<DiaryNarrativeField, string | null>> = {};
  for (const field of DIARY_NARRATIVE_FIELDS) {
    if (field in args.incoming) narrativeOnly[field] = args.incoming[field] ?? null;
  }

  const result: FieldMergeResult<Record<DiaryNarrativeField, string | null>> = mergeFieldwise({
    // A field the editor never read is a field it cannot claim to have merged, so
    // an absent `base` entry reads as null — the value an unwritten field holds.
    base: Object.fromEntries(
      DIARY_NARRATIVE_FIELDS.map((f) => [f, args.base[f] ?? null])
    ) as Record<DiaryNarrativeField, string | null>,
    incoming: narrativeOnly,
    current: args.current,
  });

  return {
    merged: result.merged,
    applied: result.applied as DiaryNarrativeField[],
    conflicted: (result.conflicted as DiaryNarrativeField[]).map((field) => ({
      field,
      label: DIARY_FIELD_LABELS[field],
      mine: narrativeOnly[field] ?? null,
      theirs: args.current[field],
    })),
  };
}

// ── Attendance arithmetic ────────────────────────────────────────────────────

export interface AttendanceTotals {
  workersPresentCount: number;
  subcontractorsPresentCount: number;
}

/**
 * §23's two counters, computed from the rows rather than read from a column.
 *
 * **The split is by `providerCompanyId`, not by whether a `userId` is known.** A
 * line is somebody else's crew exactly when it names another company; the
 * authoring company's own people are its employees whether the platform holds a
 * user account for them or somebody typed a name. Splitting on `userId` instead
 * would file every agency labourer written in by hand as a subcontractor, which
 * is the number a hiring company reads to know who was actually on their site.
 *
 * Summed by `headcount` rather than counted by row, because one line reading
 * "Ade Fitouts — 6" is six people.
 */
export function attendanceTotals(
  rows: readonly { providerCompanyId: string | null; headcount: number }[]
): AttendanceTotals {
  let workers = 0;
  let subcontractors = 0;
  for (const row of rows) {
    if (row.providerCompanyId === null) workers += row.headcount;
    else subcontractors += row.headcount;
  }
  // Two decimals, because `headcount numeric(6,2)` allows a half day and floating
  // point addition of halves and thirds does not stay tidy on its own.
  return {
    workersPresentCount: Math.round(workers * 100) / 100,
    subcontractorsPresentCount: Math.round(subcontractors * 100) / 100,
  };
}

/**
 * Attendance suggested from the day's timesheets (§23's prefill).
 *
 * **Suggested, never written.** §23 says the supervisor *confirms* rather than
 * retypes, and the difference is the whole value: a diary that filled itself in
 * from the timesheets would agree with them by construction and prove nothing.
 * What the hiring company gets from a confirmed line is a second, independent
 * assertion that the person was there.
 *
 * §31's schedule is the other source the plan names, and it is **Phase 11**. The
 * shape below takes rows from anywhere, so the schedule joins this list without
 * changing a caller — but nothing here pretends to read a table that does not
 * exist yet.
 */
export interface AttendanceSuggestion {
  userId: string | null;
  providerCompanyId: string | null;
  name: string | null;
  roleId: string | null;
  roleName: string | null;
  headcount: number;
  hours: number | null;
  timeLogId: string | null;
  /** Why this line is being offered, so a screen can say where it came from. */
  source: 'TIME_LOG';
  /** Whether the day already carries this line, so a re-open does not re-offer it. */
  alreadyPresent: boolean;
}

export function suggestAttendance(args: {
  timeLogs: readonly {
    id: string;
    userId: string | null;
    userName: string | null;
    providerCompanyId: string | null;
    roleId: string | null;
    roleName: string | null;
    hours: number;
  }[];
  existingTimeLogIds: readonly string[];
  /** The diary's own company: its people are workers, everybody else is a crew. */
  authoringCompanyId: string;
}): AttendanceSuggestion[] {
  const already = new Set(args.existingTimeLogIds);
  return args.timeLogs.map((log) => ({
    userId: log.userId,
    providerCompanyId:
      log.providerCompanyId === args.authoringCompanyId ? null : log.providerCompanyId,
    name: log.userName,
    roleId: log.roleId,
    roleName: log.roleName,
    headcount: 1,
    hours: log.hours,
    timeLogId: log.id,
    source: 'TIME_LOG',
    alreadyPresent: already.has(log.id),
  }));
}

// ── Close Day ────────────────────────────────────────────────────────────────

export const CLOSE_DAY_PROMPT_CODES = [
  'NO_ATTENDANCE',
  'NO_NARRATIVE',
  'NO_EVIDENCE',
  'UNSUBMITTED_TIME',
  'NO_TIMES',
] as const;
export type CloseDayPromptCode = (typeof CLOSE_DAY_PROMPT_CODES)[number];

export interface CloseDayPrompt {
  code: CloseDayPromptCode;
  message: string;
}

/**
 * What Close Day asks about before it closes (§32's "prompts for anything
 * obviously missing").
 *
 * **Prompts, never gates, and the distinction is the design.** A close that
 * refuses until a photograph exists is a close that teaches somebody to
 * photograph the floor twice — and the day still ends at 17:00 whether or not the
 * product approves of how it was recorded. So these are returned with the entry
 * and again in the close response, and the close proceeds.
 *
 * **Assets with no destination is §32's third prompt and is deliberately absent.**
 * `project_assets` is Phase 8. A prompt that always says "no assets" on a product
 * that cannot record assets yet is noise that trains people to dismiss the whole
 * list, including the two prompts that mean something.
 */
export function closeDayPrompts(facts: {
  attendanceRows: number;
  narrativeFieldsFilled: number;
  evidenceCount: number;
  unsubmittedTimeLogs: number;
  startTime: string | null;
  finishTime: string | null;
}): CloseDayPrompt[] {
  const prompts: CloseDayPrompt[] = [];
  if (facts.attendanceRows === 0) {
    prompts.push({
      code: 'NO_ATTENDANCE',
      message: 'Nobody is recorded as being on site today.',
    });
  }
  if (facts.narrativeFieldsFilled === 0) {
    prompts.push({
      code: 'NO_NARRATIVE',
      message: 'Nothing is written up for today — not even what was completed.',
    });
  }
  if (facts.evidenceCount === 0) {
    prompts.push({ code: 'NO_EVIDENCE', message: 'No photos are attached to today.' });
  }
  if (facts.unsubmittedTimeLogs > 0) {
    prompts.push({
      code: 'UNSUBMITTED_TIME',
      message:
        facts.unsubmittedTimeLogs === 1
          ? '1 time log for today is still a draft and has not been submitted.'
          : `${facts.unsubmittedTimeLogs} time logs for today are still drafts and have not been submitted.`,
    });
  }
  if (facts.startTime === null || facts.finishTime === null) {
    prompts.push({ code: 'NO_TIMES', message: 'The start and finish times are not both set.' });
  }
  return prompts;
}

/** How many of the thirteen narrative fields actually carry something. */
export function narrativeFieldsFilled(
  entry: Partial<Record<DiaryNarrativeField, string | null>>
): number {
  return DIARY_NARRATIVE_FIELDS.filter((field) => (entry[field] ?? '').trim().length > 0).length;
}

// ── Events ───────────────────────────────────────────────────────────────────

/**
 * `diary.closed` — §5's payload, built by allowlist like every other in this
 * phase.
 *
 * The **attendance totals** are in it and the attendance *names* are not. §11
 * excludes the names explicitly, and the totals are what the metric on the same
 * line of §11 — days closed ÷ days with any activity — is computed beside.
 */
export function diaryClosedEventPayload(args: {
  diaryEntryId: string;
  projectId: string;
  ownerCompanyId: string;
  authorCompanyId: string;
  entryDate: string;
  actorUserId: string;
  supervisorUserId: string | null;
  workersPresentCount: number;
  subcontractorsPresentCount: number;
}): Record<string, string | number | null> {
  return {
    diaryEntryId: args.diaryEntryId,
    projectId: args.projectId,
    ownerCompanyId: args.ownerCompanyId,
    authorCompanyId: args.authorCompanyId,
    entryDate: args.entryDate,
    actorUserId: args.actorUserId,
    supervisorUserId: args.supervisorUserId,
    workersPresentCount: args.workersPresentCount,
    subcontractorsPresentCount: args.subcontractorsPresentCount,
  };
}

/**
 * `diary.amended` — the one payload in Phase 7 that carries customer prose, and
 * it is a deliberate, single exception rather than a slip.
 *
 * §11's exclusion list is about the *content* of the record: the thirteen
 * narrative fields, captions, attendance names, filenames. Those stay out — this
 * payload carries the **names** of the changed fields and never their values, and
 * the before/after live in `record_revisions` behind the same authorization as
 * the entry.
 *
 * The `reason` is different in kind and §5 puts it here by name. It is not a fact
 * about the site; it is the sentence that makes the amendment legible to somebody
 * who relied on the closed day — and §6 writes it into the Action Centre item
 * verbatim: *"Tuesday 3 March amended — reason: …"*. An amendment notice that
 * cannot say why is a notice that has to be clicked to be useful, which for the
 * one event in this domain that is never digested defeats the point of not
 * digesting it.
 */
export function diaryAmendedEventPayload(args: {
  diaryEntryId: string;
  projectId: string;
  ownerCompanyId: string;
  authorCompanyId: string;
  entryDate: string;
  actorUserId: string;
  revision: number;
  changedFields: readonly string[];
  reason: string;
}): Record<string, string | number | string[]> {
  return {
    diaryEntryId: args.diaryEntryId,
    projectId: args.projectId,
    ownerCompanyId: args.ownerCompanyId,
    authorCompanyId: args.authorCompanyId,
    entryDate: args.entryDate,
    actorUserId: args.actorUserId,
    revision: args.revision,
    changedFields: [...args.changedFields],
    reason: args.reason,
  };
}
