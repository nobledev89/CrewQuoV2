import { Router } from 'express';
import {
  TIMELINE_SOURCES,
  decodeTimelineCursor,
  encodeTimelineCursor,
  timelineQuerySchema,
  type FeatureKey,
  type TimelineEventType,
  type TimelineItem,
  type TimelineResponse,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { query, queryOne } from '../../db';
import { assertCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { projectAccess } from '../assets/routes';

/**
 * The project timeline (§35) — step 11.8 of the Phase 11 build order in
 * `docs/operating-model/commercial-operations.md` §14.
 *
 * §35 in one sentence: *"An automatic chronology assembled from records that already
 * exist — no new writes, one read model."* So there is no table, no event log and
 * nothing to keep in step. What follows is a `union all` over the tables that
 * already hold the facts, ordered by event time and keyset-paginated like every
 * other list (§7).
 *
 * ── FOUR THINGS THAT MAKE THIS SAFE RATHER THAN A BACK DOOR ────────────────
 *
 * **1. Per-source feature gating.** The timeline has no feature key of its own and
 * could not honestly have one (packet §13.7): a company without `site_diary` still
 * has time logs and photographs. Each source is filtered by the feature that
 * governs its records, so a reader sees exactly the events they could have read one
 * at a time.
 *
 * **2. Per-source scoping, inside each clause.** A subcontractor sees its own
 * evidence and its own diary, not the project's; the owner sees everything. That is
 * the same scoping each source's own list endpoint applies, restated in SQL rather
 * than inherited by accident.
 *
 * **3. The client variant is assembled from a different set of sources**, not
 * filtered afterwards. `TIMELINE_SOURCES` carries `clientVisibility`, and a source
 * marked `NEVER` has no code path into the client union at all — which is
 * `reporting-signoff.md` finding 3's mechanism: an exclusion in a `where` clause is
 * an exclusion a later edit forgets.
 *
 * **4. A missing table is skipped, not fatal.** Copied from
 * `countLocationReferences` deliberately: a union over ten tables in a codebase
 * where migrations arrive one phase at a time will eventually name a table that is
 * not there, and a timeline that 500s because Phase 12 has not shipped is a worse
 * failure than the one the registry prevents.
 */

interface SourceClause {
  type: TimelineEventType;
  sql: string;
  /** Named parameters this clause needs, in order, appended to the shared list. */
  extra?: unknown[];
}

interface RawItem {
  kind: TimelineEventType;
  at: Date;
  entity_id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  company_id: string | null;
  company_name: string | null;
  description: string;
}

/**
 * Every clause, in one place, sharing the same three parameters.
 *
 * `$1` project id · `$2` the reading company id · `$3` owner scope (boolean).
 *
 * **Every clause names its own columns**, which looks redundant and is not. A
 * `union all` takes its column names from the FIRST branch, and which branch is
 * first here depends on what a caller filtered to — so a request for
 * `types=VARIATION_RAISED` alone produced a CTE with no `kind` column at all and a
 * 500, while the unfiltered request was perfectly fine. That is the worst shape a
 * bug can have: correct in the case everybody tries first.
 *
 * They also all cast to `text`, so a union never has to reconcile a `varchar`
 * column with an untyped literal. None of them selects a money figure: the description is prose, and the money lives on
 * the record a reader follows the link to. That is not decoration — a timeline that
 * carried `costCents` would need the whole §4 matrix reapplied to itself.
 */
function clausesFor(audience: 'INTERNAL' | 'CLIENT'): SourceClause[] {
  const clauses: SourceClause[] = [];
  const push = (type: TimelineEventType, sql: string): void => {
    const spec = TIMELINE_SOURCES.find((s) => s.type === type)!;
    if (audience === 'CLIENT' && spec.clientVisibility === 'NEVER') return;
    clauses.push({ type, sql });
  };

  push(
    'PROJECT_CREATED',
    `select 'PROJECT_CREATED'::text as kind, p.created_at as at, p.id::text as entity_id,
            null::uuid as actor_user_id, null::text as actor_name,
            p.owner_company_id as company_id, oc.name as company_name,
            'Project created'::text as description
       from projects p join companies oc on oc.id = p.owner_company_id
      where p.id = $1`
  );

  push(
    'CREW_ASSIGNED',
    `select 'CREW_ASSIGNED'::text as kind, a.created_at as at, a.id::text as entity_id,
            null::uuid as actor_user_id, null::text as actor_name,
            a.provider_company_id as company_id, pc.name as company_name,
            (pc.name || ' assigned to the project')::text as description
       from project_assignments a join companies pc on pc.id = a.provider_company_id
      where a.project_id = $1
        and ($3::boolean or a.provider_company_id = $2)`
  );

  push(
    'SCHEDULE_ASSIGNED',
    `select 'SCHEDULE_ASSIGNED'::text as kind, s.created_at as at, s.id::text as entity_id,
            s.created_by_user_id as actor_user_id, su.name as actor_name,
            s.company_id as company_id, sc.name as company_name,
            (coalesce(u.name, pc.name, v.name, 'A resource')
              || ' scheduled ' || to_char(s.starts_at, 'DD Mon HH24:MI')
              || case when s.status = 'CANCELLED' then ' (cancelled)' else '' end)::text
              as description
       from schedule_assignments s
       left join users su on su.id = s.created_by_user_id
       left join companies sc on sc.id = s.company_id
       left join users u on u.id = s.user_id
       left join companies pc on pc.id = s.provider_company_id
       left join vehicles v on v.id = s.vehicle_id
      where s.project_id = $1
        and ($3::boolean or s.provider_company_id = $2
             or s.user_id in (select user_id from memberships where company_id = $2))`
  );

  /*
   * §35 says "time entries", and DRAFT is deliberately excluded. The chronology is
   * meant to be read by *"someone who was not on site"*, and a draft timesheet is
   * not yet an assertion that anything happened.
   */
  push(
    'TIME_LOGGED',
    `select 'TIME_LOGGED'::text as kind, t.created_at as at, t.id::text as entity_id,
            t.logged_by_user_id as actor_user_id, tu.name as actor_name,
            t.provider_company_id as company_id, tc.name as company_name,
            (coalesce(r.name, 'Work') || ' · ' || to_char(t.work_date, 'DD Mon')
              || ' · ' || (t.hours_regular + t.hours_ot)::text || 'h')::text as description
       from time_logs t
       left join users tu on tu.id = t.logged_by_user_id
       left join companies tc on tc.id = t.provider_company_id
       left join role_catalog r on r.id = t.role_id
      where t.project_id = $1 and t.status <> 'DRAFT'
        and ($3::boolean or t.provider_company_id = $2)`
  );

  // §35's "approvals", which have a real timestamp: `reviewed_at`.
  push(
    'WORK_APPROVED',
    `select 'WORK_APPROVED'::text as kind, t.reviewed_at as at, t.id::text as entity_id,
            t.reviewed_by_user_id as actor_user_id, ru.name as actor_name,
            t.provider_company_id as company_id, tc.name as company_name,
            (coalesce(r.name, 'Work') || ' approved for '
              || to_char(t.work_date, 'DD Mon'))::text as description
       from time_logs t
       left join users ru on ru.id = t.reviewed_by_user_id
       left join companies tc on tc.id = t.provider_company_id
       left join role_catalog r on r.id = t.role_id
      where t.project_id = $1 and t.status = 'APPROVED' and t.reviewed_at is not null
        and ($3::boolean or t.provider_company_id = $2)`
  );

  push(
    'EXPENSE_APPROVED',
    `select 'EXPENSE_APPROVED'::text as kind, e.reviewed_at as at, e.id::text as entity_id,
            e.reviewed_by_user_id as actor_user_id, ru.name as actor_name,
            e.provider_company_id as company_id, ec.name as company_name,
            ('Expense approved: '
              || coalesce(e.description, e.category, 'no description'))::text as description
       from expenses e
       left join users ru on ru.id = e.reviewed_by_user_id
       left join companies ec on ec.id = e.provider_company_id
      where e.project_id = $1 and e.status = 'APPROVED' and e.reviewed_at is not null
        and ($3::boolean or e.provider_company_id = $2)`
  );

  push(
    'DIARY_ENTRY',
    `select 'DIARY_ENTRY'::text as kind, d.created_at as at, d.id::text as entity_id,
            d.created_by_user_id as actor_user_id, du.name as actor_name,
            d.company_id as company_id, dc.name as company_name,
            ('Site diary for ' || to_char(d.entry_date, 'DD Mon')
              || case when d.status = 'CLOSED' then ' (closed)' else '' end)::text
              as description
       from site_diary_entries d
       left join users du on du.id = d.created_by_user_id
       left join companies dc on dc.id = d.company_id
      -- No deleted_at filter, because site_diary_entries has none: 0032 gives a day
      -- no tombstone at all, on the reasoning that a day that happened cannot be
      -- made not to have happened. An amendment is a revision, never a deletion.
      --
      -- (Written without backticks on purpose, and this comment cost two container
      -- boots to get right. A backtick inside a template literal ENDS the template,
      -- so a SQL comment that quotes a column name in backticks breaks the query it
      -- documents -- and tsc --noEmit passed both times, because what was left was
      -- still parseable TypeScript. Prose inside a SQL template is code.)
      where d.project_id = $1
        and ($3::boolean or d.company_id = $2)`
  );

  /*
   * `SOME`: a photograph crosses to the client only where somebody deliberately
   * published it. The clause below is where that is enforced for the client variant,
   * and the `clientVisibility` flag is what decides whether this clause is built
   * at all.
   */
  push(
    'EVIDENCE_UPLOADED',
    `select 'EVIDENCE_UPLOADED'::text as kind, ev.created_at as at, ev.id::text as entity_id,
            ev.uploaded_by_user_id as actor_user_id, eu.name as actor_name,
            ev.company_id as company_id, ec.name as company_name,
            coalesce(ev.caption, ev.category || ' photograph')::text as description
       from project_evidence ev
       left join users eu on eu.id = ev.uploaded_by_user_id
       left join companies ec on ec.id = ev.company_id
      where ev.project_id = $1 and ev.deleted_at is null
        and ($3::boolean or ev.company_id = $2)
        ${audience === 'CLIENT' ? 'and ev.client_visible' : ''}`
  );

  push(
    'ASSET_RECORDED',
    `select 'ASSET_RECORDED'::text as kind, pa.created_at as at, pa.id::text as entity_id,
            pa.created_by_user_id as actor_user_id, au.name as actor_name,
            pa.company_id as company_id, ac.name as company_name,
            (pa.quantity::text || ' × ' || coalesce(pa.description, at2.name, 'asset')
              || ' recorded')::text as description
       from project_assets pa
       left join users au on au.id = pa.created_by_user_id
       left join companies ac on ac.id = pa.company_id
       left join asset_types at2 on at2.id = pa.asset_type_id
      where pa.project_id = $1 and pa.deleted_at is null
        and ($3::boolean or pa.company_id = $2)`
  );

  push(
    'ASSET_MOVED',
    `select 'ASSET_MOVED'::text as kind, m.created_at as at, m.id::text as entity_id,
            m.recorded_by_user_id as actor_user_id, mu.name as actor_name,
            pa.company_id as company_id, mc.name as company_name,
            (coalesce(pa.description, 'Material') || ' → '
              || coalesce(dt.name, 'a destination'))::text as description
       from asset_movements m
       join project_assets pa on pa.id = m.asset_id
       left join users mu on mu.id = m.recorded_by_user_id
       left join companies mc on mc.id = pa.company_id
       left join destination_types dt on dt.id = m.destination_type_id
      where pa.project_id = $1 and m.deleted_at is null and pa.deleted_at is null
        and ($3::boolean or pa.company_id = $2)`
  );

  push(
    'ACTIVITY_RECORDED',
    `select 'ACTIVITY_RECORDED'::text as kind, ac2.created_at as at, ac2.id::text as entity_id,
            ac2.created_by_user_id as actor_user_id, acu.name as actor_name,
            ac2.company_id as company_id, acc.name as company_name,
            (replace(ac2.kind, '_', ' ') || ' on '
              || to_char(ac2.activity_date, 'DD Mon'))::text as description
       from project_activities ac2
       left join users acu on acu.id = ac2.created_by_user_id
       left join companies acc on acc.id = ac2.company_id
      where ac2.project_id = $1 and ac2.deleted_at is null
        and ($3::boolean or ac2.company_id = $2)`
  );

  push(
    'DOCUMENT_UPLOADED',
    `select 'DOCUMENT_UPLOADED'::text as kind, pd.created_at as at, pd.id::text as entity_id,
            pd.uploaded_by_user_id as actor_user_id, pdu.name as actor_name,
            pd.company_id as company_id, pdc.name as company_name,
            pd.title::text as description
       from project_documents pd
       left join users pdu on pdu.id = pd.uploaded_by_user_id
       left join companies pdc on pdc.id = pd.company_id
      where pd.project_id = $1 and pd.deleted_at is null
        and ($3::boolean or pd.company_id = $2)
        ${audience === 'CLIENT' ? 'and pd.client_visible' : ''}`
  );

  push(
    'VARIATION_RAISED',
    `select 'VARIATION_RAISED'::text as kind, v.created_at as at, v.id::text as entity_id,
            v.created_by_user_id as actor_user_id, vu.name as actor_name,
            v.company_id as company_id, vc.name as company_name,
            ('Variation raised' || coalesce(' ' || v.reference, '') || ': '
              || left(v.description, 90))::text as description
       from variations v
       left join users vu on vu.id = v.created_by_user_id
       left join companies vc on vc.id = v.company_id
      where v.project_id = $1 and v.deleted_at is null
        and ($3::boolean or v.company_id = $2)`
  );

  push(
    'VARIATION_DECIDED',
    `select 'VARIATION_DECIDED'::text as kind, v.reviewed_at as at, v.id::text as entity_id,
            v.reviewed_by_user_id as actor_user_id, vru.name as actor_name,
            v.company_id as company_id, vc2.name as company_name,
            ('Variation ' || lower(v.status)
              || coalesce(' ' || v.reference, '')
              || coalesce(': ' || v.reject_reason, ''))::text as description
       from variations v
       left join users vru on vru.id = v.reviewed_by_user_id
       left join companies vc2 on vc2.id = v.company_id
      where v.project_id = $1 and v.deleted_at is null and v.reviewed_at is not null
        and ($3::boolean or v.company_id = $2)
        ${audience === 'CLIENT' ? "and v.status in ('APPROVED','COMPLETED','INVOICED')" : ''}`
  );

  push(
    'REPORT_GENERATED',
    `select 'REPORT_GENERATED'::text as kind, g.generated_at as at, g.id::text as entity_id,
            g.generated_by_user_id as actor_user_id, gu.name as actor_name,
            g.company_id as company_id, gc.name as company_name,
            (coalesce(g.title, replace(g.kind, '_', ' ')) || ' generated')::text as description
       from generated_reports g
       left join users gu on gu.id = g.generated_by_user_id
       left join companies gc on gc.id = g.company_id
      where g.project_id = $1
        and ($3::boolean or g.company_id = $2)
        ${audience === 'CLIENT' ? 'and g.client_visible' : ''}`
  );

  push(
    'CLIENT_SIGNOFF',
    `select 'CLIENT_SIGNOFF'::text as kind, cs.signed_at as at, cs.id::text as entity_id,
            cs.captured_by_user_id as actor_user_id, csu.name as actor_name,
            cs.company_id as company_id, csc.name as company_name,
            ('Signed off by ' || cs.signer_name
              || coalesce(' for ' || cs.phase, ' for the project'))::text as description
       from client_signoffs cs
       left join users csu on csu.id = cs.captured_by_user_id
       left join companies csc on csc.id = cs.company_id
      where cs.project_id = $1
        and ($3::boolean or cs.company_id = $2)`
  );

  /*
   * §35's *"completion"*, and packet finding 10's second half: `projects` carries a
   * status and **no `completed_at`**, so the instant a project was completed is not
   * a fact this schema holds. It comes from the sign-off that attests it — a
   * whole-project one, which is what `phase is null` means — and where there is no
   * sign-off the timeline says nothing rather than inventing a date from
   * `updated_at`, which is the timestamp of the most recent edit to anything.
   */
  push(
    'PROJECT_COMPLETED',
    `select 'PROJECT_COMPLETED'::text as kind, cs.signed_at as at, cs.id::text as entity_id,
            cs.captured_by_user_id as actor_user_id, csu2.name as actor_name,
            cs.company_id as company_id, csc2.name as company_name,
            'Project completed and signed off'::text as description
       from client_signoffs cs
       left join users csu2 on csu2.id = cs.captured_by_user_id
       left join companies csc2 on csc2.id = cs.company_id
      where cs.project_id = $1 and cs.phase is null
        and not exists (select 1 from client_signoffs s2 where s2.supersedes_id = cs.id)
        and ($3::boolean or cs.company_id = $2)`
  );

  return clauses;
}

/** In-app path to the record a timeline item points at. */
function hrefFor(item: { type: TimelineEventType; entityId: string }, projectId: string): string | null {
  switch (item.type) {
    case 'PROJECT_CREATED':
    case 'PROJECT_COMPLETED':
      return `/projects/${projectId}`;
    case 'CREW_ASSIGNED':
      return `/projects/${projectId}?section=crew`;
    case 'SCHEDULE_ASSIGNED':
      return `/projects/${projectId}?section=schedule`;
    case 'TIME_LOGGED':
    case 'WORK_APPROVED':
      return `/projects/${projectId}?section=time`;
    case 'EXPENSE_APPROVED':
      return `/projects/${projectId}?section=expenses`;
    case 'DIARY_ENTRY':
      return `/projects/${projectId}?section=diary`;
    case 'EVIDENCE_UPLOADED':
      return `/projects/${projectId}?section=evidence`;
    case 'ASSET_RECORDED':
    case 'ASSET_MOVED':
      return `/projects/${projectId}?section=assets`;
    case 'ACTIVITY_RECORDED':
      return `/projects/${projectId}?section=sustainability`;
    case 'DOCUMENT_UPLOADED':
      return `/projects/${projectId}?section=documents`;
    case 'VARIATION_RAISED':
    case 'VARIATION_DECIDED':
      return `/projects/${projectId}?section=variations`;
    case 'REPORT_GENERATED':
    case 'CLIENT_SIGNOFF':
      return `/projects/${projectId}?section=reports`;
    /* c8 ignore next 3 -- INCIDENT has no source table and never reaches here. */
    case 'INCIDENT':
      return null;
  }
}

/** Does this table exist? Cached per process — a table does not un-exist. */
const tableExists = new Map<string, boolean>();
async function hasTable(name: string): Promise<boolean> {
  const cached = tableExists.get(name);
  if (cached !== undefined) return cached;
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok from information_schema.tables
      where table_schema = 'public' and table_name = $1`,
    [name]
  );
  const exists = row?.ok === true;
  tableExists.set(name, exists);
  return exists;
}

export async function buildTimeline(args: {
  projectId: string;
  companyId: string;
  ownerCompanyId: string;
  ownerScope: boolean;
  audience: 'INTERNAL' | 'CLIENT';
  from?: string;
  to?: string;
  types?: readonly TimelineEventType[];
  cursor?: string;
  limit: number;
}): Promise<TimelineResponse> {
  const asked = args.types === undefined ? null : new Set(args.types);
  const sources: TimelineResponse['sources'] = [];
  const included: SourceClause[] = [];

  for (const clause of clausesFor(args.audience)) {
    const spec = TIMELINE_SOURCES.find((s) => s.type === clause.type)!;
    if (asked && !asked.has(clause.type)) {
      sources.push({ type: clause.type, included: false, reason: 'FILTERED_OUT' });
      continue;
    }
    if (!(await hasTable(spec.sourceTable!))) {
      sources.push({ type: clause.type, included: false, reason: 'NO_TABLE' });
      continue;
    }
    if (spec.feature && !(await hasFeature(args.ownerCompanyId, spec.feature as FeatureKey))) {
      sources.push({ type: clause.type, included: false, reason: 'NO_FEATURE' });
      continue;
    }
    sources.push({ type: clause.type, included: true, reason: 'OK' });
    included.push(clause);
  }

  // The types with no table anywhere in the plan, reported rather than omitted —
  // the honest answer to "why is my INCIDENT filter empty".
  for (const spec of TIMELINE_SOURCES) {
    if (spec.sourceTable !== null) continue;
    if (asked && !asked.has(spec.type)) continue;
    sources.push({ type: spec.type, included: false, reason: 'NO_TABLE' });
  }
  for (const spec of TIMELINE_SOURCES) {
    if (args.audience !== 'CLIENT' || spec.clientVisibility !== 'NEVER') continue;
    if (asked && !asked.has(spec.type)) continue;
    sources.push({ type: spec.type, included: false, reason: 'NOT_FOR_THIS_AUDIENCE' });
  }

  if (included.length === 0) {
    return { items: [], nextCursor: null, sources };
  }

  const cursor = args.cursor === undefined ? null : decodeTimelineCursor(args.cursor);
  if (args.cursor !== undefined && cursor === null) {
    throw new AppError('VALIDATION', 'That cursor is not one this endpoint issued', {
      field: 'cursor',
    });
  }

  /*
   * `limit + 1` so the presence of a next page is a fact rather than a guess — the
   * same trick every other keyset list in this API uses. The whole union is
   * materialised and then ordered, which is correct and is also the honest cost of
   * §35's design: a chronology over ten tables has no index that spans them.
   * Bounded by the project, which is what keeps it small.
   */
  const sql = `
    with events as (
      ${included.map((c) => `(${c.sql})`).join('\n      union all\n      ')}
    )
    select kind, at, entity_id, actor_user_id, actor_name, company_id, company_name, description
      from events
     where at is not null
       and ($4::timestamptz is null or at >= $4)
       and ($5::timestamptz is null or at <= $5)
       and ($6::timestamptz is null or (at, kind || ':' || entity_id) < ($6, $7))
     order by at desc, (kind || ':' || entity_id) desc
     limit $8`;

  const rows = await query<RawItem>(sql, [
    args.projectId,
    args.companyId,
    args.ownerScope,
    args.from ?? null,
    args.to ?? null,
    cursor?.at ?? null,
    cursor?.id ?? null,
    args.limit + 1,
  ]);

  const page = rows.slice(0, args.limit);
  const items: TimelineItem[] = page.map((row) => {
    const id = `${row.kind}:${row.entity_id}`;
    return {
      id,
      type: row.kind,
      at: row.at.toISOString(),
      actorUserId: row.actor_user_id,
      actorName: row.actor_name,
      companyId: row.company_id,
      companyName: row.company_name,
      description: row.description,
      entityType: row.kind,
      entityId: row.entity_id,
      href: hrefFor({ type: row.kind, entityId: row.entity_id }, args.projectId),
    };
  });

  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > args.limit && last ? encodeTimelineCursor(last) : null,
    sources,
  };
}

export const projectTimelineRouter = Router();

/**
 * `GET /v1/projects/:projectId/timeline`
 *
 * **No feature key.** Structure rather than content, like §21's locations — and it
 * could not honestly have one, because it is a union over record classes whose
 * features differ. Each source carries its own gate.
 */
projectTimelineRouter.get(
  '/:projectId/timeline',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertCapability(ctx, 'project.read');

    const q = req.query as Record<string, unknown>;
    const parsed = timelineQuerySchema.parse({
      from: typeof q.from === 'string' ? q.from : undefined,
      to: typeof q.to === 'string' ? q.to : undefined,
      types:
        typeof q.types === 'string'
          ? q.types.split(',').filter((t) => t !== '')
          : Array.isArray(q.types)
            ? (q.types as string[])
            : undefined,
      cursor: typeof q.cursor === 'string' ? q.cursor : undefined,
      limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
    });

    res.json(
      await buildTimeline({
        projectId: access.projectId,
        companyId: ctx.companyId,
        ownerCompanyId: access.ownerCompanyId,
        ownerScope: access.isOwner,
        audience: 'INTERNAL',
        from: parsed.from,
        to: parsed.to,
        types: parsed.types,
        cursor: parsed.cursor,
        limit: parsed.limit ?? 50,
      })
    );
  })
);
