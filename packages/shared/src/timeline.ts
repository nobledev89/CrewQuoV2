import { z } from 'zod';

/**
 * The project timeline (CREWQUO_V2_PLAN.md §35) — step 11.0 of the Phase 11 build
 * order in `docs/operating-model/commercial-operations.md` §14.
 *
 * §35 in one sentence: *"An automatic chronology assembled from records that
 * already exist — no new writes, one read model."* So there is no table in this
 * phase for it, no event log, and nothing to keep in step: the timeline is a
 * `union all` over the tables that already hold the facts, ordered by event time
 * and keyset-paginated like every other list.
 *
 * ── THE REGISTRY, AND THE TWO KINDS §35 NAMES THAT HAVE NO SOURCE ───────────
 *
 * Packet finding 10. §35 lists thirteen kinds of thing. Eleven have a table with a
 * real timestamp. Two do not, and both are declared here with the honest value
 * rather than quietly dropped — which is the treatment `REPORT_SECTIONS` gave
 * `PACK_INCIDENTS`, for the same reason: the next reader of §35 will come looking
 * for exactly these two lines.
 *
 *  - **`INCIDENT` has no table anywhere in the plan's DDL** — not §3, not §25, not
 *    §30 through §35. `sourceTable: null` says so.
 *  - **`PROJECT_COMPLETED` has no timestamp.** `projects` carries a `status` and no
 *    `completed_at`, so the instant a project was completed is not a fact this
 *    schema holds. It is reported from the client sign-off instead — the record
 *    that actually attests completion, with a server-clock `signed_at` — and where
 *    there is no sign-off the timeline says nothing rather than inventing a date
 *    from `updated_at`, which is the timestamp of the most recent edit to anything.
 */

export const TIMELINE_EVENT_TYPES = [
  'PROJECT_CREATED',
  'CREW_ASSIGNED',
  'SCHEDULE_ASSIGNED',
  'TIME_LOGGED',
  'WORK_APPROVED',
  'EXPENSE_APPROVED',
  'DIARY_ENTRY',
  'EVIDENCE_UPLOADED',
  'ASSET_RECORDED',
  'ASSET_MOVED',
  'ACTIVITY_RECORDED',
  'DOCUMENT_UPLOADED',
  'VARIATION_RAISED',
  'VARIATION_DECIDED',
  'REPORT_GENERATED',
  'CLIENT_SIGNOFF',
  'INCIDENT',
  'PROJECT_COMPLETED',
] as const;
export const timelineEventTypeSchema = z.enum(TIMELINE_EVENT_TYPES);
export type TimelineEventType = z.infer<typeof timelineEventTypeSchema>;

export interface TimelineSourceSpec {
  type: TimelineEventType;
  label: string;
  /**
   * The table the events come from. **`null` means no table for this exists
   * anywhere in the plan**, which is a stronger statement than "later" — see the
   * header on `INCIDENT`.
   */
  sourceTable: string | null;
  /**
   * The feature key that governs reading this class, or `null` where the records
   * are ungated. Checked per source inside the union, which is why the timeline
   * itself needs no feature key (packet §13.7): a company without `site_diary`
   * still has time logs and photographs, and there is no single key the union
   * could honestly be gated on.
   */
  feature:
    | 'project_evidence'
    | 'project_documents'
    | 'site_diary'
    | 'asset_tracking'
    | 'sustainability'
    | 'sustainability_reports'
    | 'client_signoff'
    | 'variations'
    | 'scheduling'
    | null;
  /**
   * Can this class ever appear in the **client** variant?
   *
   * A flag rather than a filter applied later, and the reason is
   * `reporting-signoff.md` finding 3's: an exclusion that lives in a `where`
   * clause is an exclusion a later edit forgets. The client union is assembled from
   * the sources whose flag is true, so a schedule row and a budget have no code
   * path into it at all — and adding one would mean editing this line, where the
   * reason is written down.
   *
   * `SOME` means the class crosses only where the individual record was
   * deliberately published (an evidence row's `client_visible`, a report's
   * `audience`), which is checked in the source's own clause.
   */
  clientVisibility: 'NEVER' | 'SOME' | 'ALWAYS';
}

export const TIMELINE_SOURCES: readonly TimelineSourceSpec[] = [
  { type: 'PROJECT_CREATED', label: 'Project created', sourceTable: 'projects', feature: null, clientVisibility: 'ALWAYS' },
  /*
   * Two kinds of assignment, and they are genuinely different records rather than a
   * naming accident. `project_assignments` (Phase 3) says *this company is on this
   * job*; `schedule_assignments` (§31) says *these people and this van, on these
   * hours*. The first is commercial structure the client can see; the second is the
   * shape of the contractor's operation and never crosses (packet §4).
   */
  { type: 'CREW_ASSIGNED', label: 'Subcontractor assigned', sourceTable: 'project_assignments', feature: null, clientVisibility: 'ALWAYS' },
  { type: 'SCHEDULE_ASSIGNED', label: 'Crew scheduled', sourceTable: 'schedule_assignments', feature: 'scheduling', clientVisibility: 'NEVER' },
  /*
   * §35 says "time entries" and this is the one class where that phrase needed a
   * decision. A DRAFT timesheet is somebody's unfinished thought; the timeline
   * carries **submitted and later**, because the chronology is meant to be read by
   * "someone who was not on site", and a draft is not yet an assertion that
   * anything happened.
   */
  { type: 'TIME_LOGGED', label: 'Time recorded', sourceTable: 'time_logs', feature: null, clientVisibility: 'NEVER' },
  // §35's "approvals", which have a real timestamp: `reviewed_at`.
  { type: 'WORK_APPROVED', label: 'Time approved', sourceTable: 'time_logs', feature: null, clientVisibility: 'ALWAYS' },
  { type: 'EXPENSE_APPROVED', label: 'Expense approved', sourceTable: 'expenses', feature: null, clientVisibility: 'NEVER' },
  { type: 'DIARY_ENTRY', label: 'Site diary', sourceTable: 'site_diary_entries', feature: 'site_diary', clientVisibility: 'NEVER' },
  { type: 'EVIDENCE_UPLOADED', label: 'Photographs & evidence', sourceTable: 'project_evidence', feature: 'project_evidence', clientVisibility: 'SOME' },
  { type: 'ASSET_RECORDED', label: 'Assets recorded', sourceTable: 'project_assets', feature: 'asset_tracking', clientVisibility: 'ALWAYS' },
  // §35 lists "asset movements" and "waste records" separately; they are one table,
  // and which one a row is depends on its destination type. One source, and the
  // description names the destination — two types would double-count every skip.
  { type: 'ASSET_MOVED', label: 'Material moved', sourceTable: 'asset_movements', feature: 'asset_tracking', clientVisibility: 'ALWAYS' },
  { type: 'ACTIVITY_RECORDED', label: 'Fuel, transport & energy', sourceTable: 'project_activities', feature: 'sustainability', clientVisibility: 'NEVER' },
  { type: 'DOCUMENT_UPLOADED', label: 'Documents', sourceTable: 'project_documents', feature: 'project_documents', clientVisibility: 'SOME' },
  { type: 'VARIATION_RAISED', label: 'Variation raised', sourceTable: 'variations', feature: 'variations', clientVisibility: 'NEVER' },
  // The decision crosses and the raising does not, which is packet §13.6: a price
  // the contractor is still thinking about is not a disclosure, and an approved
  // variation is money the client agreed to pay.
  { type: 'VARIATION_DECIDED', label: 'Variation decided', sourceTable: 'variations', feature: 'variations', clientVisibility: 'SOME' },
  { type: 'REPORT_GENERATED', label: 'Report generated', sourceTable: 'generated_reports', feature: 'sustainability_reports', clientVisibility: 'SOME' },
  { type: 'CLIENT_SIGNOFF', label: 'Client sign-off', sourceTable: 'client_signoffs', feature: 'client_signoff', clientVisibility: 'ALWAYS' },
  /*
   * Packet finding 10, both halves.
   *
   * `INCIDENT` — no table anywhere in the plan's DDL. `null` rather than a guessed
   * phase number, exactly as `PACK_INCIDENTS` carries `availableFrom: null`.
   *
   * `PROJECT_COMPLETED` — reported from `client_signoffs`, because `projects` has a
   * status and no `completed_at` and the instant of completion is not a fact this
   * schema holds. Listed as its own type rather than folded into CLIENT_SIGNOFF so
   * a reader filtering for "when did this finish" finds something.
   */
  { type: 'INCIDENT', label: 'Incidents', sourceTable: null, feature: null, clientVisibility: 'ALWAYS' },
  { type: 'PROJECT_COMPLETED', label: 'Project completed', sourceTable: 'client_signoffs', feature: 'client_signoff', clientVisibility: 'ALWAYS' },
];

/** The types a given audience may ever see. */
export function timelineTypesFor(audience: 'INTERNAL' | 'CLIENT'): TimelineEventType[] {
  return TIMELINE_SOURCES.filter(
    (s) => s.sourceTable !== null && (audience === 'INTERNAL' || s.clientVisibility !== 'NEVER')
  ).map((s) => s.type);
}

/** The types with no source in this build, so a client can say why a filter is empty. */
export function timelineTypesWithoutSource(): TimelineEventType[] {
  return TIMELINE_SOURCES.filter((s) => s.sourceTable === null).map((s) => s.type);
}

// ── Items ────────────────────────────────────────────────────────────────────

export interface TimelineItem {
  /**
   * `<type>:<row id>`, so an item is addressable and a client can deduplicate
   * across pages. Not a uuid: two types read the same table (`time_logs` appears as
   * both `TIME_LOGGED` and `WORK_APPROVED`), so a row id alone is not unique in this
   * stream.
   */
  id: string;
  type: TimelineEventType;
  /** The instant the thing happened, which is not always `created_at`. */
  at: string;
  /** Who did it, resolved through `users` so a closed account reads as its tombstone. */
  actorUserId: string | null;
  actorName: string | null;
  /** The company whose act it was — a subcontractor's photograph is theirs. */
  companyId: string | null;
  companyName: string | null;
  /** One line, server-rendered so every client says it identically. */
  description: string;
  /** The record, for a link. */
  entityType: string;
  entityId: string;
  /** In-app path to the record, or null where the record has no screen of its own. */
  href: string | null;
}

export interface TimelineResponse {
  items: TimelineItem[];
  /** Keyset cursor — opaque, `<iso>|<id>`. Null when the page is the last one. */
  nextCursor: string | null;
  /**
   * Which sources actually contributed, and which were skipped and why.
   *
   * §9's skip rule made visible: a union over ten tables in a codebase where
   * migrations arrive one phase at a time will eventually name a table that is not
   * there, and a timeline that 500s because a later phase has not shipped is a
   * worse failure than the one the registry prevents. So absent tables are omitted
   * and **said out loud** — the same choice `DiaryPrefillResponse.sources` made
   * rather than returning a shorter list somebody has to interpret.
   */
  sources: {
    type: TimelineEventType;
    included: boolean;
    reason: 'OK' | 'NO_TABLE' | 'NO_FEATURE' | 'NOT_FOR_THIS_AUDIENCE' | 'FILTERED_OUT';
  }[];
}

export const timelineQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  types: z.array(timelineEventTypeSchema).max(TIMELINE_EVENT_TYPES.length).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

/** Encode / decode the keyset cursor. Ordering is `at desc, id desc`. */
export function encodeTimelineCursor(item: { at: string; id: string }): string {
  return `${item.at}|${item.id}`;
}

export function decodeTimelineCursor(cursor: string): { at: string; id: string } | null {
  const bar = cursor.indexOf('|');
  if (bar <= 0) return null;
  const at = cursor.slice(0, bar);
  const id = cursor.slice(bar + 1);
  if (id === '' || Number.isNaN(Date.parse(at))) return null;
  return { at, id };
}
