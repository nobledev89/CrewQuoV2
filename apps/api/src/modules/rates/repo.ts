import type {
  RateCardCreate,
  RateCardUpdate,
  RateCardView,
  RateCardTemplateCreate,
  RateCardTemplateUpdate,
  RateCardTemplateView,
  RateKind,
  RateLabel,
  RoleCatalogCreate,
  RoleCatalogUpdate,
  RoleCatalogView,
  TimeframeDefinition,
} from '@crewquo/shared';
import { query, queryOne, withTransaction, type Queryable } from '../../db';
import { AppError } from '../../http/errors';

/**
 * Rate catalog persistence (CREWQUO_V2_PLAN.md §3.3, §6). Every query is scoped
 * by `company_id` — a company only ever touches its own catalog. The provider /
 * BILL-visibility rule (§4) is a cross-company concern handled where engagements
 * are read (Phase 3); here the owner sees its own PAY and BILL cards.
 */

// ── Role catalog ──────────────────────────────────────────────────────────────

interface RoleRow {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

function toRoleView(r: RoleRow): RoleCatalogView {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listRoles(companyId: string): Promise<RoleCatalogView[]> {
  const rows = await query<RoleRow>(
    `select id, name, created_at, updated_at from role_catalog
      where company_id = $1 order by name`,
    [companyId]
  );
  return rows.map(toRoleView);
}

export async function getRole(companyId: string, id: string): Promise<RoleCatalogView | null> {
  const row = await queryOne<RoleRow>(
    `select id, name, created_at, updated_at from role_catalog where company_id = $1 and id = $2`,
    [companyId, id]
  );
  return row ? toRoleView(row) : null;
}

export async function createRole(
  companyId: string,
  input: RoleCatalogCreate
): Promise<RoleCatalogView> {
  const exists = await queryOne(
    `select 1 from role_catalog where company_id = $1 and lower(name) = lower($2)`,
    [companyId, input.name]
  );
  if (exists) throw new AppError('CONFLICT', `Role '${input.name}' already exists`);
  const row = await queryOne<RoleRow>(
    `insert into role_catalog (company_id, name) values ($1, $2)
     returning id, name, created_at, updated_at`,
    [companyId, input.name]
  );
  return toRoleView(row!);
}

export async function updateRole(
  companyId: string,
  id: string,
  patch: RoleCatalogUpdate
): Promise<RoleCatalogView> {
  const row = await queryOne<RoleRow>(
    `update role_catalog set name = coalesce($3, name), updated_at = now()
      where company_id = $1 and id = $2
      returning id, name, created_at, updated_at`,
    [companyId, id, patch.name ?? null]
  );
  if (!row) throw new AppError('NOT_FOUND', 'Role not found');
  return toRoleView(row);
}

export async function deleteRole(companyId: string, id: string): Promise<void> {
  const row = await queryOne(
    `delete from role_catalog where company_id = $1 and id = $2 returning id`,
    [companyId, id]
  );
  if (!row) throw new AppError('NOT_FOUND', 'Role not found');
}

// ── Rate card templates ───────────────────────────────────────────────────────

interface TemplateRow {
  id: string;
  name: string;
  timeframe_definitions: RateCardTemplateView['timeframeDefinitions'];
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

function toTemplateView(r: TemplateRow): RateCardTemplateView {
  return {
    id: r.id,
    name: r.name,
    timeframeDefinitions: r.timeframe_definitions,
    isDefault: r.is_default,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const TEMPLATE_COLS = 'id, name, timeframe_definitions, is_default, created_at, updated_at';

/**
 * `rate_card_templates` carries a partial unique index on (company_id) where
 * is_default, so promoting a template has to demote the incumbent in the same
 * transaction or the insert/update trips the constraint.
 */
async function clearDefaultTemplate(
  companyId: string,
  exceptId: string | null,
  runner: Queryable
): Promise<void> {
  await query(
    `update rate_card_templates set is_default = false, updated_at = now()
      where company_id = $1 and is_default and ($2::uuid is null or id <> $2)`,
    [companyId, exceptId],
    runner
  );
}

export async function listTemplates(companyId: string): Promise<RateCardTemplateView[]> {
  const rows = await query<TemplateRow>(
    `select ${TEMPLATE_COLS} from rate_card_templates where company_id = $1 order by name`,
    [companyId]
  );
  return rows.map(toTemplateView);
}

export async function getTemplate(
  companyId: string,
  id: string
): Promise<RateCardTemplateView | null> {
  const row = await queryOne<TemplateRow>(
    `select ${TEMPLATE_COLS} from rate_card_templates where company_id = $1 and id = $2`,
    [companyId, id]
  );
  return row ? toTemplateView(row) : null;
}

export async function createTemplate(
  companyId: string,
  input: RateCardTemplateCreate
): Promise<RateCardTemplateView> {
  return withTransaction(async (client) => {
    if (input.isDefault) await clearDefaultTemplate(companyId, null, client);
    const row = await queryOne<TemplateRow>(
      `insert into rate_card_templates (company_id, name, timeframe_definitions, is_default)
       values ($1, $2, $3::jsonb, $4)
       returning ${TEMPLATE_COLS}`,
      [companyId, input.name, JSON.stringify(input.timeframeDefinitions), input.isDefault],
      client
    );
    return toTemplateView(row!);
  });
}

export async function updateTemplate(
  companyId: string,
  id: string,
  patch: RateCardTemplateUpdate
): Promise<RateCardTemplateView> {
  return withTransaction(async (client) => {
    if (patch.isDefault === true) await clearDefaultTemplate(companyId, id, client);
    const row = await queryOne<TemplateRow>(
      `update rate_card_templates set
         name = coalesce($3, name),
         timeframe_definitions = coalesce($4::jsonb, timeframe_definitions),
         is_default = coalesce($5, is_default),
         updated_at = now()
       where company_id = $1 and id = $2
       returning ${TEMPLATE_COLS}`,
      [
        companyId,
        id,
        patch.name ?? null,
        patch.timeframeDefinitions ? JSON.stringify(patch.timeframeDefinitions) : null,
        patch.isDefault ?? null,
      ],
      client
    );
    if (!row) throw new AppError('NOT_FOUND', 'Template not found');
    return toTemplateView(row);
  });
}

export async function deleteTemplate(companyId: string, id: string): Promise<void> {
  const row = await queryOne(
    `delete from rate_card_templates where company_id = $1 and id = $2 returning id`,
    [companyId, id]
  );
  if (!row) throw new AppError('NOT_FOUND', 'Template not found');
}

/**
 * The timeframe definitions in force for a company — its default template's, or
 * none at all.
 *
 * Every label resolution reads this (§6), so callers that resolve more than one
 * line must load it **once** and pass it down: a project summary otherwise
 * queries it per approved time log. `resolveRateLabel` takes the array rather
 * than a company id precisely so this stays visible at the call site.
 */
export async function getEffectiveTimeframeDefinitions(
  companyId: string,
  runner?: Queryable
): Promise<TimeframeDefinition[]> {
  const row = await queryOne<{ timeframe_definitions: TimeframeDefinition[] }>(
    `select timeframe_definitions from rate_card_templates
      where company_id = $1 and is_default limit 1`,
    [companyId],
    runner
  );
  return row?.timeframe_definitions ?? [];
}

// ── Rate cards ────────────────────────────────────────────────────────────────

interface RateCardRow {
  id: string;
  company_id: string;
  kind: RateKind;
  counterparty_company_id: string | null;
  role_id: string;
  rate_mode: RateCardView['rateMode'];
  rate_label: RateLabel;
  hourly_rate_cents: number | null;
  ot_hourly_rate_cents: number | null;
  shift_rate_cents: number | null;
  daily_rate_cents: number | null;
  min_hours: string | null; // numeric comes back as string from pg
  weekend_multiplier: string | null;
  night_multiplier: string | null;
  effective_from: string; // date column → 'YYYY-MM-DD'
  effective_to: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

const numOrNull = (v: string | null): number | null => (v === null ? null : Number(v));

function toRateCardView(r: RateCardRow): RateCardView {
  return {
    id: r.id,
    companyId: r.company_id,
    kind: r.kind,
    counterpartyCompanyId: r.counterparty_company_id,
    roleId: r.role_id,
    rateMode: r.rate_mode,
    rateLabel: r.rate_label,
    hourlyRateCents: r.hourly_rate_cents,
    otHourlyRateCents: r.ot_hourly_rate_cents,
    shiftRateCents: r.shift_rate_cents,
    dailyRateCents: r.daily_rate_cents,
    minHours: numOrNull(r.min_hours),
    weekendMultiplier: numOrNull(r.weekend_multiplier),
    nightMultiplier: numOrNull(r.night_multiplier),
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    active: r.active,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const RATE_CARD_COLS = `id, company_id, kind, counterparty_company_id, role_id, rate_mode,
  rate_label, hourly_rate_cents, ot_hourly_rate_cents, shift_rate_cents, daily_rate_cents,
  min_hours, weekend_multiplier, night_multiplier,
  to_char(effective_from, 'YYYY-MM-DD') as effective_from,
  to_char(effective_to, 'YYYY-MM-DD') as effective_to,
  active, created_at, updated_at`;

export interface RateCardFilter {
  kind?: RateKind;
  roleId?: string;
}

export async function listRateCards(
  companyId: string,
  filter: RateCardFilter = {}
): Promise<RateCardView[]> {
  const clauses = ['company_id = $1'];
  const params: unknown[] = [companyId];
  if (filter.kind) {
    params.push(filter.kind);
    clauses.push(`kind = $${params.length}`);
  }
  if (filter.roleId) {
    params.push(filter.roleId);
    clauses.push(`role_id = $${params.length}`);
  }
  const rows = await query<RateCardRow>(
    `select ${RATE_CARD_COLS} from rate_cards
      where ${clauses.join(' and ')}
      order by role_id, kind, rate_label, effective_from desc`,
    params
  );
  return rows.map(toRateCardView);
}

export async function getRateCard(companyId: string, id: string): Promise<RateCardView | null> {
  const row = await queryOne<RateCardRow>(
    `select ${RATE_CARD_COLS} from rate_cards where company_id = $1 and id = $2`,
    [companyId, id]
  );
  return row ? toRateCardView(row) : null;
}

export async function createRateCard(
  companyId: string,
  input: RateCardCreate
): Promise<RateCardView> {
  // The role must belong to this company (FK + tenancy check).
  const role = await queryOne(`select 1 from role_catalog where company_id = $1 and id = $2`, [
    companyId,
    input.roleId,
  ]);
  if (!role) throw new AppError('VALIDATION', 'roleId does not reference a role in this company');

  const row = await queryOne<RateCardRow>(
    `insert into rate_cards (
       company_id, kind, counterparty_company_id, role_id, rate_mode, rate_label,
       hourly_rate_cents, ot_hourly_rate_cents, shift_rate_cents, daily_rate_cents,
       min_hours, weekend_multiplier, night_multiplier, effective_from, effective_to, active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning ${RATE_CARD_COLS}`,
    [
      companyId,
      input.kind,
      input.counterpartyCompanyId,
      input.roleId,
      input.rateMode,
      input.rateLabel,
      input.hourlyRateCents,
      input.otHourlyRateCents,
      input.shiftRateCents,
      input.dailyRateCents,
      input.minHours,
      input.weekendMultiplier,
      input.nightMultiplier,
      input.effectiveFrom,
      input.effectiveTo,
      input.active,
    ]
  );
  return toRateCardView(row!);
}

export async function updateRateCard(
  companyId: string,
  id: string,
  patch: RateCardUpdate
): Promise<RateCardView> {
  const row = await queryOne<RateCardRow>(
    `update rate_cards set
       kind = coalesce($3, kind),
       counterparty_company_id = case when $4::boolean then $5 else counterparty_company_id end,
       role_id = coalesce($6, role_id),
       rate_mode = coalesce($7, rate_mode),
       rate_label = coalesce($8, rate_label),
       hourly_rate_cents = case when $9::boolean then $10 else hourly_rate_cents end,
       ot_hourly_rate_cents = case when $11::boolean then $12 else ot_hourly_rate_cents end,
       shift_rate_cents = case when $13::boolean then $14 else shift_rate_cents end,
       daily_rate_cents = case when $15::boolean then $16 else daily_rate_cents end,
       min_hours = case when $17::boolean then $18 else min_hours end,
       weekend_multiplier = case when $19::boolean then $20 else weekend_multiplier end,
       night_multiplier = case when $21::boolean then $22 else night_multiplier end,
       effective_from = coalesce($23, effective_from),
       effective_to = case when $24::boolean then $25 else effective_to end,
       active = coalesce($26, active),
       updated_at = now()
     where company_id = $1 and id = $2
     returning ${RATE_CARD_COLS}`,
    [
      companyId,
      id,
      patch.kind ?? null,
      'counterpartyCompanyId' in patch,
      patch.counterpartyCompanyId ?? null,
      patch.roleId ?? null,
      patch.rateMode ?? null,
      patch.rateLabel ?? null,
      'hourlyRateCents' in patch,
      patch.hourlyRateCents ?? null,
      'otHourlyRateCents' in patch,
      patch.otHourlyRateCents ?? null,
      'shiftRateCents' in patch,
      patch.shiftRateCents ?? null,
      'dailyRateCents' in patch,
      patch.dailyRateCents ?? null,
      'minHours' in patch,
      patch.minHours ?? null,
      'weekendMultiplier' in patch,
      patch.weekendMultiplier ?? null,
      'nightMultiplier' in patch,
      patch.nightMultiplier ?? null,
      patch.effectiveFrom ?? null,
      'effectiveTo' in patch,
      patch.effectiveTo ?? null,
      patch.active ?? null,
    ]
  );
  if (!row) throw new AppError('NOT_FOUND', 'Rate card not found');
  return toRateCardView(row);
}

export async function deleteRateCard(companyId: string, id: string): Promise<void> {
  const row = await queryOne(
    `delete from rate_cards where company_id = $1 and id = $2 returning id`,
    [companyId, id]
  );
  if (!row) throw new AppError('NOT_FOUND', 'Rate card not found');
}

/**
 * Candidate cards for resolution (§6 RateResolver): a company's own cards of one
 * kind/role/label, on or before the date, plus either the counterparty-specific
 * or the default (null counterparty). Effective-date selection happens in the
 * engine; counterparty preference is applied by the caller.
 */
export async function listResolveCandidates(args: {
  companyId: string;
  kind: RateKind;
  roleId: string;
  label: RateLabel;
  date: string;
  counterpartyId?: string;
}, runner?: Queryable): Promise<RateCardView[]> {
  const rows = await query<RateCardRow>(
    `select ${RATE_CARD_COLS} from rate_cards
      where company_id = $1 and kind = $2 and role_id = $3 and rate_label = $4
        and active and effective_from <= $5
        and (counterparty_company_id is null or counterparty_company_id = $6)
      order by effective_from desc`,
    [args.companyId, args.kind, args.roleId, args.label, args.date, args.counterpartyId ?? null],
    runner
  );
  return rows.map(toRateCardView);
}
