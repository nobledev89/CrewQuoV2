import type {
  DiaryAttendanceView,
  DiaryEntryView,
  DiaryFilter,
  DiaryNarrativeField,
  DiaryStatus,
} from '@crewquo/shared';
import { DIARY_NARRATIVE_FIELDS, attendanceTotals } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * Reads and writes for `site_diary_entries` and its three children (0032).
 *
 * Four things are derived on read rather than stored, and each of them is a
 * column §23 proposed and this module refused: the two attendance counters, the
 * amendment count, and the project owner's `today`. The migration argues each
 * one; this is where they are paid for.
 */

export const DIARY_REVISION_ENTITY = 'site_diary_entry';

export interface DiaryEntryRow {
  id: string;
  project_id: string;
  company_id: string;
  company_name: string | null;
  entry_date: string;
  start_time: string | null;
  finish_time: string | null;
  supervisor_user_id: string | null;
  work_completed: string | null;
  areas_completed: string | null;
  activities: string | null;
  delays: string | null;
  client_instructions: string | null;
  issues: string | null;
  deliveries: string | null;
  collections: string | null;
  vehicle_movements: string | null;
  waste_movements: string | null;
  hs_notes: string | null;
  weather: string | null;
  notes: string | null;
  status: DiaryStatus;
  closed_by_user_id: string | null;
  closed_by_name: string | null;
  closed_at: Date | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
  /** The project-OWNING company's current date, resolved in Postgres from its zone. */
  today: string;
  /** The owning company's IANA zone, so a close-race message can name a local time. */
  owner_time_zone: string;
  owner_company_id: string;
}

/**
 * `start_time` and `finish_time` come back as `HH:MM`, not `HH:MM:SS`.
 *
 * Postgres renders `time` with seconds; a browser time input neither sends nor
 * accepts them. Trimmed here rather than in the client, because the export, the
 * report and the screen all read this projection and three trimmings are three
 * chances for one of them to render `08:00:00` in a PDF.
 */
const FIELDS = `
  d.id, d.project_id, d.company_id, ac.name as company_name,
  to_char(d.entry_date, 'YYYY-MM-DD') as entry_date,
  to_char(d.start_time, 'HH24:MI') as start_time,
  to_char(d.finish_time, 'HH24:MI') as finish_time,
  d.supervisor_user_id,
  d.work_completed, d.areas_completed, d.activities, d.delays,
  d.client_instructions, d.issues, d.deliveries, d.collections,
  d.vehicle_movements, d.waste_movements, d.hs_notes, d.weather, d.notes,
  d.status, d.closed_by_user_id, cu.name as closed_by_name, d.closed_at,
  d.created_by_user_id, d.updated_by_user_id,
  d.revision, d.created_at, d.updated_at,
  p.owner_company_id,
  coalesce(oc.time_zone, 'UTC') as owner_time_zone,
  to_char((now() at time zone coalesce(oc.time_zone, 'UTC'))::date, 'YYYY-MM-DD') as today`;

/**
 * `oc` is the **project-owning** company, not the authoring one.
 *
 * The same choice `documents/repo.ts` makes about expiry, for the same reason: a
 * subcontractor in Manila and a hiring company in London must not disagree about
 * which day it is on a site that has exactly one. The project belongs to its
 * owner, so the project's owner owns its calendar — and `entry_date` is the one
 * column in this table whose meaning depends on that answer.
 */
const JOINS = `
  join projects p on p.id = d.project_id
  join companies oc on oc.id = p.owner_company_id
  join companies ac on ac.id = d.company_id
  left join users cu on cu.id = d.closed_by_user_id`;

const SELECT = `select ${FIELDS} from site_diary_entries d ${JOINS}`;

function selectFromCte(cte: string): string {
  return `select ${FIELDS} from ${cte} d ${JOINS}`;
}

/** The narrative columns, paired with the view's field names in one place. */
const NARRATIVE_COLUMNS: Readonly<Record<DiaryNarrativeField, string>> = {
  workCompleted: 'work_completed',
  areasCompleted: 'areas_completed',
  activities: 'activities',
  delays: 'delays',
  clientInstructions: 'client_instructions',
  issues: 'issues',
  deliveries: 'deliveries',
  collections: 'collections',
  vehicleMovements: 'vehicle_movements',
  wasteMovements: 'waste_movements',
  hsNotes: 'hs_notes',
  weather: 'weather',
  notes: 'notes',
};

/** The thirteen narrative values off a row, keyed the way the merge wants them. */
export function narrativeOf(row: DiaryEntryRow): Record<DiaryNarrativeField, string | null> {
  const out = {} as Record<DiaryNarrativeField, string | null>;
  for (const field of DIARY_NARRATIVE_FIELDS) {
    out[field] =
      (row as unknown as Record<string, string | null>)[NARRATIVE_COLUMNS[field]] ?? null;
  }
  return out;
}

// ── Hydration ────────────────────────────────────────────────────────────────

export interface DiaryChildren {
  attendance: Map<string, DiaryAttendanceView[]>;
  locationIds: Map<string, string[]>;
  documentIds: Map<string, string[]>;
  evidenceCounts: Map<string, number>;
  amendments: Map<string, number>;
}

/**
 * Everything hanging off a page of entries, in five queries rather than five per
 * entry.
 *
 * A month of diary is thirty rows and the naive version is a hundred and fifty
 * round trips — which is fine in a test with one entry and is the reason the
 * diary screen is the slow one in production. Batched by id from the start,
 * because this is the shape that is expensive to notice later.
 */
export async function loadDiaryChildren(
  entryIds: readonly string[],
  runner?: Queryable
): Promise<DiaryChildren> {
  const empty: DiaryChildren = {
    attendance: new Map(),
    locationIds: new Map(),
    documentIds: new Map(),
    evidenceCounts: new Map(),
    amendments: new Map(),
  };
  if (entryIds.length === 0) return empty;
  const ids = [...entryIds];

  const [attendanceRows, locationRows, documentRows, evidenceRows, amendmentRows] =
    await Promise.all([
      query<{
        id: string;
        diary_entry_id: string;
        user_id: string | null;
        provider_company_id: string | null;
        name: string | null;
        user_name: string | null;
        role_id: string | null;
        role_name: string | null;
        headcount: string;
        hours: string | null;
        time_log_id: string | null;
        created_at: Date;
      }>(
        `select a.id, a.diary_entry_id, a.user_id, a.provider_company_id, a.name,
                u.name as user_name, a.role_id, r.name as role_name,
                a.headcount, a.hours, a.time_log_id, a.created_at
           from site_diary_attendance a
           left join users u on u.id = a.user_id
           left join role_catalog r on r.id = a.role_id
          where a.diary_entry_id = any($1::uuid[])
          order by a.created_at asc, a.id asc`,
        [ids],
        runner
      ),
      query<{ diary_entry_id: string; location_id: string }>(
        `select diary_entry_id, location_id from site_diary_locations
          where diary_entry_id = any($1::uuid[])`,
        [ids],
        runner
      ),
      query<{ diary_entry_id: string; document_id: string }>(
        `select diary_entry_id, document_id from site_diary_documents
          where diary_entry_id = any($1::uuid[])`,
        [ids],
        runner
      ),
      query<{ diary_entry_id: string; n: number }>(
        `select diary_entry_id, count(*)::int as n from project_evidence
          where diary_entry_id = any($1::uuid[]) and deleted_at is null
          group by diary_entry_id`,
        [ids],
        runner
      ),
      /*
       * The amendment count, and it is `max(revision)` rather than `count(*)` on
       * purpose. `recordRevision` allocates `max + 1` per entity, so the two agree
       * — until a revision write fails, which §36 requires to be non-fatal ("a
       * broken trail must not fail an approval"). After that `count(*)` says two
       * and the numbers on the rows say 1 and 3. The highest number actually
       * written is the honest answer to "how many times has this changed", because
       * it is the one the history panel's own rows will show.
       */
      query<{ entity_id: string; n: number }>(
        `select entity_id, max(revision)::int as n from record_revisions
          where entity_type = $1 and entity_id = any($2::uuid[])
          group by entity_id`,
        [DIARY_REVISION_ENTITY, ids],
        runner
      ),
    ]);

  for (const row of attendanceRows) {
    const list = empty.attendance.get(row.diary_entry_id) ?? [];
    list.push({
      id: row.id,
      diaryEntryId: row.diary_entry_id,
      userId: row.user_id,
      providerCompanyId: row.provider_company_id,
      // The typed name wins where there is one, because somebody typed it about
      // this day; the user's name is the fallback, and after a closure it is the
      // tombstone — which is the promise of 2026-08-20 read from this end.
      name: row.name ?? row.user_name,
      roleId: row.role_id,
      roleName: row.role_name,
      headcount: Number(row.headcount),
      hours: row.hours === null ? null : Number(row.hours),
      timeLogId: row.time_log_id,
      createdAt: row.created_at.toISOString(),
    });
    empty.attendance.set(row.diary_entry_id, list);
  }
  for (const row of locationRows) {
    empty.locationIds.set(row.diary_entry_id, [
      ...(empty.locationIds.get(row.diary_entry_id) ?? []),
      row.location_id,
    ]);
  }
  for (const row of documentRows) {
    empty.documentIds.set(row.diary_entry_id, [
      ...(empty.documentIds.get(row.diary_entry_id) ?? []),
      row.document_id,
    ]);
  }
  for (const row of evidenceRows) empty.evidenceCounts.set(row.diary_entry_id, row.n);
  for (const row of amendmentRows) empty.amendments.set(row.entity_id, row.n);
  return empty;
}

export function toDiaryEntryView(row: DiaryEntryRow, children: DiaryChildren): DiaryEntryView {
  const attendance = children.attendance.get(row.id) ?? [];
  const totals = attendanceTotals(attendance);
  return {
    id: row.id,
    projectId: row.project_id,
    companyId: row.company_id,
    companyName: row.company_name,
    entryDate: row.entry_date,
    startTime: row.start_time,
    finishTime: row.finish_time,
    supervisorUserId: row.supervisor_user_id,
    workCompleted: row.work_completed,
    areasCompleted: row.areas_completed,
    activities: row.activities,
    delays: row.delays,
    clientInstructions: row.client_instructions,
    issues: row.issues,
    deliveries: row.deliveries,
    collections: row.collections,
    vehicleMovements: row.vehicle_movements,
    wasteMovements: row.waste_movements,
    hsNotes: row.hs_notes,
    weather: row.weather,
    notes: row.notes,
    status: row.status,
    closedByUserId: row.closed_by_user_id,
    closedByName: row.closed_by_name,
    closedAt: row.closed_at?.toISOString() ?? null,
    attendance,
    locationIds: children.locationIds.get(row.id) ?? [],
    documentIds: children.documentIds.get(row.id) ?? [],
    evidenceCount: children.evidenceCounts.get(row.id) ?? 0,
    workersPresentCount: totals.workersPresentCount,
    subcontractorsPresentCount: totals.subcontractorsPresentCount,
    amendedTimes: children.amendments.get(row.id) ?? 0,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** One row plus its children, for the routes that answer with a single entry. */
export async function viewOf(row: DiaryEntryRow, runner?: Queryable): Promise<DiaryEntryView> {
  return toDiaryEntryView(row, await loadDiaryChildren([row.id], runner));
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Whose diaries this caller may read.
 *
 * The project owner sees every company's; a provider sees only its own. §2 is
 * explicit that a subcontractor's diary is its own record and the owner sees both
 * — and equally explicit that the reverse is not true. A provider reading the
 * hiring company's written-up day would be reading a narrative about the whole
 * site, including the other trades on it.
 */
export type DiaryScope = { kind: 'OWNER' } | { kind: 'AUTHOR'; companyId: string };

export async function listDiaryEntries(
  projectId: string,
  scope: DiaryScope,
  filter: DiaryFilter,
  runner?: Queryable
): Promise<DiaryEntryRow[]> {
  const params: unknown[] = [projectId];
  let where = ' where d.project_id = $1';
  if (scope.kind === 'AUTHOR') {
    params.push(scope.companyId);
    where += ` and d.company_id = $${params.length}`;
  }
  if (filter.companyId) {
    params.push(filter.companyId);
    where += ` and d.company_id = $${params.length}`;
  }
  if (filter.status) {
    params.push(filter.status);
    where += ` and d.status = $${params.length}`;
  }
  if (filter.from) {
    params.push(filter.from);
    where += ` and d.entry_date >= $${params.length}::date`;
  }
  if (filter.to) {
    params.push(filter.to);
    where += ` and d.entry_date <= $${params.length}::date`;
  }
  params.push(filter.limit ?? 100);
  const limitParam = `$${params.length}`;
  params.push(filter.offset ?? 0);
  const offsetParam = `$${params.length}`;

  return query<DiaryEntryRow>(
    `${SELECT}${where}
      order by d.entry_date desc, ac.name asc
      limit ${limitParam} offset ${offsetParam}`,
    params,
    runner
  );
}

export function findDiaryEntry(id: string, runner?: Queryable): Promise<DiaryEntryRow | null> {
  return queryOne<DiaryEntryRow>(`${SELECT} where d.id = $1`, [id], runner);
}

/** The day this project, this company, this date — the natural key §23 defines. */
export function findDiaryEntryForDay(
  args: { projectId: string; companyId: string; entryDate: string },
  runner?: Queryable
): Promise<DiaryEntryRow | null> {
  return queryOne<DiaryEntryRow>(
    `${SELECT} where d.project_id = $1 and d.company_id = $2 and d.entry_date = $3::date`,
    [args.projectId, args.companyId, args.entryDate],
    runner
  );
}

/**
 * The owner's date and zone before any entry exists, so a create can refuse a
 * future day without first inserting one.
 */
export function projectClock(
  projectId: string,
  runner?: Queryable
): Promise<{ today: string; time_zone: string; owner_company_id: string } | null> {
  return queryOne(
    `select to_char((now() at time zone coalesce(oc.time_zone, 'UTC'))::date, 'YYYY-MM-DD') as today,
            coalesce(oc.time_zone, 'UTC') as time_zone,
            p.owner_company_id
       from projects p join companies oc on oc.id = p.owner_company_id
      where p.id = $1`,
    [projectId],
    runner
  );
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface DiaryPatch extends Partial<Record<DiaryNarrativeField, string | null>> {
  startTime?: string | null;
  finishTime?: string | null;
  supervisorUserId?: string | null;
}

const PATCH_COLUMNS: Record<string, { column: string; cast: string }> = {
  ...Object.fromEntries(
    DIARY_NARRATIVE_FIELDS.map((field) => [field, { column: NARRATIVE_COLUMNS[field], cast: '' }])
  ),
  startTime: { column: 'start_time', cast: '::time' },
  finishTime: { column: 'finish_time', cast: '::time' },
  supervisorUserId: { column: 'supervisor_user_id', cast: '::uuid' },
};

/**
 * Open a day.
 *
 * `on conflict do nothing` on the natural key rather than a prior select: two
 * devices opening today at the same moment is the ordinary case on a site with
 * two supervisors, and check-then-act has already been caught three times in this
 * phase. The loser gets no row and the caller re-reads the winner's — which is
 * what it wanted, since a diary day is a day rather than a document somebody
 * authored.
 */
export function insertDiaryEntry(
  args: {
    projectId: string;
    companyId: string;
    entryDate: string;
    createdByUserId: string;
    startTime: string | null;
    finishTime: string | null;
    supervisorUserId: string | null;
    narrative: Partial<Record<DiaryNarrativeField, string | null>>;
  },
  runner?: Queryable
): Promise<DiaryEntryRow | null> {
  const columns = ['project_id', 'company_id', 'entry_date', 'created_by_user_id',
    'updated_by_user_id', 'start_time', 'finish_time', 'supervisor_user_id'];
  const values = ['$1', '$2', '$3::date', '$4', '$4', '$5::time', '$6::time', '$7'];
  const params: unknown[] = [
    args.projectId,
    args.companyId,
    args.entryDate,
    args.createdByUserId,
    args.startTime,
    args.finishTime,
    args.supervisorUserId,
  ];
  for (const field of DIARY_NARRATIVE_FIELDS) {
    if (args.narrative[field] === undefined) continue;
    params.push(args.narrative[field]);
    columns.push(NARRATIVE_COLUMNS[field]);
    values.push(`$${params.length}`);
  }

  return queryOne<DiaryEntryRow>(
    `with inserted as (
       insert into site_diary_entries (${columns.join(', ')})
       values (${values.join(', ')})
       on conflict (project_id, company_id, entry_date) do nothing
       returning *
     )
     ${selectFromCte('inserted')}`,
    params,
    runner
  );
}

export async function updateDiaryEntry(
  id: string,
  patch: DiaryPatch,
  args: { actorUserId: string; expectedRevision?: number },
  runner?: Queryable
): Promise<DiaryEntryRow | null> {
  const params: unknown[] = [id, args.actorUserId];
  const sets: string[] = ['updated_by_user_id = $2'];
  for (const key of Object.keys(patch)) {
    const spec = PATCH_COLUMNS[key];
    if (!spec) continue;
    params.push((patch as Record<string, unknown>)[key]);
    sets.push(`${spec.column} = $${params.length}${spec.cast}`);
  }

  let guard = '';
  if (args.expectedRevision !== undefined) {
    params.push(args.expectedRevision);
    guard = ` and revision = $${params.length}`;
  }

  // The revision comparison lives inside the `update`'s own `where`, where the row
  // lock makes it atomic — the shape the locations suite proved was necessary.
  return queryOne<DiaryEntryRow>(
    `with updated as (
       update site_diary_entries set ${sets.join(', ')}
        where id = $1${guard}
        returning *
     )
     ${selectFromCte('updated')}`,
    params,
    runner
  );
}

/**
 * Close a day, and lose the race honestly.
 *
 * `where status = 'OPEN'` is the arbiter (packet §3). Two devices closing the
 * same day both pass any check the route could make first; exactly one `update`
 * matches, and the loser is told **who** closed it and **when** rather than being
 * given a generic conflict — because its recovery is an amendment with a reason,
 * not a retry.
 */
export function closeDiaryEntry(
  args: {
    id: string;
    actorUserId: string;
    startTime?: string | null;
    finishTime?: string | null;
    expectedRevision?: number;
  },
  runner?: Queryable
): Promise<DiaryEntryRow | null> {
  const params: unknown[] = [args.id, args.actorUserId];
  const sets = [
    `status = 'CLOSED'`,
    'closed_by_user_id = $2',
    'updated_by_user_id = $2',
    'closed_at = now()',
  ];
  if (args.startTime !== undefined) {
    params.push(args.startTime);
    sets.push(`start_time = $${params.length}::time`);
  }
  if (args.finishTime !== undefined) {
    params.push(args.finishTime);
    sets.push(`finish_time = $${params.length}::time`);
  }
  let guard = '';
  if (args.expectedRevision !== undefined) {
    params.push(args.expectedRevision);
    guard = ` and revision = $${params.length}`;
  }

  return queryOne<DiaryEntryRow>(
    `with closed as (
       update site_diary_entries set ${sets.join(', ')}
        where id = $1 and status = 'OPEN'${guard}
        returning *
     )
     ${selectFromCte('closed')}`,
    params,
    runner
  );
}

/**
 * Bump the entry's revision because one of its children changed.
 *
 * The `bump_revision` trigger fires on `site_diary_entries` and knows nothing
 * about attendance, locations or cited documents — so adding a person to a day
 * would leave every client's expected version still valid against a record that
 * has changed. Set explicitly rather than relying on `updated_by_user_id`
 * differing: the same person editing twice in a row changes no column, the
 * trigger correctly declines to fire, and the second device never learns.
 */
export function touchDiaryEntry(
  id: string,
  actorUserId: string,
  runner?: Queryable
): Promise<DiaryEntryRow | null> {
  return queryOne<DiaryEntryRow>(
    `with touched as (
       update site_diary_entries
          set revision = revision + 1, updated_at = now(), updated_by_user_id = $2
        where id = $1
        returning *
     )
     ${selectFromCte('touched')}`,
    [id, actorUserId],
    runner
  );
}

// ── Attendance ───────────────────────────────────────────────────────────────

export interface AttendanceRow {
  id: string;
  diary_entry_id: string;
  user_id: string | null;
  provider_company_id: string | null;
  name: string | null;
  role_id: string | null;
  headcount: string;
  hours: string | null;
  time_log_id: string | null;
}

/**
 * Add one line.
 *
 * `on conflict do nothing` against the one-per-time-log index, so applying the
 * prefill twice confirms the same crew rather than doubling it. A null
 * `time_log_id` is outside the index and inserts every time, which is right: two
 * hand-typed lines reading "agency labourer" are two agency labourers.
 */
export function insertAttendance(
  args: {
    diaryEntryId: string;
    userId: string | null;
    providerCompanyId: string | null;
    name: string | null;
    roleId: string | null;
    headcount: number;
    hours: number | null;
    timeLogId: string | null;
  },
  runner?: Queryable
): Promise<AttendanceRow | null> {
  return queryOne<AttendanceRow>(
    `insert into site_diary_attendance
       (diary_entry_id, user_id, provider_company_id, name, role_id, headcount, hours, time_log_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (diary_entry_id, time_log_id) where time_log_id is not null do nothing
     returning *`,
    [
      args.diaryEntryId,
      args.userId,
      args.providerCompanyId,
      args.name,
      args.roleId,
      args.headcount,
      args.hours,
      args.timeLogId,
    ],
    runner
  );
}

export function findAttendance(
  id: string,
  diaryEntryId: string,
  runner?: Queryable
): Promise<AttendanceRow | null> {
  return queryOne<AttendanceRow>(
    `select * from site_diary_attendance where id = $1 and diary_entry_id = $2`,
    [id, diaryEntryId],
    runner
  );
}

export function updateAttendance(
  id: string,
  patch: { roleId?: string | null; name?: string | null; headcount?: number; hours?: number | null },
  runner?: Queryable
): Promise<AttendanceRow | null> {
  const columns: Record<string, string> = {
    roleId: 'role_id',
    name: 'name',
    headcount: 'headcount',
    hours: 'hours',
  };
  const params: unknown[] = [id];
  const sets: string[] = [];
  for (const key of Object.keys(patch)) {
    if (!columns[key]) continue;
    params.push((patch as Record<string, unknown>)[key]);
    sets.push(`${columns[key]} = $${params.length}`);
  }
  if (sets.length === 0) return queryOne<AttendanceRow>(
    `select * from site_diary_attendance where id = $1`, [id], runner
  );
  return queryOne<AttendanceRow>(
    `update site_diary_attendance set ${sets.join(', ')} where id = $1 returning *`,
    params,
    runner
  );
}

export function deleteAttendance(
  id: string,
  diaryEntryId: string,
  runner?: Queryable
): Promise<AttendanceRow | null> {
  return queryOne<AttendanceRow>(
    `delete from site_diary_attendance where id = $1 and diary_entry_id = $2 returning *`,
    [id, diaryEntryId],
    runner
  );
}

// ── The two joined sets ──────────────────────────────────────────────────────

/**
 * Replace a set, and do it as a delete plus an insert inside the caller's
 * transaction.
 *
 * Not a diff: the sets are small, the write is one statement pair, and a diff is
 * three code paths where one of them is the empty case somebody forgets. The
 * `select` that follows sees the new set because it is the caller's own
 * transaction.
 */
export async function replaceDiaryLocations(
  entryId: string,
  locationIds: readonly string[],
  runner?: Queryable
): Promise<void> {
  await query(`delete from site_diary_locations where diary_entry_id = $1`, [entryId], runner);
  if (locationIds.length === 0) return;
  await query(
    `insert into site_diary_locations (diary_entry_id, location_id)
     select $1, unnest($2::uuid[])
     on conflict do nothing`,
    [entryId, [...new Set(locationIds)]],
    runner
  );
}

export async function replaceDiaryDocuments(
  entryId: string,
  documentIds: readonly string[],
  runner?: Queryable
): Promise<void> {
  await query(`delete from site_diary_documents where diary_entry_id = $1`, [entryId], runner);
  if (documentIds.length === 0) return;
  await query(
    `insert into site_diary_documents (diary_entry_id, document_id)
     select $1, unnest($2::uuid[])
     on conflict do nothing`,
    [entryId, [...new Set(documentIds)]],
    runner
  );
}

// ── Prefill ──────────────────────────────────────────────────────────────────

export interface PrefillTimeLogRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  provider_company_id: string;
  role_id: string | null;
  role_name: string | null;
  hours: string;
  status: string;
}

/**
 * The day's timesheets, for §23's prefill.
 *
 * **`SUBMITTED` and `APPROVED` only, and `DRAFT` deliberately not.** §12's
 * acceptance script says "the approved time logs"; a draft is somebody's
 * unfinished intention, and offering it as attendance would let the diary assert
 * that a person was on site because a colleague started typing a timesheet. The
 * drafts are not ignored either — Close Day counts them and says so, which is the
 * honest use of the same fact.
 *
 * Scoped to the authoring company's own logs. A hiring company's diary prefills
 * from its own crew, not from every subcontractor's timesheet on the project:
 * those people are the subcontractor's to confirm, in the subcontractor's diary.
 */
export function findPrefillTimeLogs(
  args: { projectId: string; companyId: string; entryDate: string },
  runner?: Queryable
): Promise<PrefillTimeLogRow[]> {
  return query<PrefillTimeLogRow>(
    `select t.id, t.logged_by_user_id as user_id, u.name as user_name,
            t.provider_company_id, t.role_id, r.name as role_name,
            (t.hours_regular + t.hours_ot) as hours, t.status
       from time_logs t
       left join users u on u.id = t.logged_by_user_id
       left join role_catalog r on r.id = t.role_id
      where t.project_id = $1 and t.provider_company_id = $2
        and t.work_date = $3::date
        and t.status in ('SUBMITTED','APPROVED')
      order by u.name asc nulls last, t.created_at asc`,
    [args.projectId, args.companyId, args.entryDate],
    runner
  );
}

/** The drafts Close Day mentions but never prefills from. */
export async function countDraftTimeLogs(
  args: { projectId: string; companyId: string; entryDate: string },
  runner?: Queryable
): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n from time_logs
      where project_id = $1 and provider_company_id = $2
        and work_date = $3::date and status = 'DRAFT'`,
    [args.projectId, args.companyId, args.entryDate],
    runner
  );
  return row?.n ?? 0;
}

/** Which of a day's suggestions are already on it, so nothing is offered twice. */
export async function existingTimeLogIds(
  entryId: string,
  runner?: Queryable
): Promise<string[]> {
  const rows = await query<{ time_log_id: string }>(
    `select time_log_id from site_diary_attendance
      where diary_entry_id = $1 and time_log_id is not null`,
    [entryId],
    runner
  );
  return rows.map((r) => r.time_log_id);
}
