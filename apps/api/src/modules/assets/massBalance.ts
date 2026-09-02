import { Router } from 'express';
import {
  computeMassBalance,
  describeGaps,
  type AssetForBalance,
  type MovementRow as PolicyMovement,
  type WeightConfidence,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { uuidParam } from '../../http/params';
import { query } from '../../db';
import { hasCapability, assertCapability } from '../capabilities/guards';
import { assertAssetFeature, projectAccess } from './routes';

/**
 * The mass roll-up (§28.1–§28.2) — step 5 of the Phase 8 build order.
 *
 * **It computes nothing.** Every figure comes from `assets.ts`, which has had
 * exhaustive tests since 8.0 for the reason §27.1 gives about Phase 9: the masses
 * a carbon factor multiplies must be pinned before anything renders a number. So
 * this file is two queries, a grouping and two authorization gates — and if a
 * total is ever wrong, it is wrong in the pure module where a unit test can say
 * so, not in a SQL aggregate nobody can reproduce.
 *
 * **Nothing is stored.** §7 classifies the roll-up as derived, not stored, and
 * §3 says *"nobody corrects the roll-up; you correct its inputs."* A stored total
 * would be a second answer to a question the ledger already answers, and it would
 * be the one people trust. Phase 10's `generated_reports` snapshot is the
 * deliberate exception, and it is a snapshot precisely because this is not one.
 *
 * One file rather than the `*Repo.ts` / `*Routes.ts` pair the rest of the module
 * uses: it is one query pair and one route, and splitting them would be ceremony
 * around eighty lines.
 */

// ── Loading (two queries, grouped in memory) ─────────────────────────────────

interface AssetLineRow {
  id: string;
  quantity: string;
  unit_weight_kg: string | null;
  weight_confidence: WeightConfidence | null;
  has_support: boolean;
}

interface BalanceMovementRow {
  asset_id: string;
  id: string;
  continues_movement_id: string | null;
  quantity: string;
  weight_kg: string | null;
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
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * Every live line on the project, and every live movement under one.
 *
 * **Two queries rather than one with a json aggregate**, because the pure module
 * wants an array of lines each holding an array of movements, and the grouping is
 * four lines of TypeScript against a `json_agg` that has to be written, cast and
 * then trusted. **Tombstoned rows are excluded on both sides** — §7 is explicit
 * that a deleted line stops being counted while `record_revisions` keeps what it
 * was, so the roll-up is the one place the tombstone is meant to be invisible.
 *
 * `has_support` is §28.3's fourth component and it is three facts in one boolean:
 * the line cites a document for its weight, a photograph is tagged to the line,
 * or one of its movements carries a waste transfer note. All three are somebody
 * having backed the claim with something outside the form they typed it into,
 * which is what the component asks. None of them could be asked before 8.4.
 */
async function loadForBalance(projectId: string): Promise<AssetForBalance[]> {
  const [lines, movements] = await Promise.all([
    query<AssetLineRow>(
      `select a.id, a.quantity, a.unit_weight_kg, a.weight_confidence,
              (a.weight_document_id is not null
                or exists (select 1 from project_evidence e
                            where e.asset_id = a.id and e.deleted_at is null)
                or exists (select 1 from asset_movements m
                            where m.asset_id = a.id and m.deleted_at is null
                              and m.document_id is not null)) as has_support
         from project_assets a
        where a.project_id = $1 and a.deleted_at is null`,
      [projectId]
    ),
    query<BalanceMovementRow>(
      `select m.asset_id, m.id, m.continues_movement_id, m.quantity, m.weight_kg,
              d.code, d.name, d.hierarchy_tier,
              d.counts_as_retained_in_use, d.counts_as_reuse, d.counts_as_recycling,
              d.counts_as_recovery, d.counts_as_landfill, d.counts_as_diverted,
              d.is_final_outcome, d.displaces_replacement
         from asset_movements m
         join project_assets a on a.id = m.asset_id
         join destination_types d on d.id = m.destination_type_id
        where a.project_id = $1
          and m.deleted_at is null and a.deleted_at is null
        order by m.asset_id, m.sequence`,
      [projectId]
    ),
  ]);

  const byAsset = new Map<string, PolicyMovement[]>();
  for (const m of movements) {
    const list = byAsset.get(m.asset_id) ?? [];
    list.push({
      id: m.id,
      continuesMovementId: m.continues_movement_id,
      quantity: Number(m.quantity),
      weightKg: num(m.weight_kg),
      destination: {
        code: m.code,
        hierarchyTier: m.hierarchy_tier,
        countsAsRetainedInUse: m.counts_as_retained_in_use,
        countsAsReuse: m.counts_as_reuse,
        countsAsRecycling: m.counts_as_recycling,
        countsAsRecovery: m.counts_as_recovery,
        countsAsLandfill: m.counts_as_landfill,
        countsAsDiverted: m.counts_as_diverted,
        isFinalOutcome: m.is_final_outcome,
        displacesReplacement: m.displaces_replacement,
      },
    });
    byAsset.set(m.asset_id, list);
  }

  return lines.map((line) => ({
    line: { quantity: Number(line.quantity), unitWeightKg: num(line.unit_weight_kg) },
    movements: byAsset.get(line.id) ?? [],
    weightConfidence: line.weight_confidence,
    hasEvidenceOrDocument: line.has_support,
  }));
}

/** Destination codes to their display names, from the rows already loaded. */
async function destinationNames(projectId: string): Promise<Map<string, string>> {
  const rows = await query<{ code: string; name: string }>(
    `select distinct d.code, d.name
       from asset_movements m
       join project_assets a on a.id = m.asset_id
       join destination_types d on d.id = m.destination_type_id
      where a.project_id = $1 and m.deleted_at is null and a.deleted_at is null`,
    [projectId]
  );
  return new Map(rows.map((r) => [r.code, r.name]));
}

// ── The route ────────────────────────────────────────────────────────────────

export const projectMassBalanceRouter = Router();

/**
 * GET /v1/projects/:projectId/mass-balance
 *
 * **Two read gates, and the softer one is the interesting half** (packet §4).
 * `sustainability.read` is not in the Supervisor bundle, and a Supervisor is the
 * person who most needs to know that twelve chairs are still unallocated. So
 * `project.read` earns the **mass-only view** — handled, allocated, pending and
 * what is still open — which is a restatement of rows that caller can already
 * read one at a time; gating it would hide an aggregate of visible data and push
 * them to count by hand. The rates, the hierarchy breakdown and the completeness
 * gaps need `sustainability.read`. No money appears in either, which is what
 * makes the split safe: mass is not commercially sensitive the way a rate is.
 *
 * **The scope is the project, for a provider as well as the owner** — and this
 * departs from the asset list one file over, where a provider sees only its own
 * rows. A total is not a row: the roll-up carries no description, no serial, no
 * organisation and no counterparty identity, so a subcontractor reading the
 * project's tonnage learns a mass rather than somebody else's register. §4 states
 * it as *"a provider sees the project"*, and this is why.
 *
 * The gated half is **omitted rather than nulled**. A `rates: null` invites a
 * client to render "0%" or "—" where the honest statement is that this reader was
 * not shown the rates; an absent key cannot be mistaken for a computed nothing,
 * which is the same distinction `MassRates` draws between a null rate and 0%.
 */
projectMassBalanceRouter.get(
  '/:projectId/mass-balance',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertAssetFeature(access);
    await assertCapability(ctx, 'project.read');

    const full = await hasCapability(ctx, 'sustainability.read');

    const assets = await loadForBalance(access.projectId);
    const balance = computeMassBalance(assets);

    const massOnly = {
      view: full ? ('FULL' as const) : ('MASS_ONLY' as const),
      handledKg: balance.handledKg,
      allocatedKg: balance.allocatedKg,
      pendingKg: balance.pendingKg,
      inStorageKg: balance.inStorageKg,
      unallocatedKg: balance.unallocatedKg,
      lineCount: balance.lineCount,
      linesWithWeight: balance.linesWithWeight,
      /*
       * This travels with the masses in BOTH views, and it has to. It says some
       * material has no weight at all, so every figure above is a floor rather
       * than a total — a caveat that is part of the number's meaning, not part of
       * the sustainability commentary. Putting it behind the gate would let the
       * softer view render a total that is quietly a minimum.
       */
      hasUnknownMass: balance.hasUnknownMass,
    };

    if (!full) {
      res.json({ massBalance: massOnly });
      return;
    }

    const names = await destinationNames(access.projectId);
    res.json({
      massBalance: {
        ...massOnly,
        byDestination: balance.byDestination.map((d) => ({
          ...d,
          // Codes are the contract; names are what §28.1's headline renders.
          name: names.get(d.code) ?? d.code,
        })),
        rates: balance.rates,
        documentedMassKg: balance.documentedMassKg,
        linesWithSupport: balance.linesWithSupport,
        /*
         * The gaps, and deliberately not a composite score (§13.5). Four of
         * §28.3's five components are computable as of 8.4 and the fifth is Phase
         * 9's; a percentage published over four fifths of a definition changes
         * meaning downward when Phase 9 lands, on projects nobody touched. Each
         * gap is true on its own, which is why they can ship a phase early.
         */
        gaps: describeGaps(balance),
      },
    });
  })
);
