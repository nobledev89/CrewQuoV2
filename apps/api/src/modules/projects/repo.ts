import type {
  AssignmentView,
  CreateProject,
  ProjectStatus,
  ProjectView,
  UpdateProject,
} from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';
import { AppError } from '../../http/errors';

/**
 * Project & assignment persistence (CREWQUO_V2_PLAN.md §3.4). Projects are scoped
 * to `owner_company_id` = the active company; assignments attach a provider (and
 * the derived engagement edge) to a project.
 */

interface ProjectRow {
  id: string;
  owner_company_id: string;
  client_company_id: string | null;
  client_company_name: string | null;
  engagement_id: string | null;
  name: string;
  status: ProjectStatus;
  client_visible: boolean;
  starts_on: string | null;
  ends_on: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

function toProjectView(r: ProjectRow): ProjectView {
  return {
    id: r.id,
    ownerCompanyId: r.owner_company_id,
    clientCompanyId: r.client_company_id,
    clientCompanyName: r.client_company_name,
    engagementId: r.engagement_id,
    name: r.name,
    status: r.status,
    clientVisible: r.client_visible,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const PROJECT_SELECT = `
  select p.id, p.owner_company_id, p.client_company_id, cc.name as client_company_name,
         p.engagement_id, p.name, p.status, p.client_visible,
         to_char(p.starts_on, 'YYYY-MM-DD') as starts_on,
         to_char(p.ends_on, 'YYYY-MM-DD') as ends_on,
         p.notes, p.created_at, p.updated_at
    from projects p
    left join companies cc on cc.id = p.client_company_id`;

export async function listProjects(ownerCompanyId: string): Promise<ProjectView[]> {
  const rows = await query<ProjectRow>(
    `${PROJECT_SELECT} where p.owner_company_id = $1 order by p.created_at desc`,
    [ownerCompanyId]
  );
  return rows.map(toProjectView);
}

export async function getProject(
  ownerCompanyId: string,
  id: string,
  runner?: Queryable
): Promise<ProjectView | null> {
  const row = await queryOne<ProjectRow>(
    `${PROJECT_SELECT} where p.owner_company_id = $1 and p.id = $2`,
    [ownerCompanyId, id],
    runner
  );
  return row ? toProjectView(row) : null;
}

export async function createProject(
  ownerCompanyId: string,
  input: CreateProject
): Promise<ProjectView> {
  const row = await queryOne<{ id: string }>(
    `insert into projects (owner_company_id, client_company_id, engagement_id, name, status,
                           client_visible, starts_on, ends_on, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [
      ownerCompanyId,
      input.clientCompanyId,
      input.engagementId,
      input.name,
      input.status,
      input.clientVisible,
      input.startsOn,
      input.endsOn,
      input.notes,
    ]
  );
  return (await getProject(ownerCompanyId, row!.id))!;
}

export async function updateProject(
  ownerCompanyId: string,
  id: string,
  patch: UpdateProject
): Promise<ProjectView> {
  const has = (k: keyof UpdateProject) => k in patch;
  const row = await queryOne<{ id: string }>(
    `update projects set
       name = coalesce($3, name),
       client_company_id = case when $4::boolean then $5 else client_company_id end,
       engagement_id = case when $6::boolean then $7 else engagement_id end,
       status = coalesce($8, status),
       client_visible = coalesce($9, client_visible),
       starts_on = case when $10::boolean then $11::date else starts_on end,
       ends_on = case when $12::boolean then $13::date else ends_on end,
       notes = case when $14::boolean then $15 else notes end,
       updated_at = now()
     where owner_company_id = $1 and id = $2 returning id`,
    [
      ownerCompanyId,
      id,
      patch.name ?? null,
      has('clientCompanyId'),
      patch.clientCompanyId ?? null,
      has('engagementId'),
      patch.engagementId ?? null,
      patch.status ?? null,
      patch.clientVisible ?? null,
      has('startsOn'),
      patch.startsOn ?? null,
      has('endsOn'),
      patch.endsOn ?? null,
      has('notes'),
      patch.notes ?? null,
    ]
  );
  if (!row) throw new AppError('NOT_FOUND', 'Project not found');
  return (await getProject(ownerCompanyId, id))!;
}

export async function deleteProject(ownerCompanyId: string, id: string): Promise<void> {
  const row = await queryOne(
    `delete from projects where owner_company_id = $1 and id = $2 returning id`,
    [ownerCompanyId, id]
  );
  if (!row) throw new AppError('NOT_FOUND', 'Project not found');
}

// ── Assignments ──────────────────────────────────────────────────────────────────

export async function listAssignments(projectId: string): Promise<AssignmentView[]> {
  return query<AssignmentView>(
    `select a.id, a.project_id as "projectId", a.provider_company_id as "providerCompanyId",
            pc.name as "providerCompanyName", a.engagement_id as "engagementId",
            a.acceptance as "acceptance",
            to_char(a.accepted_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSZ') as "acceptedAt",
            a.decision_reason as "decisionReason",
            to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSZ') as "createdAt"
       from project_assignments a
       join companies pc on pc.id = a.provider_company_id
      where a.project_id = $1
      order by pc.name asc`,
    [projectId]
  );
}

export async function insertAssignment(
  input: { projectId: string; providerCompanyId: string; engagementId: string },
  runner?: Queryable
): Promise<{ id: string }> {
  const row = await queryOne<{ id: string }>(
    `insert into project_assignments (project_id, provider_company_id, engagement_id)
     values ($1, $2, $3)
     on conflict (project_id, provider_company_id) do nothing
     returning id`,
    [input.projectId, input.providerCompanyId, input.engagementId],
    runner
  );
  if (!row) throw new AppError('CONFLICT', 'Provider is already assigned to this project');
  return row;
}
