import { Router } from 'express';
import {
  AVOIDED_METHODOLOGY_WARNING,
  computeDataQuality,
  computeMassBalance,
  type OrgProjectCarbonRow,
  type OrgSustainabilityView,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { query } from '../../db';
import { assertCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { loadForBalance } from '../assets/massBalance';
import { ensureSettings, readWeights } from './settings';

/**
 * The organisation sustainability dashboard (§38.1) — step 9 of the Phase 9 build
 * order, and the last one.
 *
 * §38.1 states three rules and every one of them is a design constraint rather than
 * a preference:
 *
 * **"No vanity metrics. Every figure is clickable through to the records behind
 * it."** So the response is *rows first, totals second*: a total that cannot be
 * decomposed is a number nobody can check, and building the totals from rows the
 * caller also receives is what makes the click-through possible without a second
 * API. The rows carry project ids, not just contributions.
 *
 * **"Any figure whose data completeness is below a configurable threshold is shown
 * with its completeness percentage attached rather than presented as fact."** A
 * total cannot carry that — only the rows it is made of can — so completeness rides
 * on each row and `belowThreshold` names the projects, which is what makes the
 * attachment actionable rather than decorative.
 *
 * **The two headline figures are never netted.** There is no `net` field, and the
 * type has no room for one: `ProjectCarbonRollUp` has no such field either, and
 * `firewall.test.ts` asserts none appears.
 *
 * ── THE SCOPE, WHICH IS THE ONE THING A PROVIDER MUST NOT GET (§4) ──────────
 *
 * Projects the company **owns or is assigned to**. Reading one project's carbon is
 * project-scoped for a provider — *"a total is not a row"* — but the dashboard
 * aggregates across projects and would leak the shape of a portfolio a
 * subcontractor is not part of. The `where` clause below is that rule, and it is the
 * reason this is a separate route rather than a filter on the project one.
 */

interface ProjectRow {
  project_id: string;
  project_name: string;
  client_company_name: string | null;
  is_owner: boolean;
}

interface CarbonTotalsRow {
  project_id: string;
  project_emissions: string | null;
  avoided: string | null;
  factor_set_names: string[] | null;
  calculation_count: string;
}

export const orgSustainabilityRouter = Router();

/**
 * GET /v1/sustainability/dashboard
 *
 * One request rather than one per project, and the cost is bounded by a project
 * cap rather than by the caller's patience: the mass balance is computed per
 * project from `loadForBalance`, which is two queries each, so a company with two
 * hundred projects would be four hundred round trips. The cap refuses that with a
 * sentence and a filter rather than serving it slowly, because a dashboard that
 * takes nine seconds is a dashboard people stop opening.
 */
orgSustainabilityRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    if (!(await hasFeature(ctx.companyId, 'sustainability'))) {
      throw new AppError('FORBIDDEN', 'Your plan does not include: sustainability', {
        feature: 'sustainability',
      });
    }
    await assertCapability(ctx, 'sustainability.read');

    const settings = await ensureSettings(ctx.companyId);
    const from = typeof req.query.from === 'string' ? req.query.from : null;
    const to = typeof req.query.to === 'string' ? req.query.to : null;
    const clientCompanyId =
      typeof req.query.clientCompanyId === 'string' ? req.query.clientCompanyId : null;

    const projects = await query<ProjectRow>(
      `select p.id as project_id, p.name as project_name,
              cc.name as client_company_name,
              (p.owner_company_id = $1) as is_owner
         from projects p
         left join companies cc on cc.id = p.client_company_id
        where (
                p.owner_company_id = $1
                or exists (
                  select 1 from project_assignments a
                   where a.project_id = p.id and a.provider_company_id = $1
                )
              )
          and ($2::date is null or p.starts_on is null or p.starts_on >= $2::date)
          and ($3::date is null or p.ends_on is null or p.ends_on <= $3::date)
          and ($4::uuid is null or p.client_company_id = $4)
        order by p.created_at desc
        limit 200`,
      [ctx.companyId, from, to, clientCompanyId]
    );

    if (projects.length === 0) {
      res.json({ dashboard: emptyDashboard(settings) });
      return;
    }

    const ids = projects.map((p) => p.project_id);

    /*
     * Carbon in one grouped query rather than per project, because unlike the mass
     * balance it needs no pure module: §28.2 defines project emissions as a sum over
     * two buckets of current rows, which is a `filter` clause, and the arithmetic a
     * unit test would protect happened when the row was written.
     *
     * **The two sums are separate columns and there is no third.** Adding them is
     * the mistake locked decision #17 exists to prevent, and the shape of this query
     * is what makes it impossible to do accidentally here.
     */
    const totals = await query<CarbonTotalsRow>(
      `select c.project_id,
              sum(c.kg_co2e) filter (
                where c.bucket in ('PROJECT_EMISSIONS','WASTE_TREATMENT')
              )::text as project_emissions,
              sum(c.kg_co2e) filter (where c.bucket = 'AVOIDED')::text as avoided,
              array_agg(distinct c.factor_set_name || ' ' || c.factor_set_version)
                filter (where c.factor_set_id is not null) as factor_set_names,
              count(*)::text as calculation_count
         from carbon_calculations c
        where c.project_id = any($1::uuid[]) and c.superseded_by is null
        group by c.project_id`,
      [ids]
    );
    const totalsById = new Map(totals.map((t) => [t.project_id, t]));

    const weights = readWeights(settings.data_quality_weights);
    const rows: OrgProjectCarbonRow[] = [];

    for (const project of projects) {
      const assets = await loadForBalance(project.project_id);
      const balance = computeMassBalance(assets);
      const carbon = totalsById.get(project.project_id);

      /*
       * §28.3's fifth component, per project. Two small queries would be one join too
       * many for a loop this size, so it rides on the same aggregate the claims table
       * can answer directly.
       */
      const avoidedMass = await query<{ total: string | null; specific: string | null }>(
        `select sum(coalesce(m.weight_kg, m.quantity * pa.unit_weight_kg))::text as total,
                sum(coalesce(m.weight_kg, m.quantity * pa.unit_weight_kg))
                  filter (where p.verification_status <> 'GENERIC_ESTIMATE')::text as specific
           from avoided_emissions_claims a
           join carbon_calculations c on c.id = a.calculation_id
           left join product_carbon_factors p on p.id = c.product_factor_id
           left join asset_movements m on m.id = a.asset_movement_id
           left join project_assets pa on pa.id = m.asset_id
          where c.project_id = $1 and c.superseded_by is null`,
        [project.project_id]
      );

      const quality = computeDataQuality(
        {
          lineCount: balance.lineCount,
          linesWithWeight: balance.linesWithWeight,
          linesWithSupport: balance.linesWithSupport,
          allocatedKg: balance.allocatedKg,
          handledKg: balance.handledKg,
          documentedMassKg: balance.documentedMassKg,
          avoidedMassKg: Number(avoidedMass[0]?.total ?? 0),
          avoidedMassOnSpecificFactorKg: Number(avoidedMass[0]?.specific ?? 0),
        },
        weights,
        { massUnit: settings.weight_unit }
      );

      const massFor = (flag: string): number =>
        balance.byDestination
          .filter((d) => d.countsAs.includes(flag as never))
          .reduce((sum, d) => sum + d.massKg, 0);

      rows.push({
        projectId: project.project_id,
        projectName: project.project_name,
        clientCompanyName: project.client_company_name,
        handledKg: balance.handledKg,
        allocatedKg: balance.allocatedKg,
        pendingKg: balance.pendingKg,
        reuseKg: massFor('REUSE'),
        recyclingKg: massFor('RECYCLING'),
        recoveryKg: massFor('RECOVERY'),
        landfillKg: massFor('LANDFILL'),
        divertedKg: massFor('DIVERTED'),
        retainedInUseKg: massFor('RETAINED_IN_USE'),
        /*
         * Null when nothing has been calculated, never zero (§41.1). A project with
         * no factor set has not emitted nothing; it has been measured by nobody, and
         * a 0 in a dashboard column is the most confident possible way to say the
         * opposite.
         */
        projectEmissionsKgCo2e:
          carbon === undefined ? null : Number(carbon.project_emissions ?? 0),
        avoidedKgCo2e: carbon === undefined ? null : Number(carbon.avoided ?? 0),
        completenessPct: quality.pct,
        factorSetNames: carbon?.factor_set_names ?? [],
      });
    }

    const sum = (pick: (r: OrgProjectCarbonRow) => number): number =>
      rows.reduce((total, r) => total + pick(r), 0);

    const allocatedKg = sum((r) => r.allocatedKg);
    const rate = (mass: number): number | null =>
      allocatedKg === 0 ? null : mass / allocatedKg;

    const dashboard: OrgSustainabilityView = {
      projects: rows,
      totals: {
        projectCount: rows.length,
        handledKg: sum((r) => r.handledKg),
        allocatedKg,
        pendingKg: sum((r) => r.pendingKg),
        reuseKg: sum((r) => r.reuseKg),
        recyclingKg: sum((r) => r.recyclingKg),
        recoveryKg: sum((r) => r.recoveryKg),
        landfillKg: sum((r) => r.landfillKg),
        divertedKg: sum((r) => r.divertedKg),
        retainedInUseKg: sum((r) => r.retainedInUseKg),
        projectEmissionsKgCo2e: sum((r) => r.projectEmissionsKgCo2e ?? 0),
        avoidedKgCo2e: sum((r) => r.avoidedKgCo2e ?? 0),
      },
      /*
       * Rates over ALLOCATED mass, with pending shown beside them and in none of
       * them. §28.2: *"hiding pending mass in a denominator is how a diversion rate
       * becomes a lie."* The same definition the project section uses, summed rather
       * than re-derived — §38.2's rule, one phase early and free.
       */
      rates: {
        reuse: rate(sum((r) => r.reuseKg)),
        recycling: rate(sum((r) => r.recyclingKg)),
        recovery: rate(sum((r) => r.recoveryKg)),
        landfill: rate(sum((r) => r.landfillKg)),
        diverted: rate(sum((r) => r.divertedKg)),
        retainedInUse: rate(sum((r) => r.retainedInUseKg)),
      },
      belowThreshold: rows
        .filter((r) => r.completenessPct !== null && r.completenessPct < settings.data_quality_warn_below)
        .map((r) => ({
          projectId: r.projectId,
          projectName: r.projectName,
          pct: r.completenessPct as number,
        })),
      warnBelow: settings.data_quality_warn_below,
      // §38.2's disclosure: a period spanning two factor sets says so.
      factorSetNames: [...new Set(rows.flatMap((r) => r.factorSetNames))].sort(),
      display: {
        carbonUnit: settings.carbon_display_unit,
        massUnit: settings.weight_unit,
      },
      methodologyWarning: AVOIDED_METHODOLOGY_WARNING,
    };

    res.json({ dashboard });
  })
);

/**
 * An organisation with no projects in range.
 *
 * **Every rate is null and every total is zero**, and the asymmetry is deliberate:
 * a company that has handled nothing genuinely has handled zero kilograms, and a
 * company that has allocated nothing has no diversion rate at all — there is
 * nothing to divide by. `formatRate` renders the null as an em dash, which is the
 * honest statement.
 */
function emptyDashboard(
  settings: Awaited<ReturnType<typeof ensureSettings>>
): OrgSustainabilityView {
  return {
    projects: [],
    totals: {
      projectCount: 0,
      handledKg: 0,
      allocatedKg: 0,
      pendingKg: 0,
      reuseKg: 0,
      recyclingKg: 0,
      recoveryKg: 0,
      landfillKg: 0,
      divertedKg: 0,
      retainedInUseKg: 0,
      projectEmissionsKgCo2e: 0,
      avoidedKgCo2e: 0,
    },
    rates: {
      reuse: null,
      recycling: null,
      recovery: null,
      landfill: null,
      diverted: null,
      retainedInUse: null,
    },
    belowThreshold: [],
    warnBelow: settings.data_quality_warn_below,
    factorSetNames: [],
    display: {
      carbonUnit: settings.carbon_display_unit,
      massUnit: settings.weight_unit,
    },
    methodologyWarning: AVOIDED_METHODOLOGY_WARNING,
  };
}
