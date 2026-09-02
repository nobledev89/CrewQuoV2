import {
  isEstimatedConfidence,
  type AssetCondition,
  type AssetCategory,
  type OutcomeState,
  type TrackingMode,
  type WeightBasis,
  type WeightConfidence,
  type WeightSource,
} from '@crewquo/shared';
import type { Queryable } from '../../db';
import { query, queryOne } from '../../db';

/**
 * `project_assets` (§25.2, §25.3) — step 2 of the Phase 8 build order.
 *
 * Postgres returns `numeric` as a string, so every mass and quantity crosses this
 * boundary through `num()` and nothing below it ever sees one. That is the whole
 * of §41.9's "full precision internally" at this layer: the string is exact, the
 * `Number` is a double, and rounding happens once, later, in `formatMassKg`.
 */

export interface AssetRow {
  id: string;
  project_id: string;
  company_id: string;
  asset_type_id: string;
  tracking_mode: TrackingMode;
  description: string | null;
  quantity: string;
  weight_basis: WeightBasis | null;
  unit_weight_kg: string | null;
  total_weight_kg: string | null;
  weight_source: WeightSource | null;
  weight_confidence: WeightConfidence | null;
  weight_is_estimated: boolean;
  weight_document_id: string | null;
  weighed_by_user_id: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  material_composition: unknown;
  condition: AssetCondition | null;
  origin_location_id: string | null;
  outcome_state: OutcomeState;
  notes: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  batch_client_id: string | null;
  revision: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;

  // Joined, never stored — the same shape `documents.ts` uses for `supersededById`.
  type_code: string;
  type_name: string;
  type_category: AssetCategory;
  weight_document_superseded_by_id: string | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * The one select every read goes through.
 *
 * `weight_document_superseded_by_id` is a LEFT JOIN rather than a column, and it
 * is the packet's finding 5 made visible: a `DOCUMENTED` weight whose weighbridge
 * ticket has since been re-issued still cites the version the weigher read, and
 * the screen has to be able to say so. Stored as a flag it would be a second
 * answer to a question the chain already answers, and the two would disagree the
 * first time a successor was retracted.
 */
function selectFrom(source: string): string {
  return `select a.*,
                 t.code as type_code,
                 t.name as type_name,
                 t.category as type_category,
                 s.id as weight_document_superseded_by_id
            from ${source} a
            join asset_types t on t.id = a.asset_type_id
            left join project_documents s
              on s.supersedes_id = a.weight_document_id and s.deleted_at is null`;
}

export interface AssetView {
  id: string;
  projectId: string;
  companyId: string;
  assetTypeId: string;
  assetTypeCode: string;
  assetTypeName: string;
  assetTypeCategory: AssetCategory;
  trackingMode: TrackingMode;
  description: string | null;
  quantity: number;
  weightBasis: WeightBasis | null;
  unitWeightKg: number | null;
  totalWeightKg: number | null;
  weightSource: WeightSource | null;
  weightConfidence: WeightConfidence | null;
  weightIsEstimated: boolean;
  weightDocumentId: string | null;
  /** True when the cited document has been re-issued since. Derived, never stored. */
  weightDocumentSuperseded: boolean;
  weighedByUserId: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  assetTag: string | null;
  condition: AssetCondition | null;
  originLocationId: string | null;
  outcomeState: OutcomeState;
  notes: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  batchClientId: string | null;
  revision: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toAssetView(row: AssetRow): AssetView {
  return {
    id: row.id,
    projectId: row.project_id,
    companyId: row.company_id,
    assetTypeId: row.asset_type_id,
    assetTypeCode: row.type_code,
    assetTypeName: row.type_name,
    assetTypeCategory: row.type_category,
    trackingMode: row.tracking_mode,
    description: row.description,
    quantity: Number(row.quantity),
    weightBasis: row.weight_basis,
    unitWeightKg: num(row.unit_weight_kg),
    totalWeightKg: num(row.total_weight_kg),
    weightSource: row.weight_source,
    weightConfidence: row.weight_confidence,
    weightIsEstimated: row.weight_is_estimated,
    weightDocumentId: row.weight_document_id,
    weightDocumentSuperseded: row.weight_document_superseded_by_id !== null,
    weighedByUserId: row.weighed_by_user_id,
    manufacturer: row.manufacturer,
    model: row.model,
    serialNumber: row.serial_number,
    assetTag: row.asset_tag,
    condition: row.condition,
    originLocationId: row.origin_location_id,
    outcomeState: row.outcome_state,
    notes: row.notes,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    batchClientId: row.batch_client_id,
    revision: row.revision,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function findAsset(id: string, runner?: Queryable): Promise<AssetRow | null> {
  return queryOne<AssetRow>(`${selectFrom('project_assets')} where a.id = $1`, [id], runner);
}

export type AssetScope = { kind: 'OWNER' } | { kind: 'PROVIDER'; companyId: string };

export interface AssetFilter {
  outcomeState?: OutcomeState[];
  assetTypeId?: string;
  locationId?: string;
  /** Only lines whose weight is missing — the "what still needs weighing" list. */
  missingWeight?: boolean;
  batchClientId?: string;
  limit?: number;
  offset?: number;
}

export function listAssets(
  projectId: string,
  scope: AssetScope,
  filter: AssetFilter,
  runner?: Queryable
): Promise<AssetRow[]> {
  const params: unknown[] = [projectId];
  const where = ['a.project_id = $1', 'a.deleted_at is null'];

  if (scope.kind === 'PROVIDER') {
    params.push(scope.companyId);
    where.push(`a.company_id = $${params.length}`);
  }
  if (filter.outcomeState && filter.outcomeState.length > 0) {
    params.push(filter.outcomeState);
    where.push(`a.outcome_state = any($${params.length}::text[])`);
  }
  if (filter.assetTypeId) {
    params.push(filter.assetTypeId);
    where.push(`a.asset_type_id = $${params.length}`);
  }
  if (filter.locationId) {
    params.push(filter.locationId);
    where.push(`a.origin_location_id = $${params.length}`);
  }
  if (filter.missingWeight === true) where.push('a.unit_weight_kg is null');
  if (filter.batchClientId) {
    params.push(filter.batchClientId);
    where.push(`a.batch_client_id = $${params.length}`);
  }

  params.push(Math.min(filter.limit ?? 200, 500));
  const limit = `$${params.length}`;
  params.push(filter.offset ?? 0);
  const offset = `$${params.length}`;

  return query<AssetRow>(
    `${selectFrom('project_assets')}
      where ${where.join(' and ')}
      order by t.sort_order, a.created_at desc
      limit ${limit} offset ${offset}`,
    params
  );
}

export interface InsertAsset {
  projectId: string;
  companyId: string;
  assetTypeId: string;
  trackingMode: TrackingMode;
  description: string | null;
  quantity: number;
  weightBasis: WeightBasis | null;
  unitWeightKg: number | null;
  totalWeightKg: number | null;
  weightSource: WeightSource | null;
  weightConfidence: WeightConfidence | null;
  weightDocumentId: string | null;
  weighedByUserId: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  assetTag: string | null;
  condition: AssetCondition | null;
  originLocationId: string | null;
  notes: string | null;
  createdByUserId: string | null;
  batchClientId: string | null;
}

export async function insertAsset(
  input: InsertAsset,
  runner?: Queryable
): Promise<AssetRow | null> {
  const inserted = await queryOne<{ id: string }>(
    `insert into project_assets
       (project_id, company_id, asset_type_id, tracking_mode, description, quantity,
        weight_basis, unit_weight_kg, total_weight_kg, weight_source, weight_confidence,
        weight_is_estimated, weight_document_id, weighed_by_user_id,
        manufacturer, model, serial_number, asset_tag, condition,
        origin_location_id, notes, created_by_user_id, batch_client_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     returning id`,
    [
      input.projectId,
      input.companyId,
      input.assetTypeId,
      input.trackingMode,
      input.description,
      input.quantity,
      input.weightBasis,
      input.unitWeightKg,
      input.totalWeightKg,
      input.weightSource,
      input.weightConfidence,
      // Derived rather than accepted: `weight_is_estimated` has one source of
      // truth and it is the confidence, so a caller cannot set them disagreeing.
      input.weightConfidence === null ? true : isEstimatedConfidence(input.weightConfidence),
      input.weightDocumentId,
      input.weighedByUserId,
      input.manufacturer,
      input.model,
      input.serialNumber,
      input.assetTag,
      input.condition,
      input.originLocationId,
      input.notes,
      input.createdByUserId,
      input.batchClientId,
    ],
    runner
  );
  if (!inserted) return null;
  return findAsset(inserted.id, runner);
}

export type AssetPatch = Partial<
  Pick<
    InsertAsset,
    | 'assetTypeId'
    | 'trackingMode'
    | 'description'
    | 'quantity'
    | 'weightBasis'
    | 'unitWeightKg'
    | 'totalWeightKg'
    | 'weightSource'
    | 'weightConfidence'
    | 'weightDocumentId'
    | 'weighedByUserId'
    | 'manufacturer'
    | 'model'
    | 'serialNumber'
    | 'assetTag'
    | 'condition'
    | 'originLocationId'
    | 'notes'
  >
>;

const PATCH_COLUMNS: Record<keyof AssetPatch, string> = {
  assetTypeId: 'asset_type_id',
  trackingMode: 'tracking_mode',
  description: 'description',
  quantity: 'quantity',
  weightBasis: 'weight_basis',
  unitWeightKg: 'unit_weight_kg',
  totalWeightKg: 'total_weight_kg',
  weightSource: 'weight_source',
  weightConfidence: 'weight_confidence',
  weightDocumentId: 'weight_document_id',
  weighedByUserId: 'weighed_by_user_id',
  manufacturer: 'manufacturer',
  model: 'model',
  serialNumber: 'serial_number',
  assetTag: 'asset_tag',
  condition: 'condition',
  originLocationId: 'origin_location_id',
  notes: 'notes',
};

export async function updateAsset(
  id: string,
  patch: AssetPatch,
  expectedRevision: number | undefined,
  updatedByUserId: string | null,
  runner?: Queryable
): Promise<AssetRow | null> {
  const params: unknown[] = [id];
  const sets: string[] = [];
  for (const key of Object.keys(patch) as (keyof AssetPatch)[]) {
    params.push(patch[key]);
    sets.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
  }

  // Kept in step with the confidence in the same statement that changes it, so
  // the denormalized flag cannot be left behind by a patch that touched only one.
  if ('weightConfidence' in patch) {
    params.push(
      patch.weightConfidence == null ? true : isEstimatedConfidence(patch.weightConfidence)
    );
    sets.push(`weight_is_estimated = $${params.length}`);
  }

  params.push(updatedByUserId);
  sets.push(`updated_by_user_id = $${params.length}`);

  let guard = '';
  if (expectedRevision !== undefined) {
    params.push(expectedRevision);
    guard = ` and revision = $${params.length}`;
  }

  // The revision comparison lives inside the update's own `where`, where the row
  // lock makes it atomic — the shape the locations suite proved was necessary.
  const updated = await queryOne<{ id: string }>(
    `update project_assets set ${sets.join(', ')}
      where id = $1 and deleted_at is null${guard}
      returning id`,
    params,
    runner
  );
  if (!updated) return null;
  return findAsset(id, runner);
}

export async function tombstoneAsset(
  id: string,
  runner?: Queryable
): Promise<AssetRow | null> {
  const deleted = await queryOne<{ id: string }>(
    `update project_assets set deleted_at = now()
      where id = $1 and deleted_at is null
      returning id`,
    [id],
    runner
  );
  if (!deleted) return null;
  return findAsset(id, runner);
}

/**
 * Where a serial number already lives, for the refusal the packet's §13.2 owes.
 *
 * "Serial SN-4471 is recorded on Kings Court — Floor 2" is a route to the right
 * record; a bare unique-violation is a wall. The project name is only disclosed
 * because the row belongs to the caller's own company — the index is scoped to
 * `company_id`, so there is no cross-tenant read to leak here.
 */
export function findSerialOwner(
  companyId: string,
  serialNumber: string,
  runner?: Queryable
): Promise<{ id: string; project_id: string; project_name: string } | null> {
  return queryOne(
    `select a.id, a.project_id, p.name as project_name
       from project_assets a
       join projects p on p.id = a.project_id
      where a.company_id = $1
        and a.serial_number = $2
        and a.tracking_mode = 'ITEM'
        and a.deleted_at is null
      limit 1`,
    [companyId, serialNumber],
    runner
  );
}

/** A type the caller may actually use: the system catalog, or its own company's. */
export function findUsableAssetType(
  id: string,
  companyId: string,
  runner?: Queryable
): Promise<{ id: string; code: string; default_unit_weight_kg: string | null } | null> {
  return queryOne(
    `select id, code, default_unit_weight_kg
       from asset_types
      where id = $1 and active and (company_id is null or company_id = $2)`,
    [id, companyId],
    runner
  );
}

/** Same question by code, for the paste-import, which has names rather than ids. */
export function findAssetTypeByCode(
  code: string,
  companyId: string,
  runner?: Queryable
): Promise<{ id: string; code: string } | null> {
  return queryOne(
    `select id, code
       from asset_types
      where active and upper(code) = upper($1) and (company_id is null or company_id = $2)
      order by company_id nulls last
      limit 1`,
    [code, companyId],
    runner
  );
}

/** Both directions of the document link, checked against this project. */
export function findProjectDocument(
  id: string,
  projectId: string,
  runner?: Queryable
): Promise<{ id: string; category: string } | null> {
  return queryOne(
    `select id, category from project_documents
      where id = $1 and project_id = $2 and deleted_at is null`,
    [id, projectId],
    runner
  );
}

/**
 * Asset lines whose weight rests on this document.
 *
 * Used to refuse the delete rather than to cascade it: a DOCUMENTED weight whose
 * document is gone is an undocumented weight wearing a badge (packet finding 5).
 */
export function countWeightsCiting(
  documentId: string,
  runner?: Queryable
): Promise<{ n: string } | null> {
  return queryOne(
    `select count(*)::text as n from project_assets
      where weight_document_id = $1 and deleted_at is null
        and weight_confidence in ('VERIFIED','DOCUMENTED')`,
    [documentId],
    runner
  );
}
