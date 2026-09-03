import type { SourceRevision } from '@crewquo/shared';
import { query, queryOne } from '../../db';

/**
 * Every read a snapshot builder makes, in one place.
 *
 * Separated from `snapshot.ts` for the reason `data.ts` is separated from
 * `model.ts` one module over: assembly is where the audience boundary lives and
 * where §41.1's nulls are decided, and it should be readable without eleven SQL
 * statements interleaved through it.
 *
 * **Nothing here filters by audience.** These are the project's facts; which of
 * them a given document may carry is `snapshot.ts`'s question, and answering it in
 * two places is how the two answers diverge.
 */

export interface ProjectHeaderRow {
  id: string;
  name: string;
  status: string;
  starts_on: string | null;
  ends_on: string | null;
  notes: string | null;
  owner_company_id: string;
  owner_company_name: string;
  client_company_id: string | null;
  client_company_name: string | null;
  engagement_id: string | null;
  reporting_currency: string;
  site_name: string | null;
  site_reference: string | null;
  owner_logo_file_id: string | null;
  client_default_logo_file_id: string | null;
  client_override_logo_file_id: string | null;
  report_disclaimer: string;
}

/**
 * The project, both companies, the site and the branding, in one read.
 *
 * **Branding resolves client-first (decision #30)** and both candidates are
 * fetched rather than one being chosen in SQL, because the snapshot records *which*
 * source won: a reader a year later should be able to see whose asset it was, not
 * only that there was one.
 *
 * `site_name` is the project's root location. A project has no `site` column and
 * inventing one for a cover page would be a schema decision made by a report;
 * §21's location tree already holds the answer, and its root is what a person means
 * by "the site".
 */
export function loadProjectHeader(projectId: string): Promise<ProjectHeaderRow | null> {
  return queryOne<ProjectHeaderRow>(
    `select p.id, p.name, p.status,
            to_char(p.starts_on, 'YYYY-MM-DD') as starts_on,
            to_char(p.ends_on, 'YYYY-MM-DD') as ends_on,
            p.notes, p.owner_company_id, oc.name as owner_company_name,
            p.client_company_id, cc.name as client_company_name,
            p.engagement_id, p.reporting_currency,
            root.name as site_name, root.reference as site_reference,
            os.report_logo_file_id as owner_logo_file_id,
            cs.report_logo_file_id as client_default_logo_file_id,
            p.client_logo_file_id as client_override_logo_file_id,
            coalesce(os.report_disclaimer, '') as report_disclaimer
       from projects p
       join companies oc on oc.id = p.owner_company_id
       left join companies cc on cc.id = p.client_company_id
       left join sustainability_settings os on os.company_id = p.owner_company_id
       left join sustainability_settings cs on cs.company_id = p.client_company_id
       left join lateral (
         select l.name, l.reference from project_locations l
          where l.project_id = p.id and l.parent_id is null
            and l.deleted_at is null and l.active
          order by l.sort_order, l.name limit 1
       ) root on true
      where p.id = $1`,
    [projectId]
  );
}

export interface WorkforceRow {
  provider_company_id: string;
  provider_company_name: string;
  hours: string;
  people: string;
}

/**
 * Who did the work, per subcontractor, over approved time only.
 *
 * Approved only, matching `computeProjectSummary`, the portal and the Phase 4
 * export: a draft hour is not a fact about the project yet, and a completion report
 * that counted unreviewed hours would disagree with the invoice.
 *
 * The **owner's own people are a row here too** — `provider_company_id` on a
 * self-performed log is the owner — which is what makes the client-facing count of
 * "subcontracted organisations" correct rather than off by one.
 */
export function loadWorkforce(projectId: string): Promise<WorkforceRow[]> {
  return query<WorkforceRow>(
    `select t.provider_company_id, pc.name as provider_company_name,
            coalesce(sum(t.hours_regular + t.hours_ot), 0)::text as hours,
            count(distinct t.logged_by_user_id)::text as people
       from time_logs t
       join companies pc on pc.id = t.provider_company_id
      where t.project_id = $1 and t.status = 'APPROVED'
      group by t.provider_company_id, pc.name
      order by pc.name`,
    [projectId]
  );
}

export interface MaterialRow {
  category: string;
  mass_kg: string;
}

/**
 * §29.1 section 6's material breakdown, by asset category.
 *
 * Over **final-outcome movements that nothing continues**, which is §28.2's own
 * definition of handled mass and the rule `assets-materials.md` had to invent a
 * self-reference to express: twelve chairs into storage and twelve out of it is one
 * outcome, not two, and summing both would report a tonne twice.
 */
export function loadMaterials(projectId: string): Promise<MaterialRow[]> {
  return query<MaterialRow>(
    `select t.category,
            sum(coalesce(m.weight_kg, m.quantity * a.unit_weight_kg))::text as mass_kg
       from asset_movements m
       join project_assets a on a.id = m.asset_id
       join asset_types t on t.id = a.asset_type_id
       join destination_types d on d.id = m.destination_type_id
      where a.project_id = $1
        and m.deleted_at is null and a.deleted_at is null
        and d.is_final_outcome
        and not exists (
          select 1 from asset_movements c
           where c.continues_movement_id = m.id and c.deleted_at is null
        )
      group by t.category
      having sum(coalesce(m.weight_kg, m.quantity * a.unit_weight_kg)) > 0
      order by 2 desc`,
    [projectId]
  );
}

export interface MovementDetailRow {
  id: string;
  revision: number;
  asset_id: string;
  asset_name: string;
  asset_type_name: string;
  destination_code: string;
  destination_name: string;
  organisation_name: string | null;
  moved_on: string;
  quantity: string;
  weight_kg: string | null;
  document_id: string | null;
  document_title: string | null;
  document_reference: string | null;
  document_category: string | null;
  document_file_id: string | null;
  counts_as_reuse: boolean;
  counts_as_retained_in_use: boolean;
  counts_as_recycling: boolean;
  counts_as_recovery: boolean;
  counts_as_landfill: boolean;
  evidence_count: string;
}

/** Every live movement with its destination, its organisation and its paperwork. */
export function loadMovements(projectId: string): Promise<MovementDetailRow[]> {
  return query<MovementDetailRow>(
    `select m.id, m.revision, m.asset_id,
            coalesce(a.description, t.name) as asset_name,
            t.name as asset_type_name,
            d.code as destination_code, d.name as destination_name,
            o.name as organisation_name,
            to_char(m.moved_on, 'YYYY-MM-DD') as moved_on,
            m.quantity::text as quantity,
            coalesce(m.weight_kg, m.quantity * a.unit_weight_kg)::text as weight_kg,
            m.document_id, doc.title as document_title, doc.reference as document_reference,
            doc.category as document_category, doc.file_id as document_file_id,
            d.counts_as_reuse, d.counts_as_retained_in_use, d.counts_as_recycling,
            d.counts_as_recovery, d.counts_as_landfill,
            (select count(*) from project_evidence e
              where e.asset_id = a.id and e.deleted_at is null)::text as evidence_count
       from asset_movements m
       join project_assets a on a.id = m.asset_id
       join asset_types t on t.id = a.asset_type_id
       join destination_types d on d.id = m.destination_type_id
       left join destination_organisations o on o.id = m.destination_org_id
       left join project_documents doc on doc.id = m.document_id and doc.deleted_at is null
      where a.project_id = $1 and m.deleted_at is null and a.deleted_at is null
      order by m.moved_on, t.name, m.sequence`,
    [projectId]
  );
}

export interface AssetLineRow {
  id: string;
  revision: number;
  name: string;
  quantity: string;
  mass_kg: string | null;
  outcome_destinations: string[] | null;
}

export function loadAssetLines(projectId: string): Promise<AssetLineRow[]> {
  return query<AssetLineRow>(
    `select a.id, a.revision,
            coalesce(a.description, t.name) as name,
            a.quantity::text as quantity,
            (a.quantity * a.unit_weight_kg)::text as mass_kg,
            array_remove(array_agg(distinct d.name), null) as outcome_destinations
       from project_assets a
       join asset_types t on t.id = a.asset_type_id
       left join asset_movements m on m.asset_id = a.id and m.deleted_at is null
       left join destination_types d on d.id = m.destination_type_id
      where a.project_id = $1 and a.deleted_at is null
      group by a.id, a.revision, a.description, t.name, a.quantity, a.unit_weight_kg
      order by t.name, a.created_at`,
    [projectId]
  );
}

export interface EvidenceRow {
  id: string;
  file_id: string;
  caption: string | null;
  category: string;
  captured_at: string | null;
  client_visible: boolean;
}

/**
 * The photographs, newest capture first, capped.
 *
 * `scope: 'CLIENT'` restricts to published evidence **in the `where` clause**, so a
 * client-audience snapshot never holds an unpublished image even in memory. The cap
 * is on the snapshot rather than on the rendering because a snapshot is what gets
 * sealed: a document that silently included a hundred and rendered twelve would
 * have a hash that moved for reasons a reader cannot see.
 */
export function loadEvidence(
  projectId: string,
  scope: 'OWNER' | 'CLIENT',
  limit: number
): Promise<EvidenceRow[]> {
  return query<EvidenceRow>(
    `select e.id, e.file_id, e.caption, e.category,
            to_char(e.captured_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSZ') as captured_at,
            e.client_visible
       from project_evidence e
       join stored_files f on f.id = e.file_id
      where e.project_id = $1 and e.deleted_at is null
        and f.status = 'READY'
        and ($2::text = 'OWNER' or e.client_visible)
      order by coalesce(e.captured_at, e.created_at) asc, e.id
      limit $3`,
    [projectId, scope, limit]
  );
}

export interface DocumentRow {
  id: string;
  title: string;
  category: string;
  reference: string | null;
  issued_on: string | null;
  file_id: string | null;
  client_visible: boolean;
}

export function loadDocuments(
  projectId: string,
  scope: 'OWNER' | 'CLIENT',
  categories: readonly string[]
): Promise<DocumentRow[]> {
  return query<DocumentRow>(
    `select d.id, d.title, d.category, d.reference,
            to_char(d.issued_on, 'YYYY-MM-DD') as issued_on,
            d.file_id, d.client_visible
       from project_documents d
      where d.project_id = $1 and d.deleted_at is null
        -- The current version only. §24's chain is the point internally; in a
        -- handover pack a superseded waste transfer note is a document that is no
        -- longer true, sitting beside the one that is.
        and not exists (
          select 1 from project_documents s
           where s.supersedes_id = d.id and s.deleted_at is null
        )
        and d.category = any($3::text[])
        and ($2::text = 'OWNER' or d.client_visible)
      order by d.category, coalesce(d.issued_on, d.created_at::date), d.title`,
    [projectId, scope, categories]
  );
}

export interface DiaryRow {
  id: string;
  entry_date: string;
  revision: number;
  status: string;
  weather: string | null;
  work_completed: string | null;
  notes: string | null;
  delays: string | null;
  attendance_count: string;
}

/**
 * The diary, and `revision` is here for §13.6 rather than for display.
 *
 * A report that cites 3 March freezes the revision 3 March was at; a later
 * amendment moves the live one and the divergence becomes a banner rather than a
 * silent rewrite of the document.
 */
export function loadDiary(projectId: string, scope: 'OWNER' | 'CLIENT'): Promise<DiaryRow[]> {
  return query<DiaryRow>(
    `select e.id, to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, e.revision, e.status,
            e.weather, e.work_completed, e.notes, e.delays,
            (select count(*) from site_diary_attendance a where a.diary_entry_id = e.id)::text
              as attendance_count
       from site_diary_entries e
      -- No tombstone filter: site_diary_entries has no deleted_at column, because
      -- 0032 refused a diary day one on purpose. A day that happened happened, and
      -- the amendment path is how a wrong one is corrected.
      where e.project_id = $1
        and ($2::text = 'OWNER' or e.status = 'CLOSED')
      order by e.entry_date`,
    [projectId, scope]
  );
}

/**
 * The revision of every record class the snapshot cites (packet finding 10).
 *
 * `CALCULATIONS` has no revision column, so its integer is the **total** number of
 * calculation rows the project has ever had, superseded included. That is monotonic
 * by construction — supersession inserts rather than updates — so it moves whenever
 * the ledger moves and never moves when it does not, which is exactly what a
 * revision is for.
 */
export async function loadSourceRevisions(projectId: string): Promise<SourceRevision[]> {
  const [diary, assets, movements, calcs] = await Promise.all([
    query<{ id: string; label: string; revision: number }>(
      // Again no tombstone filter — see `loadDiary`.
      `select id, to_char(entry_date, 'YYYY-MM-DD') as label, revision
         from site_diary_entries where project_id = $1`,
      [projectId]
    ),
    query<{ id: string; label: string; revision: number }>(
      `select a.id, coalesce(a.description, t.name) as label, a.revision
         from project_assets a join asset_types t on t.id = a.asset_type_id
        where a.project_id = $1 and a.deleted_at is null`,
      [projectId]
    ),
    query<{ id: string; label: string; revision: number }>(
      `select m.id, coalesce(a.description, t.name) as label, m.revision
         from asset_movements m
         join project_assets a on a.id = m.asset_id
         join asset_types t on t.id = a.asset_type_id
        where a.project_id = $1 and m.deleted_at is null and a.deleted_at is null`,
      [projectId]
    ),
    queryOne<{ n: string }>(
      `select count(*)::text as n from carbon_calculations where project_id = $1`,
      [projectId]
    ),
  ]);

  return [
    ...diary.map((r) => ({ kind: 'DIARY' as const, id: r.id, label: r.label, revision: r.revision })),
    ...assets.map((r) => ({ kind: 'ASSET' as const, id: r.id, label: r.label, revision: r.revision })),
    ...movements.map((r) => ({
      kind: 'MOVEMENT' as const,
      id: r.id,
      label: r.label,
      revision: r.revision,
    })),
    {
      kind: 'CALCULATIONS' as const,
      id: null,
      label: 'project',
      revision: Number(calcs?.n ?? 0),
    },
  ];
}

/** The live calculation ids, hashed into the snapshot so §41.3 is checkable. */
export async function loadLedgerIds(projectId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `select id from carbon_calculations
      where project_id = $1 and superseded_by is null order by id`,
    [projectId]
  );
  return rows.map((r) => r.id);
}
