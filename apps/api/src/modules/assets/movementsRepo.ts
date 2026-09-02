import {
  deriveOutcomeState,
  openMovements,
  type DestinationSemantics,
  type MovementRow as PolicyMovement,
  type MovementView,
  type OutcomeState,
} from '@crewquo/shared';
import type { Queryable } from '../../db';
import { query, queryOne } from '../../db';

/**
 * `asset_movements` (§25.4) — step 3 of the Phase 8 build order.
 *
 * Every function here that changes anything expects to be called inside a
 * transaction that already holds the asset's row lock. That is not a convention
 * this file can enforce and it is the one thing this module gets wrong if it is
 * ignored, so `lockAsset` is exported from here rather than from `repo.ts`: the
 * lock and the writes that need it live in one file, where the next person to add
 * a write path reads the reason before the signature.
 */

export interface MovementRow {
  id: string;
  asset_id: string;
  sequence: number;
  continues_movement_id: string | null;
  destination_type_id: string;
  destination_org_id: string | null;
  destination_address: string | null;
  from_location_id: string | null;
  quantity: string;
  weight_kg: string | null;
  moved_on: string;
  distance_km: string | null;
  document_id: string | null;
  notes: string | null;
  recorded_by_user_id: string | null;
  updated_by_user_id: string | null;
  revision: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;

  // Joined from `destination_types`. The semantics are what every metric filters
  // on, so they travel with the row rather than being looked up per movement.
  destination_code: string;
  destination_name: string;
  hierarchy_tier: number | null;
  counts_as_retained_in_use: boolean;
  counts_as_reuse: boolean;
  counts_as_recycling: boolean;
  counts_as_recovery: boolean;
  counts_as_landfill: boolean;
  counts_as_diverted: boolean;
  is_final_outcome: boolean;
  displaces_replacement: boolean;
  destination_org_name: string | null;
  /** Derived: is there a live movement continuing this one? */
  continued_by_id: string | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function selectFrom(source: string): string {
  return `select m.*,
                 d.code as destination_code,
                 d.name as destination_name,
                 d.hierarchy_tier,
                 d.counts_as_retained_in_use,
                 d.counts_as_reuse,
                 d.counts_as_recycling,
                 d.counts_as_recovery,
                 d.counts_as_landfill,
                 d.counts_as_diverted,
                 d.is_final_outcome,
                 d.displaces_replacement,
                 o.name as destination_org_name,
                 c.id as continued_by_id
            from ${source} m
            join destination_types d on d.id = m.destination_type_id
            left join destination_organisations o on o.id = m.destination_org_id
            left join asset_movements c
              on c.continues_movement_id = m.id and c.deleted_at is null`;
}

/* Re-exported from `@crewquo/shared` as of 8.6 — see the note in `repo.ts`. */
export type { MovementView };

export function toMovementView(
  row: MovementRow,
  line: { unitWeightKg: number | null }
): MovementView {
  const quantity = Number(row.quantity);
  const own = num(row.weight_kg);
  return {
    id: row.id,
    assetId: row.asset_id,
    sequence: row.sequence,
    continuesMovementId: row.continues_movement_id,
    continuedById: row.continued_by_id,
    isOpen: row.continued_by_id === null,
    destinationTypeId: row.destination_type_id,
    destinationCode: row.destination_code,
    destinationName: row.destination_name,
    hierarchyTier: row.hierarchy_tier,
    isFinalOutcome: row.is_final_outcome,
    destinationOrgId: row.destination_org_id,
    destinationOrgName: row.destination_org_name,
    destinationAddress: row.destination_address,
    fromLocationId: row.from_location_id,
    quantity,
    weightKg: own,
    effectiveWeightKg:
      own !== null ? own : line.unitWeightKg === null ? null : quantity * line.unitWeightKg,
    weightIsOverridden: own !== null,
    movedOn: row.moved_on,
    distanceKm: num(row.distance_km),
    documentId: row.document_id,
    notes: row.notes,
    recordedByUserId: row.recorded_by_user_id,
    revision: row.revision,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The shape `packages/shared`'s pure algebra works over. */
export function toPolicyMovement(row: MovementRow): PolicyMovement {
  return {
    id: row.id,
    continuesMovementId: row.continues_movement_id,
    quantity: Number(row.quantity),
    weightKg: num(row.weight_kg),
    destination: semanticsOf(row),
  };
}

export function semanticsOf(row: MovementRow): DestinationSemantics {
  return {
    code: row.destination_code,
    hierarchyTier: row.hierarchy_tier,
    countsAsRetainedInUse: row.counts_as_retained_in_use,
    countsAsReuse: row.counts_as_reuse,
    countsAsRecycling: row.counts_as_recycling,
    countsAsRecovery: row.counts_as_recovery,
    countsAsLandfill: row.counts_as_landfill,
    countsAsDiverted: row.counts_as_diverted,
    isFinalOutcome: row.is_final_outcome,
    displacesReplacement: row.displaces_replacement,
  };
}

/**
 * The asset row, locked, for a caller about to count movements against it.
 *
 * `money-boundary.md` §3's rule, reused rather than reinvented: two clerks
 * recording two movements each find room under the ceiling separately and exceed
 * it together, and the losing outcome is not an error — it is a mass balance that
 * does not balance, in the table the client report reads.
 *
 * Three shapes need it and all three are about this one row: the quantity
 * ceiling, the `sequence` allocation, and the `outcome_state` recompute. So the
 * asset is the lock for all of them, which also gives the recompute a consistent
 * read for free.
 */
export function lockAsset(
  id: string,
  runner: Queryable
): Promise<{
  id: string;
  project_id: string;
  company_id: string;
  quantity: string;
  unit_weight_kg: string | null;
  outcome_state: OutcomeState;
} | null> {
  return queryOne(
    `select id, project_id, company_id, quantity, unit_weight_kg, outcome_state
       from project_assets
      where id = $1 and deleted_at is null
      for update`,
    [id],
    runner
  );
}

export function listMovements(assetId: string, runner?: Queryable): Promise<MovementRow[]> {
  return query<MovementRow>(
    `${selectFrom('asset_movements')}
      where m.asset_id = $1 and m.deleted_at is null
      order by m.sequence`,
    [assetId],
    runner
  );
}

export function findMovement(id: string, runner?: Queryable): Promise<MovementRow | null> {
  return queryOne<MovementRow>(`${selectFrom('asset_movements')} where m.id = $1`, [id], runner);
}

export interface InsertMovement {
  assetId: string;
  continuesMovementId: string | null;
  destinationTypeId: string;
  destinationOrgId: string | null;
  destinationAddress: string | null;
  fromLocationId: string | null;
  quantity: number;
  weightKg: number | null;
  movedOn: string;
  distanceKm: number | null;
  documentId: string | null;
  notes: string | null;
  recordedByUserId: string | null;
}

/**
 * Insert, allocating `sequence` as `max + 1` inside the caller's lock.
 *
 * The subquery would be a check-then-act on its own; it is safe here only because
 * every caller holds the asset row. The `unique (asset_id, sequence)` index is the
 * belt: if a future write path forgets the lock, the loser gets an error rather
 * than a duplicate, which is a bad outcome to show a user and a much better one to
 * store.
 */
export async function insertMovement(
  input: InsertMovement,
  runner: Queryable
): Promise<MovementRow | null> {
  const row = await queryOne<{ id: string }>(
    `insert into asset_movements
       (asset_id, sequence, continues_movement_id, destination_type_id, destination_org_id,
        destination_address, from_location_id, quantity, weight_kg, moved_on, distance_km,
        document_id, notes, recorded_by_user_id)
     values ($1,
             (select coalesce(max(sequence), 0) + 1 from asset_movements where asset_id = $1),
             $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning id`,
    [
      input.assetId,
      input.continuesMovementId,
      input.destinationTypeId,
      input.destinationOrgId,
      input.destinationAddress,
      input.fromLocationId,
      input.quantity,
      input.weightKg,
      input.movedOn,
      input.distanceKm,
      input.documentId,
      input.notes,
      input.recordedByUserId,
    ],
    runner
  );
  if (!row) return null;
  return findMovement(row.id, runner);
}

export type MovementPatch = Partial<
  Pick<
    InsertMovement,
    | 'destinationTypeId'
    | 'destinationOrgId'
    | 'destinationAddress'
    | 'fromLocationId'
    | 'quantity'
    | 'weightKg'
    | 'movedOn'
    | 'distanceKm'
    | 'documentId'
    | 'notes'
  >
>;

const PATCH_COLUMNS: Record<keyof MovementPatch, string> = {
  destinationTypeId: 'destination_type_id',
  destinationOrgId: 'destination_org_id',
  destinationAddress: 'destination_address',
  fromLocationId: 'from_location_id',
  quantity: 'quantity',
  weightKg: 'weight_kg',
  movedOn: 'moved_on',
  distanceKm: 'distance_km',
  documentId: 'document_id',
  notes: 'notes',
};

export async function updateMovement(
  id: string,
  patch: MovementPatch,
  expectedRevision: number | undefined,
  updatedByUserId: string | null,
  runner: Queryable
): Promise<MovementRow | null> {
  const params: unknown[] = [id];
  const sets: string[] = [];
  for (const key of Object.keys(patch) as (keyof MovementPatch)[]) {
    params.push(patch[key]);
    sets.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
  }
  params.push(updatedByUserId);
  sets.push(`updated_by_user_id = $${params.length}`);

  let guard = '';
  if (expectedRevision !== undefined) {
    params.push(expectedRevision);
    guard = ` and revision = $${params.length}`;
  }

  const updated = await queryOne<{ id: string }>(
    `update asset_movements set ${sets.join(', ')}
      where id = $1 and deleted_at is null${guard}
      returning id`,
    params,
    runner
  );
  if (!updated) return null;
  return findMovement(id, runner);
}

export async function tombstoneMovement(
  id: string,
  runner: Queryable
): Promise<MovementRow | null> {
  const deleted = await queryOne<{ id: string }>(
    `update asset_movements set deleted_at = now()
      where id = $1 and deleted_at is null
      returning id`,
    [id],
    runner
  );
  if (!deleted) return null;
  return findMovement(id, runner);
}

/**
 * **The single writer of `outcome_state`.**
 *
 * §25.4 rule 2 makes it derived; storing it is what lets the "what still needs a
 * destination" screen have an index, since that index cannot exist over an
 * expression joining another table. A derived column with two writers is a
 * derived column that disagrees with itself, and a recompute path any caller may
 * skip is one that is wrong in production — so every movement insert, correction,
 * continuation and tombstone ends here, and nothing else touches the column.
 *
 * The caller holds the asset's lock, so the movements read here cannot move under
 * it. Returns the state it wrote, for the caller's response.
 */
export async function recomputeOutcomeState(
  assetId: string,
  lineQuantity: number,
  runner: Queryable
): Promise<OutcomeState> {
  const rows = await listMovements(assetId, runner);
  const open = openMovements(rows.map(toPolicyMovement));

  let allocated = 0;
  let inStorage = 0;
  for (const m of open) {
    if (m.destination.isFinalOutcome) allocated += m.quantity;
    else inStorage += m.quantity;
  }

  const state = deriveOutcomeState(lineQuantity, allocated, inStorage);
  await query(
    `update project_assets set outcome_state = $2 where id = $1 and outcome_state is distinct from $2`,
    [assetId, state],
    runner
  );
  return state;
}

// ── Destination catalogs and organisations ───────────────────────────────────

export interface DestinationTypeRow {
  id: string;
  company_id: string | null;
  code: string;
  name: string;
  hierarchy_tier: number | null;
  counts_as_retained_in_use: boolean;
  counts_as_reuse: boolean;
  counts_as_recycling: boolean;
  counts_as_recovery: boolean;
  counts_as_landfill: boolean;
  counts_as_diverted: boolean;
  is_final_outcome: boolean;
  displaces_replacement: boolean;
  ghg_treatment_key: string | null;
  sort_order: number;
  active: boolean;
}

/** System rows plus this company's own, for `resolveTypeCatalog` to shadow. */
export function listDestinationTypes(
  companyId: string,
  runner?: Queryable
): Promise<DestinationTypeRow[]> {
  return query<DestinationTypeRow>(
    `select * from destination_types
      where active and (company_id is null or company_id = $1)
      order by hierarchy_tier nulls last, sort_order`,
    [companyId],
    runner
  );
}

export function findUsableDestinationType(
  id: string,
  companyId: string,
  runner?: Queryable
): Promise<DestinationTypeRow | null> {
  return queryOne<DestinationTypeRow>(
    `select * from destination_types
      where id = $1 and active and (company_id is null or company_id = $2)`,
    [id, companyId],
    runner
  );
}

export interface DestinationOrgRow {
  id: string;
  company_id: string;
  linked_company_id: string | null;
  name: string;
  kind: string;
  address: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  licence_number: string | null;
  licence_expires_on: string | null;
  notes: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export function listDestinationOrgs(
  companyId: string,
  includeInactive: boolean,
  runner?: Queryable
): Promise<DestinationOrgRow[]> {
  return query<DestinationOrgRow>(
    `select * from destination_organisations
      where company_id = $1 ${includeInactive ? '' : 'and active'}
      order by name`,
    [companyId],
    runner
  );
}

export function findDestinationOrg(
  id: string,
  companyId: string,
  runner?: Queryable
): Promise<DestinationOrgRow | null> {
  return queryOne<DestinationOrgRow>(
    `select * from destination_organisations where id = $1 and company_id = $2`,
    [id, companyId],
    runner
  );
}
