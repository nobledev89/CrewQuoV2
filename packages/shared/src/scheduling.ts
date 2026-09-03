import { z } from 'zod';
import { shiftTypeSchema, type ShiftType } from './enums';

/**
 * Crew scheduling (CREWQUO_V2_PLAN.md §31) — step 11.0 of the Phase 11 build order
 * in `docs/operating-model/commercial-operations.md` §14.
 *
 * The pure half: window arithmetic, conflict detection and the unfilled-requirement
 * calculation. Every rule §31 states as prose is a total function here with a unit
 * test, which is the rate-engine lesson applied for the fourth time — the pure core
 * is where correctness is cheap.
 *
 * ── CONFLICTS ARE WARNINGS AND THERE IS NO PATH FROM ONE TO A REFUSAL ───────
 *
 * §31: *"Conflict detection is a warning, not a block — overlapping assignments for
 * the same user or vehicle are surfaced at save time with the clash named.
 * `CANCELLED` rows never conflict."*
 *
 * This is enforced structurally rather than by discipline (packet §13.5).
 * `detectScheduleConflicts` returns warnings and nothing else; it has no error
 * type, no boolean, and no caller can turn its result into a 422 without writing
 * that code deliberately. The reason it matters is not squeamishness about
 * blocking: **the double-booking is sometimes the plan**, because the job at Pier 9
 * finishes at noon and the schedule does not know that.
 */

// ── Resources ────────────────────────────────────────────────────────────────

export const SCHEDULE_RESOURCE_TYPES = ['USER', 'PROVIDER', 'VEHICLE'] as const;
export const scheduleResourceTypeSchema = z.enum(SCHEDULE_RESOURCE_TYPES);
export type ScheduleResourceType = z.infer<typeof scheduleResourceTypeSchema>;

export const SCHEDULE_STATUSES = ['PLANNED', 'CONFIRMED', 'CANCELLED'] as const;
export const scheduleStatusSchema = z.enum(SCHEDULE_STATUSES);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

export const SCHEDULE_VIEWS = ['DAY', 'WEEK', 'MONTH'] as const;
export const scheduleViewSchema = z.enum(SCHEDULE_VIEWS);
export type ScheduleView = z.infer<typeof scheduleViewSchema>;

// ── Windows ──────────────────────────────────────────────────────────────────

export interface Window {
  /** ISO instant. */
  startsAt: string;
  endsAt: string;
}

/**
 * Do two half-open intervals overlap?
 *
 * **Half-open on purpose.** A shift ending at 17:00 and one starting at 17:00 are
 * back-to-back, not a clash, and treating them as one would warn on every ordinary
 * day-then-night handover — which is how a warning channel gets ignored. So the
 * comparison is strict at both ends: `a.start < b.end && b.start < a.end`.
 */
export function windowsOverlap(a: Window, b: Window): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

/** The overlapping part, as ISO instants, or null when they do not overlap. */
export function windowIntersection(a: Window, b: Window): Window | null {
  if (!windowsOverlap(a, b)) return null;
  return {
    startsAt: a.startsAt > b.startsAt ? a.startsAt : b.startsAt,
    endsAt: a.endsAt < b.endsAt ? a.endsAt : b.endsAt,
  };
}

// ── Availability (§31, packet finding 7) ─────────────────────────────────────

export const AVAILABILITY_KINDS = ['AVAILABLE', 'UNAVAILABLE'] as const;
export const availabilityKindSchema = z.enum(AVAILABILITY_KINDS);
export type AvailabilityKind = z.infer<typeof availabilityKindSchema>;

/**
 * One availability window.
 *
 * §31 describes availability as *per-user*, and one table serves all three resource
 * types instead — packet finding 7. The same paragraph's other rule needs an
 * availability for a **company** (*"only warns when headcount exceeds a stated
 * availability"*), and a vehicle off the road for a service should not need a third
 * table. With one table the headcount warning is the same comparison as the other
 * two rather than a special case somewhere else in the code.
 *
 * There is deliberately **no `reason` column** (packet §7). "Unavailable, Thursday
 * afternoons" is frequently a medical appointment, and a field for the reason is a
 * field somebody writes it in.
 */
export interface AvailabilityWindow extends Window {
  id: string;
  resourceType: ScheduleResourceType;
  userId: string | null;
  providerCompanyId: string | null;
  vehicleId: string | null;
  kind: AvailabilityKind;
  /**
   * PROVIDER rows only: how many crew this subcontractor has stated it can supply
   * in this window. Null on USER and VEHICLE rows, where the resource is one thing.
   */
  headcount: number | null;
  note: string | null;
}

// ── Conflicts ────────────────────────────────────────────────────────────────

export const SCHEDULE_CONFLICT_CODES = [
  'USER_OVERLAP',
  'VEHICLE_OVERLAP',
  'OUTSIDE_AVAILABILITY',
  'UNAVAILABLE_WINDOW',
  'PROVIDER_HEADCOUNT',
] as const;
export type ScheduleConflictCode = (typeof SCHEDULE_CONFLICT_CODES)[number];

export interface ScheduleConflict {
  code: ScheduleConflictCode;
  /** The other assignment, where there is one. */
  otherAssignmentId: string | null;
  otherProjectId: string | null;
  otherProjectName: string | null;
  /** Rendered by the server so every client says it identically. */
  message: string;
}

/** The shape `detectScheduleConflicts` compares against. */
export interface ScheduleCandidate extends Window {
  /** Absent on a create, present on a move — so a row never clashes with itself. */
  id: string | null;
  resourceType: ScheduleResourceType;
  userId: string | null;
  providerCompanyId: string | null;
  vehicleId: string | null;
  headcount: number;
  status: ScheduleStatus;
}

export interface ExistingAssignment extends ScheduleCandidate {
  id: string;
  projectId: string;
  projectName: string | null;
  resourceLabel: string | null;
}

/**
 * Every clash `candidate` has with what is already booked.
 *
 * Pure and total, so §31's four rules are unit tests rather than fixtures. The
 * caller loads the assignments overlapping the candidate's window for the resources
 * it names — a bounded query — and passes them in.
 *
 * The rules, in the order §31 states them:
 *
 *  1. **Same user, overlapping window** → `USER_OVERLAP`.
 *  2. **Same vehicle, overlapping window** → `VEHICLE_OVERLAP`.
 *  3. **`CANCELLED` never conflicts**, on either side. A cancelled row is retained
 *     as the answer to *"was Femi ever booked on Marina Bay that week?"*, and a
 *     retained row that still blocks is a delete with extra steps.
 *  4. **A provider is not double-booked by overlapping**, because *"deliberate
 *     double-booking of a subcontractor's company is normal"*. It warns only when
 *     the total headcount across overlapping rows exceeds what that subcontractor
 *     stated it can supply — which is why availability had to cover a company
 *     (finding 7).
 *
 * Plus availability, which §31 names in the same paragraph:
 *
 *  5. A resource with **any** `AVAILABLE` window and an assignment covered by none
 *     of them → `OUTSIDE_AVAILABILITY`. A resource with no `AVAILABLE` windows at
 *     all is treated as always available: an empty availability table must not warn
 *     on every row in the product, which is the state every existing company is in.
 *  6. An assignment overlapping an `UNAVAILABLE` window → `UNAVAILABLE_WINDOW`.
 */
export function detectScheduleConflicts(args: {
  candidate: ScheduleCandidate;
  existing: readonly ExistingAssignment[];
  availability: readonly AvailabilityWindow[];
}): ScheduleConflict[] {
  const { candidate } = args;
  const conflicts: ScheduleConflict[] = [];

  // Rule 3, the candidate's own half. Cancelling a row cannot produce warnings.
  if (candidate.status === 'CANCELLED') return conflicts;

  const live = args.existing.filter((e) => e.status !== 'CANCELLED' && e.id !== candidate.id);

  // Rules 1 and 2 — the same comparison for two columns.
  for (const [key, code] of [
    ['userId', 'USER_OVERLAP'],
    ['vehicleId', 'VEHICLE_OVERLAP'],
  ] as const) {
    const mine = candidate[key];
    if (mine === null) continue;
    for (const other of live) {
      if (other[key] !== mine) continue;
      if (!windowsOverlap(candidate, other)) continue;
      const where = other.projectName ?? 'another project';
      conflicts.push({
        code,
        otherAssignmentId: other.id,
        otherProjectId: other.projectId,
        otherProjectName: other.projectName,
        message:
          `${other.resourceLabel ?? (code === 'USER_OVERLAP' ? 'This person' : 'This vehicle')} is ` +
          `also booked on ${where} from ${other.startsAt} to ${other.endsAt}.`,
      });
    }
  }

  // Rule 4 — a provider warns on capacity, never on overlap.
  if (candidate.resourceType === 'PROVIDER' && candidate.providerCompanyId !== null) {
    const stated = statedHeadcount(args.availability, candidate);
    if (stated !== null) {
      const booked = live
        .filter(
          (e) =>
            e.providerCompanyId === candidate.providerCompanyId && windowsOverlap(candidate, e)
        )
        .reduce((sum, e) => sum + e.headcount, 0);
      const total = booked + candidate.headcount;
      if (total > stated) {
        conflicts.push({
          code: 'PROVIDER_HEADCOUNT',
          otherAssignmentId: null,
          otherProjectId: null,
          otherProjectName: null,
          message:
            `This subcontractor has stated ${stated} crew available in this window and ` +
            `${total} would now be booked${booked > 0 ? ` (${booked} already elsewhere)` : ''}.`,
        });
      }
    }
  }

  // Rules 5 and 6.
  const windows = args.availability.filter((w) => matchesResource(w, candidate));
  const availableWindows = windows.filter((w) => w.kind === 'AVAILABLE');
  const unavailable = windows.filter((w) => w.kind === 'UNAVAILABLE');

  for (const window of unavailable) {
    if (!windowsOverlap(candidate, window)) continue;
    conflicts.push({
      code: 'UNAVAILABLE_WINDOW',
      otherAssignmentId: null,
      otherProjectId: null,
      otherProjectName: null,
      message:
        `This resource is marked unavailable from ${window.startsAt} to ${window.endsAt}.`,
    });
  }

  if (availableWindows.length > 0) {
    const covered = availableWindows.some(
      (w) => w.startsAt <= candidate.startsAt && candidate.endsAt <= w.endsAt
    );
    if (!covered) {
      conflicts.push({
        code: 'OUTSIDE_AVAILABILITY',
        otherAssignmentId: null,
        otherProjectId: null,
        otherProjectName: null,
        message:
          'This assignment falls outside every availability window recorded for this resource.',
      });
    }
  }

  return conflicts;
}

function matchesResource(w: AvailabilityWindow, c: ScheduleCandidate): boolean {
  if (w.resourceType !== c.resourceType) return false;
  switch (c.resourceType) {
    case 'USER':
      return c.userId !== null && w.userId === c.userId;
    case 'VEHICLE':
      return c.vehicleId !== null && w.vehicleId === c.vehicleId;
    case 'PROVIDER':
      return c.providerCompanyId !== null && w.providerCompanyId === c.providerCompanyId;
  }
}

/**
 * The smallest headcount stated for a window overlapping the candidate.
 *
 * The **smallest** rather than the sum, because two overlapping statements of
 * availability are two answers about the same crew ("4 this month, 2 the week of
 * the 14th"), not eight people. Null when the subcontractor has stated nothing, in
 * which case §31's headcount rule has no number to compare against and stays quiet.
 */
function statedHeadcount(
  availability: readonly AvailabilityWindow[],
  candidate: ScheduleCandidate
): number | null {
  let smallest: number | null = null;
  for (const w of availability) {
    if (w.kind !== 'AVAILABLE') continue;
    if (!matchesResource(w, candidate)) continue;
    if (!windowsOverlap(candidate, w)) continue;
    if (w.headcount === null) continue;
    if (smallest === null || w.headcount < smallest) smallest = w.headcount;
  }
  return smallest;
}

// ── Role requirements (§31, packet finding 7) ────────────────────────────────

export interface RoleRequirement {
  id: string;
  projectId: string;
  roleId: string;
  roleName: string | null;
  quantity: number;
  isSupervisor: boolean;
  /** ISO calendar dates. Null means the whole project. */
  startsOn: string | null;
  endsOn: string | null;
  notes: string | null;
}

export interface RequirementShortfall {
  requirementId: string;
  roleId: string;
  roleName: string | null;
  required: number;
  filled: number;
  short: number;
  startsOn: string | null;
  endsOn: string | null;
}

/**
 * §31's unfilled-requirement indicator.
 *
 * *"2 × Rigger, 1 × Supervisor, Mon–Wed"* against what is actually booked. A
 * requirement whose window is null covers the whole project, which is the common
 * case for a small job and is why the dates are nullable.
 *
 * `PROVIDER` rows count their `headcount` and `USER` rows count one, so *"4 crew
 * from Pashe"* fills four riggers — which is the whole reason §31 gave the column
 * to provider rows. `CANCELLED` rows fill nothing.
 *
 * Only shortfalls are returned. A requirement that is met needs no row, and a
 * screen listing ten satisfied requirements to communicate one gap is a screen
 * nobody reads.
 */
export function unfilledRequirements(args: {
  requirements: readonly RoleRequirement[];
  assignments: readonly {
    roleId: string | null;
    resourceType: ScheduleResourceType;
    headcount: number;
    status: ScheduleStatus;
    /** ISO instants; compared as calendar days against the requirement window. */
    startsAt: string;
    endsAt: string;
  }[];
}): RequirementShortfall[] {
  const out: RequirementShortfall[] = [];
  for (const req of args.requirements) {
    let filled = 0;
    for (const a of args.assignments) {
      if (a.status === 'CANCELLED') continue;
      if (a.roleId !== req.roleId) continue;
      if (!dateWindowOverlaps(a, req)) continue;
      filled += a.resourceType === 'PROVIDER' ? a.headcount : 1;
    }
    if (filled < req.quantity) {
      out.push({
        requirementId: req.id,
        roleId: req.roleId,
        roleName: req.roleName,
        required: req.quantity,
        filled,
        short: req.quantity - filled,
        startsOn: req.startsOn,
        endsOn: req.endsOn,
      });
    }
  }
  return out;
}

/**
 * Does an assignment's instant range touch a requirement's calendar window?
 *
 * The instants are sliced to their date prefix rather than parsed, which is
 * `time.md`'s rule showing up in a comparison: a requirement is stated in calendar
 * days ("Mon–Wed") and an assignment in instants, and converting the instant to a
 * day needs a zone. Comparing date *prefixes* of the stored ISO strings compares
 * them in whatever zone the caller serialised them in, which for a schedule the
 * server rendered is the project's — and it never silently moves a Tuesday-evening
 * shift into Wednesday because the server is in UTC and the site is in Auckland.
 */
function dateWindowOverlaps(
  a: { startsAt: string; endsAt: string },
  req: { startsOn: string | null; endsOn: string | null }
): boolean {
  if (req.startsOn === null && req.endsOn === null) return true;
  const from = a.startsAt.slice(0, 10);
  const to = a.endsAt.slice(0, 10);
  if (req.endsOn !== null && from > req.endsOn) return false;
  if (req.startsOn !== null && to < req.startsOn) return false;
  return true;
}

// ── Views ────────────────────────────────────────────────────────────────────

export interface VehicleView {
  id: string;
  companyId: string;
  name: string;
  registration: string | null;
  category: string | null;
  fuelType: string | null;
  /** The factor `activity` an admin mapped it to (§26) — read by Phase 9's engine. */
  emissionFactorActivity: string | null;
  capacityNote: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleAssignmentView {
  id: string;
  companyId: string;
  projectId: string;
  projectName: string | null;
  resourceType: ScheduleResourceType;
  userId: string | null;
  userName: string | null;
  providerCompanyId: string | null;
  providerCompanyName: string | null;
  vehicleId: string | null;
  vehicleName: string | null;
  vehicleRegistration: string | null;
  roleId: string | null;
  roleName: string | null;
  isSupervisor: boolean;
  headcount: number;
  startsAt: string;
  endsAt: string;
  locationId: string | null;
  locationName: string | null;
  /**
   * **Packet finding 6.** §31 asks for planned labour cost through the rate engine,
   * and every rate the engine resolves is keyed on a `ShiftType` — which an
   * assignment's `starts_at`/`ends_at` do not carry. Deriving `NIGHT` from an hour
   * would put a rate rule back in code eleven phases after the owner had the
   * `FRI_SAT_NIGHT` branch taken out of `resolveRateLabel`.
   *
   * So it is stated, nullable, and a planned cost exists only when it is set.
   */
  shiftType: ShiftType | null;
  status: ScheduleStatus;
  notes: string | null;
  /**
   * Planned PAY/BILL for this assignment, resolved through the rate engine.
   *
   * **Null with a reason rather than zero** — the same rule
   * `resolveBillCentsForLog` already follows for a missing BILL card, and the same
   * rule `budgets.ts` applies to a missing actual. `plannedReason` says which of the
   * three reasons it is: no shift type, no role, or no card covering them.
   */
  plannedCostCents: number | null;
  plannedSellCents: number | null;
  plannedReason: string | null;
  /** Phase 12's visible provider flag; null for people and vehicles. */
  compliance: {
    status: import('./compliance').ComplianceOverallStatus;
    warning: string | null;
    enforced: boolean;
  } | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A write's response: the rows, and every clash they produced. */
export interface ScheduleWriteResult {
  assignments: ScheduleAssignmentView[];
  /** §31's *"surfaced at save time with the clash named"*. Never a refusal. */
  warnings: { assignmentId: string; conflicts: ScheduleConflict[] }[];
  replayed: boolean;
}

// ── Request schemas ──────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const instant = z.string().datetime({ offset: true });

export const createVehicleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  registration: z.string().trim().max(30).nullable().default(null),
  category: z.string().trim().max(120).nullable().default(null),
  fuelType: z.string().trim().max(60).nullable().default(null),
  emissionFactorActivity: z.string().trim().max(120).nullable().default(null),
  capacityNote: z.string().trim().max(300).nullable().default(null),
  active: z.boolean().default(true),
});
export type CreateVehicle = z.infer<typeof createVehicleSchema>;

export const updateVehicleSchema = createVehicleSchema.partial();
export type UpdateVehicle = z.infer<typeof updateVehicleSchema>;

/**
 * One assignment as a caller states it.
 *
 * The resource discriminator is checked here rather than in a route so the rule is
 * one place: exactly one of the three id columns is set, and it is the one
 * `resourceType` names. A row with a `userId` and `resourceType: 'VEHICLE'` would
 * otherwise be stored, conflict against nothing, and be invisible in both views.
 */
export const scheduleAssignmentInputSchema = z
  .object({
    resourceType: scheduleResourceTypeSchema,
    userId: z.string().uuid().nullable().default(null),
    providerCompanyId: z.string().uuid().nullable().default(null),
    vehicleId: z.string().uuid().nullable().default(null),
    roleId: z.string().uuid().nullable().default(null),
    isSupervisor: z.boolean().default(false),
    headcount: z.number().int().min(1).max(500).default(1),
    startsAt: instant,
    endsAt: instant,
    locationId: z.string().uuid().nullable().default(null),
    shiftType: shiftTypeSchema.nullable().default(null),
    status: scheduleStatusSchema.default('PLANNED'),
    notes: z.string().trim().max(1000).nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.endsAt <= v.startsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'An assignment must end after it starts',
      });
    }
    const named = {
      USER: v.userId,
      PROVIDER: v.providerCompanyId,
      VEHICLE: v.vehicleId,
    }[v.resourceType];
    if (named === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [v.resourceType === 'USER' ? 'userId' : v.resourceType === 'PROVIDER' ? 'providerCompanyId' : 'vehicleId'],
        message: `A ${v.resourceType} assignment must name its ${v.resourceType.toLowerCase()}`,
      });
    }
    const others = [v.userId, v.providerCompanyId, v.vehicleId].filter((x) => x !== null).length;
    if (others > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resourceType'],
        message: 'An assignment names one resource. Book the van as its own row.',
      });
    }
    if (v.resourceType !== 'PROVIDER' && v.headcount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headcount'],
        // A headcount of 3 on a named person is a row that fills three requirement
        // slots with one human, which is the arithmetic §31's indicator depends on.
        message: 'Only a PROVIDER row carries a headcount — a person and a van are one each',
      });
    }
  });
export type ScheduleAssignmentInput = z.infer<typeof scheduleAssignmentInputSchema>;

/**
 * A batch, because Priya's Monday morning is one act of eleven rows (packet §5).
 *
 * `batchClientId` keys the single outbox event **and** the idempotency ledger, the
 * way `project_evidence.batch_client_id` already does — so a retry produces the
 * same eleven rows rather than twenty-two, and the assigned crews get one
 * notification rather than eleven.
 */
export const createScheduleSchema = z.object({
  batchClientId: z.string().uuid().optional(),
  assignments: z.array(scheduleAssignmentInputSchema).min(1).max(200),
});
export type CreateSchedule = z.infer<typeof createScheduleSchema>;

export const updateScheduleAssignmentSchema = z
  .object({
    roleId: z.string().uuid().nullable(),
    isSupervisor: z.boolean(),
    headcount: z.number().int().min(1).max(500),
    startsAt: instant,
    endsAt: instant,
    locationId: z.string().uuid().nullable(),
    shiftType: shiftTypeSchema.nullable(),
    status: scheduleStatusSchema,
    notes: z.string().trim().max(1000).nullable(),
  })
  .partial()
  .superRefine((v, ctx) => {
    if (v.startsAt !== undefined && v.endsAt !== undefined && v.endsAt <= v.startsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'An assignment must end after it starts',
      });
    }
  });
export type UpdateScheduleAssignment = z.infer<typeof updateScheduleAssignmentSchema>;

export const listScheduleQuerySchema = z.object({
  from: instant.optional(),
  to: instant.optional(),
  view: scheduleViewSchema.optional(),
  includeCancelled: z.boolean().optional(),
});
export type ListScheduleQuery = z.infer<typeof listScheduleQuerySchema>;

export const availabilityInputSchema = z
  .object({
    resourceType: scheduleResourceTypeSchema,
    userId: z.string().uuid().nullable().default(null),
    providerCompanyId: z.string().uuid().nullable().default(null),
    vehicleId: z.string().uuid().nullable().default(null),
    kind: availabilityKindSchema.default('AVAILABLE'),
    headcount: z.number().int().min(0).max(5000).nullable().default(null),
    startsAt: instant,
    endsAt: instant,
    note: z.string().trim().max(300).nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.endsAt <= v.startsAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'End after start' });
    }
    if (v.resourceType !== 'PROVIDER' && v.headcount !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headcount'],
        message: 'Only a subcontractor states a crew count',
      });
    }
  });
export type AvailabilityInput = z.infer<typeof availabilityInputSchema>;

export const roleRequirementInputSchema = z
  .object({
    roleId: z.string().uuid(),
    quantity: z.number().int().min(1).max(500),
    isSupervisor: z.boolean().default(false),
    startsOn: isoDate.nullable().default(null),
    endsOn: isoDate.nullable().default(null),
    notes: z.string().trim().max(300).nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.startsOn !== null && v.endsOn !== null && v.endsOn < v.startsOn) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsOn'], message: 'End on or after start' });
    }
  });
export type RoleRequirementInput = z.infer<typeof roleRequirementInputSchema>;

/** `PUT` — the whole set for a project, for the reason a budget is a `PUT`. */
export const setRoleRequirementsSchema = z.object({
  requirements: z.array(roleRequirementInputSchema).max(100),
});
export type SetRoleRequirements = z.infer<typeof setRoleRequirementsSchema>;

// ── View windows ─────────────────────────────────────────────────────────────

/**
 * The instants a day/week/month view covers, from a date and a zone offset.
 *
 * Kept pure and offset-based rather than reaching for `Intl`: the caller already
 * knows the project's effective zone (`projects.effectiveTimeZone`, resolved on
 * read since Phase 6) and the browser already renders in it. What this exists for
 * is that **a week is not seven times a day when a DST boundary is inside it**, and
 * a planner that silently loses an hour on the last Sunday in October drops the
 * assignments in it.
 *
 * `weekStartsOn` is a parameter with no default for the same reason
 * `resolveRateLabel` takes its rules as a required argument: a Monday-start week is
 * a convention, not a fact, and the one place it may be decided is a caller that
 * knows whose week it is.
 */
export function scheduleWindow(args: {
  view: ScheduleView;
  /** Anchor date, YYYY-MM-DD. */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekStartsOn: number;
}): { fromDate: string; toDate: string } {
  const [y = 1970, m = 1, d = 1] = args.date.split('-').map(Number);
  const anchor = Date.UTC(y, m - 1, d);
  const day = new Date(anchor).getUTCDay();

  if (args.view === 'DAY') {
    return { fromDate: iso(anchor), toDate: iso(anchor + DAY) };
  }
  if (args.view === 'WEEK') {
    const back = (day - args.weekStartsOn + 7) % 7;
    const start = anchor - back * DAY;
    return { fromDate: iso(start), toDate: iso(start + 7 * DAY) };
  }
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1);
  return { fromDate: iso(start), toDate: iso(end) };
}

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
