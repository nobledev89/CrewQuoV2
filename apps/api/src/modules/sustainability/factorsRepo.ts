import type {
  EmissionFactorInput,
  EmissionFactorSetInput,
  EmissionFactorView,
  FactorSetView,
  MappedFactorRow,
  ProductCarbonFactorInput,
  ProductFactorView,
} from '@crewquo/shared';
import type { Queryable } from '../../db';
import { query, queryOne } from '../../db';

/**
 * Loading factors (§26.1, §26.3) — the data access half of steps 2 and 3.
 *
 * **Every query in this file is filtered `company_id = $1 or company_id is null`**,
 * and the `is null` arm is the platform library. That makes the tenant boundary in
 * this domain a **read widening and never a write one** (packet §10): the worst
 * outcome of a bug here is a customer seeing a published government factor, and
 * every write path asks a narrower question.
 */

export interface FactorSetRow {
  id: string;
  company_id: string | null;
  name: string;
  source_organisation: string;
  source_document: string | null;
  source_url: string | null;
  reporting_year: number;
  version: string;
  published_on: string | null;
  valid_from: string;
  valid_to: string | null;
  methodology: string | null;
  region: string;
  active: boolean;
  imported_by_user_id: string | null;
  created_at: Date;
  factor_count: string;
  cited_by_calculations: string;
}

const SET_COLUMNS = `s.id, s.company_id, s.name, s.source_organisation, s.source_document,
  s.source_url, s.reporting_year, s.version,
  to_char(s.published_on, 'YYYY-MM-DD') as published_on,
  to_char(s.valid_from, 'YYYY-MM-DD') as valid_from,
  to_char(s.valid_to, 'YYYY-MM-DD') as valid_to,
  s.methodology, s.region, s.active, s.imported_by_user_id, s.created_at,
  (select count(*) from emission_factors f where f.factor_set_id = s.id)::text as factor_count,
  (select count(*) from carbon_calculations c
     where c.factor_set_id = s.id and c.superseded_by is null)::text as cited_by_calculations`;

export function toFactorSetView(row: FactorSetRow): FactorSetView {
  return {
    id: row.id,
    companyId: row.company_id,
    isPlatform: row.company_id === null,
    name: row.name,
    sourceOrganisation: row.source_organisation,
    sourceDocument: row.source_document,
    sourceUrl: row.source_url,
    reportingYear: row.reporting_year,
    version: row.version,
    publishedOn: row.published_on,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    methodology: row.methodology,
    region: row.region,
    active: row.active,
    factorCount: Number(row.factor_count),
    citedByCalculations: Number(row.cited_by_calculations),
    importedByUserId: row.imported_by_user_id,
    createdAt: row.created_at.toISOString(),
  };
}

export function listFactorSets(companyId: string, includeInactive: boolean): Promise<FactorSetRow[]> {
  return query<FactorSetRow>(
    `select ${SET_COLUMNS}
       from emission_factor_sets s
      where (s.company_id = $1 or s.company_id is null)
        and ($2::boolean or s.active)
      order by s.reporting_year desc, s.name asc, s.version asc`,
    [companyId, includeInactive]
  );
}

export function findFactorSet(
  id: string,
  companyId: string,
  runner?: Queryable
): Promise<FactorSetRow | null> {
  return queryOne<FactorSetRow>(
    `select ${SET_COLUMNS}
       from emission_factor_sets s
      where s.id = $1 and (s.company_id = $2 or s.company_id is null)`,
    [id, companyId],
    runner
  );
}

/**
 * Does this company already hold a set at this name and version?
 *
 * **The company's own rows only.** A company importing "UK Government GHG 2027 v1.1"
 * when the platform library also holds one is not a duplicate — it is the shadowing
 * `selectFactorSet` implements, and refusing it would make importing your own
 * factors an error.
 */
export async function factorSetExists(
  companyId: string,
  name: string,
  version: string,
  runner?: Queryable
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `select id from emission_factor_sets
      where company_id = $1 and lower(name) = lower($2) and lower(version) = lower($3)`,
    [companyId, name, version],
    runner
  );
  return row !== null;
}

export async function insertFactorSet(
  input: {
    companyId: string;
    name: string;
    sourceOrganisation: string;
    sourceDocument: string | null;
    sourceUrl: string | null;
    reportingYear: number;
    version: string;
    publishedOn: string | null;
    validFrom: string;
    validTo: string | null;
    methodology: string | null;
    region: string;
    importedByUserId: string;
  },
  runner: Queryable
): Promise<{ id: string }> {
  const row = await queryOne<{ id: string }>(
    `insert into emission_factor_sets
       (company_id, name, source_organisation, source_document, source_url,
        reporting_year, version, published_on, valid_from, valid_to,
        methodology, region, imported_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10::date,$11,$12,$13)
     returning id`,
    [
      input.companyId,
      input.name,
      input.sourceOrganisation,
      input.sourceDocument,
      input.sourceUrl,
      input.reportingYear,
      input.version,
      input.publishedOn,
      input.validFrom,
      input.validTo,
      input.methodology,
      input.region,
      input.importedByUserId,
    ],
    runner
  );
  /* c8 ignore next */
  if (!row) throw new Error('factor set insert returned nothing');
  return row;
}

/**
 * Write the rows, **all of them or none**.
 *
 * A multi-row `insert ... select * from unnest(...)` rather than a loop: one
 * statement, one round trip, and the transaction the caller holds makes the
 * all-or-nothing guarantee that packet §9 requires — *"a partially imported factor
 * set is worse than none: the resolver finds some factors and reports gaps for the
 * rest, so the operator sees a plausible half-result instead of a failure, and the
 * missing half is disclosed to a client as a data gap that does not exist."*
 *
 * The arrays are built column-wise because `unnest` takes parallel arrays; a
 * per-row parameterised insert would be twenty thousand round trips inside one
 * transaction, which is a lock held for minutes.
 */
export async function insertFactors(
  factorSetId: string,
  rows: readonly MappedFactorRow[],
  runner: Queryable
): Promise<number> {
  if (rows.length === 0) return 0;
  await query(
    `insert into emission_factors
       (factor_set_id, category, activity, material, treatment, vehicle_type, fuel_type,
        unit, kg_co2e_per_unit, kg_co2_per_unit, kg_ch4_per_unit, kg_n2o_per_unit,
        wtt_kg_co2e_per_unit, scope, scope3_category, source_reference, notes)
     select $1,
            u.category, u.activity, u.material, u.treatment, u.vehicle_type, u.fuel_type,
            u.unit, u.kg_co2e_per_unit, u.kg_co2_per_unit, u.kg_ch4_per_unit, u.kg_n2o_per_unit,
            u.wtt_kg_co2e_per_unit, u.scope, u.scope3_category, u.source_reference, u.notes
       from unnest(
              $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
              $8::text[], $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[],
              $13::numeric[], $14::text[], $15::int[], $16::text[], $17::text[]
            ) as u(category, activity, material, treatment, vehicle_type, fuel_type,
                   unit, kg_co2e_per_unit, kg_co2_per_unit, kg_ch4_per_unit, kg_n2o_per_unit,
                   wtt_kg_co2e_per_unit, scope, scope3_category, source_reference, notes)`,
    [
      factorSetId,
      rows.map((r) => r.category),
      rows.map((r) => r.activity),
      rows.map((r) => r.material),
      rows.map((r) => r.treatment),
      rows.map((r) => r.vehicleType),
      rows.map((r) => r.fuelType),
      rows.map((r) => r.unit),
      rows.map((r) => r.kgCo2ePerUnit),
      rows.map((r) => r.kgCo2PerUnit),
      rows.map((r) => r.kgCh4PerUnit),
      rows.map((r) => r.kgN2oPerUnit),
      rows.map((r) => r.wttKgCo2ePerUnit),
      rows.map((r) => r.scope),
      rows.map((r) => r.scope3Category),
      rows.map((r) => r.sourceReference),
      rows.map((r) => r.notes),
    ],
    runner
  );
  return rows.length;
}

// ── Reading factors for the engine ───────────────────────────────────────────

interface FactorRow {
  id: string;
  factor_set_id: string;
  category: string;
  activity: string;
  material: string | null;
  treatment: string | null;
  vehicle_type: string | null;
  fuel_type: string | null;
  unit: string;
  kg_co2e_per_unit: string;
  wtt_kg_co2e_per_unit: string | null;
  scope: string | null;
  scope3_category: number | null;
  source_reference: string | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function toFactorInput(row: FactorRow): EmissionFactorInput {
  return {
    id: row.id,
    factorSetId: row.factor_set_id,
    category: row.category,
    activity: row.activity,
    material: row.material,
    treatment: row.treatment,
    vehicleType: row.vehicle_type,
    fuelType: row.fuel_type,
    unit: row.unit as EmissionFactorInput['unit'],
    kgCo2ePerUnit: Number(row.kg_co2e_per_unit),
    wttKgCo2ePerUnit: num(row.wtt_kg_co2e_per_unit),
    scope: row.scope as EmissionFactorInput['scope'],
    scope3Category: row.scope3_category,
    sourceReference: row.source_reference,
  };
}

export function toFactorView(row: FactorRow): EmissionFactorView {
  const input = toFactorInput(row);
  return {
    id: input.id,
    factorSetId: input.factorSetId,
    category: input.category,
    activity: input.activity,
    material: input.material,
    treatment: input.treatment,
    vehicleType: input.vehicleType,
    fuelType: input.fuelType,
    unit: input.unit,
    kgCo2ePerUnit: input.kgCo2ePerUnit,
    wttKgCo2ePerUnit: input.wttKgCo2ePerUnit,
    scope: input.scope,
    scope3Category: input.scope3Category,
    sourceReference: input.sourceReference,
  };
}

const FACTOR_COLUMNS = `id, factor_set_id, category, activity, material, treatment,
  vehicle_type, fuel_type, unit, kg_co2e_per_unit::text as kg_co2e_per_unit,
  wtt_kg_co2e_per_unit::text as wtt_kg_co2e_per_unit,
  scope, scope3_category, source_reference`;

/** Every candidate set for this company, in the shape `selectFactorSet` consumes. */
export async function loadFactorSetsForSelection(
  companyId: string,
  runner?: Queryable
): Promise<EmissionFactorSetInput[]> {
  const rows = await query<{
    id: string;
    company_id: string | null;
    name: string;
    version: string;
    reporting_year: number;
    valid_from: string;
    valid_to: string | null;
    region: string;
    active: boolean;
    methodology: string | null;
  }>(
    `select id, company_id, name, version, reporting_year,
            to_char(valid_from, 'YYYY-MM-DD') as valid_from,
            to_char(valid_to, 'YYYY-MM-DD') as valid_to,
            region, active, methodology
       from emission_factor_sets
      where (company_id = $1 or company_id is null) and active`,
    [companyId],
    runner
  );
  return rows.map((r) => ({
    id: r.id,
    companyId: r.company_id,
    name: r.name,
    version: r.version,
    reportingYear: r.reporting_year,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    region: r.region,
    active: r.active,
    methodology: r.methodology,
  }));
}

/**
 * One set's factors, loaded once per calculation run.
 *
 * **Loaded whole rather than queried per lookup**, which is the load-once discipline
 * Phase 2 established for label rules: a per-line query is the shape that turns a
 * project recalculation into a thousand round trips, and the resolution rules —
 * specificity, ambiguity — live in the pure module where a unit test can reach them.
 */
export async function loadFactors(
  factorSetId: string,
  runner?: Queryable
): Promise<EmissionFactorInput[]> {
  const rows = await query<FactorRow>(
    `select ${FACTOR_COLUMNS} from emission_factors where factor_set_id = $1`,
    [factorSetId],
    runner
  );
  return rows.map(toFactorInput);
}

export function listFactors(
  factorSetId: string,
  opts: { search?: string; limit: number; offset: number }
): Promise<FactorRow[]> {
  return query<FactorRow>(
    `select ${FACTOR_COLUMNS}
       from emission_factors
      where factor_set_id = $1
        and ($2::text is null
             or category ilike '%' || $2 || '%'
             or activity ilike '%' || $2 || '%'
             or material ilike '%' || $2 || '%')
      order by category, activity, material nulls first, treatment nulls first
      limit $3 offset $4`,
    [factorSetId, opts.search ?? null, opts.limit, opts.offset]
  );
}

// ── Product carbon factors (§26.3) ───────────────────────────────────────────

export interface ProductFactorRow {
  id: string;
  company_id: string | null;
  item_category: string;
  asset_type_id: string | null;
  asset_type_name: string | null;
  manufacturer: string | null;
  product_model: string | null;
  kg_co2e_per_item: string | null;
  kg_co2e_per_kg: string | null;
  lifecycle_boundary: string;
  source: string;
  source_url: string | null;
  publication_year: number | null;
  region: string | null;
  verification_status: string;
  is_estimate: boolean;
  notes: string | null;
  active: boolean;
  created_at: Date;
}

const PRODUCT_COLUMNS = `p.id, p.company_id, p.item_category, p.asset_type_id,
  t.name as asset_type_name, p.manufacturer, p.product_model,
  p.kg_co2e_per_item::text as kg_co2e_per_item, p.kg_co2e_per_kg::text as kg_co2e_per_kg,
  p.lifecycle_boundary, p.source, p.source_url, p.publication_year, p.region,
  p.verification_status, p.is_estimate, p.notes, p.active, p.created_at`;

export function toProductFactorView(row: ProductFactorRow): ProductFactorView {
  return {
    id: row.id,
    companyId: row.company_id,
    isPlatform: row.company_id === null,
    itemCategory: row.item_category,
    assetTypeId: row.asset_type_id,
    assetTypeName: row.asset_type_name,
    manufacturer: row.manufacturer,
    productModel: row.product_model,
    kgCo2ePerItem: num(row.kg_co2e_per_item),
    kgCo2ePerKg: num(row.kg_co2e_per_kg),
    lifecycleBoundary: row.lifecycle_boundary as ProductFactorView['lifecycleBoundary'],
    source: row.source,
    sourceUrl: row.source_url,
    publicationYear: row.publication_year,
    region: row.region,
    verificationStatus: row.verification_status as ProductFactorView['verificationStatus'],
    isEstimate: row.is_estimate,
    notes: row.notes,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

export function toProductFactorInput(row: ProductFactorRow): ProductCarbonFactorInput {
  return {
    id: row.id,
    companyId: row.company_id,
    itemCategory: row.item_category,
    assetTypeId: row.asset_type_id,
    manufacturer: row.manufacturer,
    productModel: row.product_model,
    kgCo2ePerItem: num(row.kg_co2e_per_item),
    kgCo2ePerKg: num(row.kg_co2e_per_kg),
    lifecycleBoundary: row.lifecycle_boundary as ProductCarbonFactorInput['lifecycleBoundary'],
    source: row.source,
    verificationStatus: row.verification_status as ProductCarbonFactorInput['verificationStatus'],
    isEstimate: row.is_estimate,
    active: row.active,
  };
}

export function listProductFactors(
  companyId: string,
  opts: { includeInactive?: boolean } = {}
): Promise<ProductFactorRow[]> {
  return query<ProductFactorRow>(
    `select ${PRODUCT_COLUMNS}
       from product_carbon_factors p
       left join asset_types t on t.id = p.asset_type_id
      where (p.company_id = $1 or p.company_id is null)
        and ($2::boolean or p.active)
      order by p.item_category, p.manufacturer nulls first, p.product_model nulls first`,
    [companyId, opts.includeInactive ?? false]
  );
}

/**
 * Every product factor this company may resolve against, for the engine.
 *
 * Active rows only — an inactive factor is one somebody withdrew, and resolving
 * against it would make deactivation cosmetic.
 */
export async function loadProductFactors(
  companyId: string,
  runner?: Queryable
): Promise<ProductCarbonFactorInput[]> {
  const rows = await query<ProductFactorRow>(
    `select ${PRODUCT_COLUMNS}
       from product_carbon_factors p
       left join asset_types t on t.id = p.asset_type_id
      where (p.company_id = $1 or p.company_id is null) and p.active`,
    [companyId],
    runner
  );
  return rows.map(toProductFactorInput);
}

export function findProductFactor(
  id: string,
  companyId: string,
  runner?: Queryable
): Promise<ProductFactorRow | null> {
  return queryOne<ProductFactorRow>(
    `select ${PRODUCT_COLUMNS}
       from product_carbon_factors p
       left join asset_types t on t.id = p.asset_type_id
      where p.id = $1 and (p.company_id = $2 or p.company_id is null)`,
    [id, companyId],
    runner
  );
}

export { PRODUCT_COLUMNS };
