import type {
  AvailabilityWindow,
  ExistingAssignment,
  RoleRequirement,
  ScheduleAssignmentView,
  ScheduleResourceType,
  ScheduleStatus,
  VehicleView,
} from '@crewquo/shared';
import type { ShiftType } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * `vehicles`, `schedule_assignments`, `resource_availability` and
 * `project_role_requirements` (§31, `0047`).
 */

// ── Vehicles ─────────────────────────────────────────────────────────────────

interface VehicleRow {
  id: string;
  company_id: string;
  name: string;
  registration: string | null;
  category: string | null;
  fuel_type: string | null;
  emission_factor_activity: string | null;
  capacity_note: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toVehicle(row: VehicleRow): VehicleView {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    registration: row.registration,
    category: row.category,
    fuelType: row.fuel_type,
    emissionFactorActivity: row.emission_factor_activity,
    capacityNote: row.capacity_note,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const VEHICLE_COLS = `id, company_id, name, registration, category, fuel_type,
  emission_factor_activity, capacity_note, active, created_at, updated_at`;

export async function listVehicles(
  companyId: string,
  includeRetired: boolean,
  runner?: Queryable
): Promise<VehicleView[]> {
  const rows = await query<VehicleRow>(
    `select ${VEHICLE_COLS} from vehicles
      where company_id = $1 and ($2::boolean or active)
      order by active desc, name`,
    [companyId, includeRetired],
    runner
  );
  return rows.map(toVehicle);
}

export async function findVehicle(
  id: string,
  companyId: string,
  runner?: Queryable
): Promise<VehicleView | null> {
  const row = await queryOne<VehicleRow>(
    `select ${VEHICLE_COLS} from vehicles where id = $1 and company_id = $2`,
    [id, companyId],
    runner
  );
  return row ? toVehicle(row) : null;
}

export async function insertVehicle(
  input: {
    companyId: string;
    name: string;
    registration: string | null;
    category: string | null;
    fuelType: string | null;
    emissionFactorActivity: string | null;
    capacityNote: string | null;
    active: boolean;
  },
  runner?: Queryable
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into vehicles (company_id, name, registration, category, fuel_type,
                           emission_factor_activity, capacity_note, active)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [
      input.companyId,
      input.name,
      input.registration,
      input.category,
      input.fuelType,
      input.emissionFactorActivity,
      input.capacityNote,
      input.active,
    ],
    runner
  );
  return row!.id;
}

export async function updateVehicle(
  id: string,
  companyId: string,
  patch: Partial<{
    name: string;
    registration: string | null;
    category: string | null;
    fuelType: string | null;
    emissionFactorActivity: string | null;
    capacityNote: string | null;
    active: boolean;
  }>,
  runner?: Queryable
): Promise<void> {
  await query(
    `update vehicles set
       name = coalesce($3, name),
       registration = case when $4::boolean then $5 else registration end,
       category = case when $6::boolean then $7 else category end,
       fuel_type = case when $8::boolean then $9 else fuel_type end,
       emission_factor_activity = case when $10::boolean then $11 else emission_factor_activity end,
       capacity_note = case when $12::boolean then $13 else capacity_note end,
       active = coalesce($14, active),
       updated_at = now()
     where id = $1 and company_id = $2`,
    [
      id,
      companyId,
      patch.name ?? null,
      'registration' in patch,
      patch.registration ?? null,
      'category' in patch,
      patch.category ?? null,
      'fuelType' in patch,
      patch.fuelType ?? null,
      'emissionFactorActivity' in patch,
      patch.emissionFactorActivity ?? null,
      'capacityNote' in patch,
      patch.capacityNote ?? null,
      patch.active ?? null,
    ],
    runner
  );
}

/**
 * What stands in the way of deleting a vehicle.
 *
 * Counted so the refusal can name it, which is the pattern §3.3's locked rate cards
 * established and `countLocationReferences` generalised: a foreign key violation
 * reaching the caller as a 500 is not an explanation. `CANCELLED` assignments count
 * — they are retained records of a booking that was made, and deleting the van out
 * from under one would leave a row naming nothing.
 */
export async function countVehicleReferences(
  id: string,
  runner?: Queryable
): Promise<{ assignments: number; availability: number; activities: number }> {
  const row = await queryOne<{ a: string; b: string; c: string }>(
    `select
       (select count(*) from schedule_assignments where vehicle_id = $1)::int as a,
       (select count(*) from resource_availability where vehicle_id = $1)::int as b,
       (select count(*) from project_activities
          where vehicle_id = $1 and deleted_at is null)::int as c`,
    [id],
    runner
  );
  return {
    assignments: Number(row?.a ?? 0),
    availability: Number(row?.b ?? 0),
    activities: Number(row?.c ?? 0),
  };
}

export async function deleteVehicle(
  id: string,
  companyId: string,
  runner?: Queryable
): Promise<void> {
  await query(`delete from vehicles where id = $1 and company_id = $2`, [id, companyId], runner);
}

// ── Assignments ──────────────────────────────────────────────────────────────

interface AssignmentRow {
  id: string;
  company_id: string;
  project_id: string;
  project_name: string | null;
  resource_type: ScheduleResourceType;
  user_id: string | null;
  user_name: string | null;
  provider_company_id: string | null;
  provider_company_name: string | null;
  vehicle_id: string | null;
  vehicle_name: string | null;
  vehicle_registration: string | null;
  role_id: string | null;
  role_name: string | null;
  is_supervisor: boolean;
  headcount: number;
  starts_at: Date;
  ends_at: Date;
  location_id: string | null;
  location_name: string | null;
  shift_type: ShiftType | null;
  status: ScheduleStatus;
  notes: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const ASSIGNMENT_COLS = `a.id, a.company_id, a.project_id, p.name as project_name,
  a.resource_type, a.user_id, u.name as user_name,
  a.provider_company_id, pc.name as provider_company_name,
  a.vehicle_id, v.name as vehicle_name, v.registration as vehicle_registration,
  a.role_id, r.name as role_name, a.is_supervisor, a.headcount,
  a.starts_at, a.ends_at, a.location_id, l.name as location_name,
  a.shift_type, a.status, a.notes, a.created_by_user_id, a.created_at, a.updated_at`;

const ASSIGNMENT_FROM = `from schedule_assignments a
  left join projects p on p.id = a.project_id
  left join users u on u.id = a.user_id
  left join companies pc on pc.id = a.provider_company_id
  left join vehicles v on v.id = a.vehicle_id
  left join role_catalog r on r.id = a.role_id
  left join project_locations l on l.id = a.location_id`;

/**
 * `plannedCostCents`/`plannedSellCents` are filled in by the caller through the
 * rate engine, so this leaves them null with the reason that applies whatever the
 * cards say — packet finding 6's shape: a figure is withheld with a stated reason
 * rather than rendered as zero.
 */
function toAssignment(row: AssignmentRow): ScheduleAssignmentView {
  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    projectName: row.project_name,
    resourceType: row.resource_type,
    userId: row.user_id,
    userName: row.user_name,
    providerCompanyId: row.provider_company_id,
    providerCompanyName: row.provider_company_name,
    vehicleId: row.vehicle_id,
    vehicleName: row.vehicle_name,
    vehicleRegistration: row.vehicle_registration,
    roleId: row.role_id,
    roleName: row.role_name,
    isSupervisor: row.is_supervisor,
    headcount: row.headcount,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    locationId: row.location_id,
    locationName: row.location_name,
    shiftType: row.shift_type,
    status: row.status,
    notes: row.notes,
    plannedCostCents: null,
    plannedSellCents: null,
    plannedReason: null,
    compliance: null,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export { toAssignment };
export type { AssignmentRow };

/** A label for a resource, for a conflict message a person reads. */
export function resourceLabel(row: AssignmentRow): string | null {
  switch (row.resource_type) {
    case 'USER':
      return row.user_name;
    case 'VEHICLE':
      return row.vehicle_registration
        ? `${row.vehicle_name ?? 'Vehicle'} (${row.vehicle_registration})`
        : row.vehicle_name;
    case 'PROVIDER':
      return row.provider_company_name;
  }
}

export async function listProjectAssignments(args: {
  projectId: string;
  /** The owner sees every row; a provider sees only rows naming it or its people. */
  ownerScope: boolean;
  companyId: string;
  from?: string;
  to?: string;
  includeCancelled?: boolean;
  runner?: Queryable;
}): Promise<AssignmentRow[]> {
  return query<AssignmentRow>(
    `select ${ASSIGNMENT_COLS} ${ASSIGNMENT_FROM}
      where a.project_id = $1
        and ($2::boolean or a.provider_company_id = $3
             or a.user_id in (select user_id from memberships where company_id = $3))
        and ($4::timestamptz is null or a.ends_at > $4)
        and ($5::timestamptz is null or a.starts_at < $5)
        and ($6::boolean or a.status <> 'CANCELLED')
      order by a.starts_at, a.created_at`,
    [
      args.projectId,
      args.ownerScope,
      args.companyId,
      args.from ?? null,
      args.to ?? null,
      args.includeCancelled ?? false,
    ],
    args.runner
  );
}

/**
 * The company-wide planner's rows.
 *
 * Scoped by `company_id` — the scheduling company — rather than assembled from a
 * project list, and packet §10 explains why that is still the same boundary:
 * `schedule.manage` is owner-only, so every row this company scheduled is on a
 * project this company owns. There is deliberately no cross-company variant.
 */
export async function listCompanyAssignments(args: {
  companyId: string;
  from: string;
  to: string;
  projectId?: string;
  includeCancelled?: boolean;
  runner?: Queryable;
}): Promise<AssignmentRow[]> {
  return query<AssignmentRow>(
    `select ${ASSIGNMENT_COLS} ${ASSIGNMENT_FROM}
      where a.company_id = $1
        and a.ends_at > $2 and a.starts_at < $3
        and ($4::uuid is null or a.project_id = $4)
        and ($5::boolean or a.status <> 'CANCELLED')
      order by a.starts_at, a.created_at`,
    [args.companyId, args.from, args.to, args.projectId ?? null, args.includeCancelled ?? false],
    args.runner
  );
}

export async function findAssignmentRow(
  id: string,
  runner?: Queryable
): Promise<AssignmentRow | null> {
  return queryOne<AssignmentRow>(`select ${ASSIGNMENT_COLS} ${ASSIGNMENT_FROM} where a.id = $1`, [
    id,
  ], runner);
}

/**
 * Everything already booked for the resources a candidate names, in its window.
 *
 * **Company-wide rather than project-scoped**, which is the whole value of the
 * check: the clash Priya needs to see is Femi being on Marina Bay *and* Pier 9, and
 * a project-scoped query would miss every interesting case. `CANCELLED` rows are
 * excluded here as well as in `detectScheduleConflicts` — the pure function is the
 * authority and this is the index doing its job.
 */
export async function listOverlappingAssignments(args: {
  companyId: string;
  startsAt: string;
  endsAt: string;
  userId: string | null;
  vehicleId: string | null;
  providerCompanyId: string | null;
  runner?: Queryable;
}): Promise<ExistingAssignment[]> {
  const rows = await query<AssignmentRow>(
    `select ${ASSIGNMENT_COLS} ${ASSIGNMENT_FROM}
      where a.company_id = $1
        and a.status <> 'CANCELLED'
        and a.starts_at < $3 and a.ends_at > $2
        and (($4::uuid is not null and a.user_id = $4)
          or ($5::uuid is not null and a.vehicle_id = $5)
          or ($6::uuid is not null and a.provider_company_id = $6))`,
    [
      args.companyId,
      args.startsAt,
      args.endsAt,
      args.userId,
      args.vehicleId,
      args.providerCompanyId,
    ],
    args.runner
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    resourceLabel: resourceLabel(row),
    resourceType: row.resource_type,
    userId: row.user_id,
    providerCompanyId: row.provider_company_id,
    vehicleId: row.vehicle_id,
    headcount: row.headcount,
    status: row.status,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
  }));
}

export interface InsertAssignmentInput {
  companyId: string;
  projectId: string;
  resourceType: ScheduleResourceType;
  userId: string | null;
  providerCompanyId: string | null;
  vehicleId: string | null;
  roleId: string | null;
  isSupervisor: boolean;
  headcount: number;
  startsAt: string;
  endsAt: string;
  locationId: string | null;
  shiftType: ShiftType | null;
  status: ScheduleStatus;
  notes: string | null;
  batchClientId: string | null;
  createdByUserId: string;
}

export async function insertAssignment(
  input: InsertAssignmentInput,
  runner: Queryable
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into schedule_assignments
       (company_id, project_id, resource_type, user_id, provider_company_id, vehicle_id,
        role_id, is_supervisor, headcount, starts_at, ends_at, location_id, shift_type,
        status, notes, batch_client_id, created_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,$15,$16,$17)
     returning id`,
    [
      input.companyId,
      input.projectId,
      input.resourceType,
      input.userId,
      input.providerCompanyId,
      input.vehicleId,
      input.roleId,
      input.isSupervisor,
      input.headcount,
      input.startsAt,
      input.endsAt,
      input.locationId,
      input.shiftType,
      input.status,
      input.notes,
      input.batchClientId,
      input.createdByUserId,
    ],
    runner
  );
  return row!.id;
}

export async function updateAssignment(
  id: string,
  patch: Partial<{
    roleId: string | null;
    isSupervisor: boolean;
    headcount: number;
    startsAt: string;
    endsAt: string;
    locationId: string | null;
    shiftType: ShiftType | null;
    status: ScheduleStatus;
    notes: string | null;
  }>,
  runner: Queryable
): Promise<void> {
  await query(
    `update schedule_assignments set
       role_id = case when $2::boolean then $3 else role_id end,
       is_supervisor = coalesce($4, is_supervisor),
       headcount = coalesce($5, headcount),
       starts_at = coalesce($6::timestamptz, starts_at),
       ends_at = coalesce($7::timestamptz, ends_at),
       location_id = case when $8::boolean then $9 else location_id end,
       shift_type = case when $10::boolean then $11 else shift_type end,
       status = coalesce($12, status),
       notes = case when $13::boolean then $14 else notes end,
       updated_at = now()
     where id = $1`,
    [
      id,
      'roleId' in patch,
      patch.roleId ?? null,
      patch.isSupervisor ?? null,
      patch.headcount ?? null,
      patch.startsAt ?? null,
      patch.endsAt ?? null,
      'locationId' in patch,
      patch.locationId ?? null,
      'shiftType' in patch,
      patch.shiftType ?? null,
      patch.status ?? null,
      'notes' in patch,
      patch.notes ?? null,
    ],
    runner
  );
}

/** Rows written under one `batchClientId`, for the idempotent replay. */
export async function findBatch(
  companyId: string,
  batchClientId: string,
  runner?: Queryable
): Promise<AssignmentRow[]> {
  return query<AssignmentRow>(
    `select ${ASSIGNMENT_COLS} ${ASSIGNMENT_FROM}
      where a.company_id = $1 and a.batch_client_id = $2
      order by a.starts_at, a.created_at`,
    [companyId, batchClientId],
    runner
  );
}

// ── Availability ─────────────────────────────────────────────────────────────

interface AvailabilityRow {
  id: string;
  resource_type: ScheduleResourceType;
  user_id: string | null;
  provider_company_id: string | null;
  vehicle_id: string | null;
  kind: 'AVAILABLE' | 'UNAVAILABLE';
  headcount: number | null;
  note: string | null;
  starts_at: Date;
  ends_at: Date;
}

const AVAILABILITY_COLS = `id, resource_type, user_id, provider_company_id, vehicle_id,
  kind, headcount, note, starts_at, ends_at`;

function toAvailability(row: AvailabilityRow): AvailabilityWindow {
  return {
    id: row.id,
    resourceType: row.resource_type,
    userId: row.user_id,
    providerCompanyId: row.provider_company_id,
    vehicleId: row.vehicle_id,
    kind: row.kind,
    headcount: row.headcount,
    note: row.note,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
  };
}

export { toAvailability };

/**
 * Availability relevant to one candidate.
 *
 * Deliberately **not** scoped to the scheduling company: a provider's stated crew
 * count is a row on the *provider's* company, and the hiring company has to be able
 * to read it or §31's headcount warning could never fire. That is the one narrow
 * cross-company read this phase adds, and it is a number the provider chose to
 * state rather than their staff list (packet §10).
 */
export async function listRelevantAvailability(args: {
  startsAt: string;
  endsAt: string;
  userId: string | null;
  vehicleId: string | null;
  providerCompanyId: string | null;
  runner?: Queryable;
}): Promise<AvailabilityWindow[]> {
  const rows = await query<AvailabilityRow>(
    `select ${AVAILABILITY_COLS} from resource_availability
      where (($1::uuid is not null and user_id = $1)
          or ($2::uuid is not null and vehicle_id = $2)
          or ($3::uuid is not null and provider_company_id = $3))`,
    [args.userId, args.vehicleId, args.providerCompanyId],
    args.runner
  );
  return rows.map(toAvailability);
}

export async function listCompanyAvailability(
  companyId: string,
  runner?: Queryable
): Promise<AvailabilityWindow[]> {
  const rows = await query<AvailabilityRow>(
    `select ${AVAILABILITY_COLS} from resource_availability
      where company_id = $1 order by starts_at`,
    [companyId],
    runner
  );
  return rows.map(toAvailability);
}

export async function insertAvailability(
  input: {
    companyId: string;
    resourceType: ScheduleResourceType;
    userId: string | null;
    providerCompanyId: string | null;
    vehicleId: string | null;
    kind: 'AVAILABLE' | 'UNAVAILABLE';
    headcount: number | null;
    startsAt: string;
    endsAt: string;
    note: string | null;
    createdByUserId: string;
  },
  runner?: Queryable
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into resource_availability
       (company_id, resource_type, user_id, provider_company_id, vehicle_id, kind,
        headcount, starts_at, ends_at, note, created_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10,$11)
     returning id`,
    [
      input.companyId,
      input.resourceType,
      input.userId,
      input.providerCompanyId,
      input.vehicleId,
      input.kind,
      input.headcount,
      input.startsAt,
      input.endsAt,
      input.note,
      input.createdByUserId,
    ],
    runner
  );
  return row!.id;
}

export async function deleteAvailability(
  id: string,
  companyId: string,
  runner?: Queryable
): Promise<number> {
  const rows = await query<{ id: string }>(
    `delete from resource_availability where id = $1 and company_id = $2 returning id`,
    [id, companyId],
    runner
  );
  return rows.length;
}

// ── Role requirements ────────────────────────────────────────────────────────

interface RequirementRow {
  id: string;
  project_id: string;
  role_id: string;
  role_name: string | null;
  quantity: number;
  is_supervisor: boolean;
  starts_on: string | null;
  ends_on: string | null;
  notes: string | null;
}

export async function listRoleRequirements(
  projectId: string,
  runner?: Queryable
): Promise<RoleRequirement[]> {
  const rows = await query<RequirementRow>(
    `select q.id, q.project_id, q.role_id, r.name as role_name, q.quantity, q.is_supervisor,
            to_char(q.starts_on, 'YYYY-MM-DD') as starts_on,
            to_char(q.ends_on, 'YYYY-MM-DD') as ends_on, q.notes
       from project_role_requirements q
       left join role_catalog r on r.id = q.role_id
      where q.project_id = $1
      order by r.name nulls last, q.starts_on nulls first`,
    [projectId],
    runner
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    roleId: row.role_id,
    roleName: row.role_name,
    quantity: row.quantity,
    isSupervisor: row.is_supervisor,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    notes: row.notes,
  }));
}

/**
 * Replace the whole set for a project.
 *
 * A `PUT` for the reason a budget is one: requirements are a short list a person
 * edits together on one screen, and `project_role_requirements_unique_idx` makes
 * incremental adds hazardous — editing "2 × Rigger" by adding a second row rather
 * than changing the first silently doubles the requirement, and the indicator then
 * reports a shortfall nobody can clear.
 */
export async function replaceRoleRequirements(
  args: {
    projectId: string;
    companyId: string;
    userId: string;
    requirements: readonly {
      roleId: string;
      quantity: number;
      isSupervisor: boolean;
      startsOn: string | null;
      endsOn: string | null;
      notes: string | null;
    }[];
  },
  runner: Queryable
): Promise<void> {
  await query(`delete from project_role_requirements where project_id = $1`, [args.projectId], runner);
  for (const req of args.requirements) {
    await query(
      `insert into project_role_requirements
         (project_id, company_id, role_id, quantity, is_supervisor, starts_on, ends_on,
          notes, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9)`,
      [
        args.projectId,
        args.companyId,
        req.roleId,
        req.quantity,
        req.isSupervisor,
        req.startsOn,
        req.endsOn,
        req.notes,
        args.userId,
      ],
      runner
    );
  }
}

/** Assignments in the shape `unfilledRequirements` consumes. */
export async function listAssignmentsForRequirements(
  projectId: string,
  runner?: Queryable
): Promise<
  {
    roleId: string | null;
    resourceType: ScheduleResourceType;
    headcount: number;
    status: ScheduleStatus;
    startsAt: string;
    endsAt: string;
  }[]
> {
  const rows = await query<{
    role_id: string | null;
    resource_type: ScheduleResourceType;
    headcount: number;
    status: ScheduleStatus;
    starts_at: Date;
    ends_at: Date;
  }>(
    `select role_id, resource_type, headcount, status, starts_at, ends_at
       from schedule_assignments where project_id = $1`,
    [projectId],
    runner
  );
  return rows.map((row) => ({
    roleId: row.role_id,
    resourceType: row.resource_type,
    headcount: row.headcount,
    status: row.status,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
  }));
}

/** §31's prefill source for the diary, and the second half of `sources.schedule`. */
export async function listScheduledForDay(args: {
  projectId: string;
  companyId: string;
  entryDate: string;
  /** The project's effective zone — a day is a day *somewhere* (`time.md`). */
  timeZone: string;
  runner?: Queryable;
}): Promise<
  {
    userId: string | null;
    userName: string | null;
    providerCompanyId: string | null;
    roleId: string | null;
    roleName: string | null;
    headcount: number;
  }[]
> {
  const rows = await query<{
    user_id: string | null;
    user_name: string | null;
    provider_company_id: string | null;
    role_id: string | null;
    role_name: string | null;
    headcount: number;
  }>(
    /*
     * The day boundary is computed in the PROJECT'S zone, not the server's, which is
     * `time.md`'s rule: an assignment starting at 19:00 in Auckland is on a
     * different calendar day in UTC, and a prefill that offered it under the wrong
     * date would put a person on site the day before they were there.
     */
    `select a.user_id, u.name as user_name, a.provider_company_id,
            a.role_id, r.name as role_name, a.headcount
       from schedule_assignments a
       left join users u on u.id = a.user_id
       left join role_catalog r on r.id = a.role_id
      where a.project_id = $1
        and a.status <> 'CANCELLED'
        and (a.starts_at at time zone $3)::date <= $2::date
        and (a.ends_at   at time zone $3)::date >= $2::date
        and (a.provider_company_id = $4
             or a.user_id in (select user_id from memberships where company_id = $4))
      order by u.name nulls last, r.name nulls last`,
    [args.projectId, args.entryDate, args.timeZone, args.companyId],
    args.runner
  );
  return rows.map((row) => ({
    userId: row.user_id,
    userName: row.user_name,
    providerCompanyId: row.provider_company_id,
    roleId: row.role_id,
    roleName: row.role_name,
    headcount: row.headcount,
  }));
}

/** For the project rail and the delete refusal. */
export async function countProjectAssignments(
  projectId: string,
  runner?: Queryable
): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `select count(*)::int as n from schedule_assignments
      where project_id = $1 and status <> 'CANCELLED'`,
    [projectId],
    runner
  );
  return Number(row?.n ?? 0);
}
