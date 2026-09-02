import { formatMassKg, type MassUnit } from '../assets';
import {
  CARBON_BUCKETS,
  GHG_SCOPES,
  INVENTORY_BUCKETS,
  type AvoidedOutcome,
  type BucketedTotal,
  type CarbonBucket,
  type CarbonDisplayUnit,
  type CarbonGap,
  type CarbonOutcome,
  type CarbonResult,
  type DataQualityComponent,
  type DataQualityComponentResult,
  type DataQualityInputs,
  type DataQualityResult,
  type DataQualityWeights,
  type GhgScope,
  type ProjectCarbonRollUp,
} from './types';

/**
 * Roll-up, data quality and display (§28).
 *
 * Nothing here recomputes a figure — it groups figures the calculation functions
 * produced, which is the same division `massBalance.ts` draws in Phase 8: *"if a
 * total is ever wrong, it is wrong in the pure module where a unit test can say
 * so."*
 */

/** Every outcome the engine can hand back, from any of the three calculations. */
export type AnyCarbonOutcome = CarbonOutcome | AvoidedOutcome;

// ── The firewall in use (locked decision #17) ────────────────────────────────

/**
 * Sum the results in **one** bucket.
 *
 * The bucket is a parameter rather than something inferred from the rows,
 * because a function that infers it would happily accept a mixed array and
 * return a mixed total. Rows outside the requested bucket are filtered out, so
 * the runtime behaviour matches what the type promises.
 */
export function sumBucket<B extends CarbonBucket>(
  results: readonly CarbonResult[],
  bucket: B
): BucketedTotal<B> {
  let kgCo2e = 0;
  let rowCount = 0;
  for (const r of results) {
    if (r.bucket !== bucket) continue;
    kgCo2e += r.kgCo2e;
    rowCount += 1;
  }
  return { bucket, kgCo2e, rowCount };
}

/**
 * Add two totals **from the same bucket**.
 *
 * `addTotals(emissions, avoided)` is a compile error, which is locked decision
 * #17 enforced by the type checker rather than by review. See `BucketBrand` in
 * `types.ts` for the mechanism and `firewall.test.ts` for the proof.
 */
export function addTotals<B extends CarbonBucket>(
  a: BucketedTotal<B>,
  b: BucketedTotal<B>
): BucketedTotal<B> {
  return {
    bucket: a.bucket,
    kgCo2e: a.kgCo2e + b.kgCo2e,
    rowCount: a.rowCount + b.rowCount,
  };
}

// ── Project roll-up (§28.2) ──────────────────────────────────────────────────

function isQuantified(
  o: AnyCarbonOutcome
): o is Extract<AnyCarbonOutcome, { kind: 'QUANTIFIED' }> {
  return o.kind === 'QUANTIFIED';
}

/**
 * §28.2's project totals, from everything the engine produced.
 *
 * **`byScope` is taken over the inventory buckets only.** An `AVOIDED` row
 * carries no scope so it could not leak in by accident, but the filter is
 * explicit anyway: the next person to give avoided rows a scope for some
 * reporting convenience should have to delete this line to break the rule, not
 * merely add a column.
 *
 * `hasGaps` travels with the totals for the reason Phase 8's `hasUnknownMass`
 * does — it says every figure above is a floor rather than a total, which is
 * part of what the number means rather than commentary alongside it.
 */
export function rollUpProjectCarbon(
  outcomes: readonly AnyCarbonOutcome[]
): ProjectCarbonRollUp {
  const results = outcomes.filter(isQuantified).map((o) => o.result);
  const gapCount = outcomes.filter((o) => o.kind === 'GAP').length;

  const byBucket = {} as Record<CarbonBucket, BucketedTotal>;
  for (const bucket of CARBON_BUCKETS) {
    byBucket[bucket] = sumBucket(results, bucket);
  }

  const byScope = {} as Record<GhgScope, number>;
  for (const scope of GHG_SCOPES) byScope[scope] = 0;
  for (const r of results) {
    if (r.scope === null) continue;
    if (!(INVENTORY_BUCKETS as readonly CarbonBucket[]).includes(r.bucket)) continue;
    byScope[r.scope] += r.kgCo2e;
  }

  let projectEmissionsKgCo2e = 0;
  for (const bucket of INVENTORY_BUCKETS) {
    projectEmissionsKgCo2e += byBucket[bucket].kgCo2e;
  }

  return {
    projectEmissionsKgCo2e,
    avoidedKgCo2e: byBucket.AVOIDED.kgCo2e,
    comparativeLifecycleKgCo2e: byBucket.COMPARATIVE_LIFECYCLE.kgCo2e,
    byBucket,
    byScope,
    hasGaps: gapCount > 0,
    gapCount,
  };
}

// ── Data completeness (§28.3) ────────────────────────────────────────────────

interface ComponentSpec {
  component: DataQualityComponent;
  measured: number;
  total: number;
  unit: 'LINES' | 'KG';
}

/**
 * §28.3's single percentage, from five weighted components.
 *
 * **This is the debt Phase 8 recorded and deferred.** Its §13.5 shipped the named
 * gaps and withheld the score, because the fifth component — avoided-emissions
 * mass on a product-specific factor — could not exist until this phase, and *"a
 * percentage published over four fifths of a definition changes meaning when
 * Phase 9 lands, downward, on projects nobody touched."* All five are computable
 * now, so the score can be published without changing meaning again.
 *
 * **Weights are renormalised over the components that apply.** A project with no
 * avoided mass has no fifth component; scoring it as zero would mark a company
 * down for not having made a claim it never had grounds to make, which would push
 * exactly the wrong behaviour. A component whose denominator is zero returns
 * `null` — Phase 8's *"a rate over nothing is not 0%"*, applied again.
 *
 * With nothing measurable at all the score is **null, not zero** (§44: *"empty
 * project returns nulls not zeros"*).
 */
export function computeDataQuality(
  inputs: DataQualityInputs,
  weights: DataQualityWeights,
  opts: { massUnit?: MassUnit } = {}
): DataQualityResult {
  const specs: readonly ComponentSpec[] = [
    {
      component: 'LINES_WITH_WEIGHT',
      measured: inputs.linesWithWeight,
      total: inputs.lineCount,
      unit: 'LINES',
    },
    {
      component: 'MASS_WITH_FINAL_DESTINATION',
      measured: inputs.allocatedKg,
      total: inputs.handledKg,
      unit: 'KG',
    },
    {
      component: 'MASS_DOCUMENTED_OR_VERIFIED',
      measured: inputs.documentedMassKg,
      total: inputs.handledKg,
      unit: 'KG',
    },
    {
      component: 'LINES_WITH_SUPPORT',
      measured: inputs.linesWithSupport,
      total: inputs.lineCount,
      unit: 'LINES',
    },
    {
      component: 'AVOIDED_MASS_ON_SPECIFIC_FACTOR',
      measured: inputs.avoidedMassOnSpecificFactorKg,
      total: inputs.avoidedMassKg,
      unit: 'KG',
    },
  ];

  const components: DataQualityComponentResult[] = specs.map((s) => ({
    component: s.component,
    weight: weights[s.component],
    value: s.total === 0 ? null : s.measured / s.total,
    measured: s.measured,
    total: s.total,
    unit: s.unit,
  }));

  let weighted = 0;
  let applicableWeight = 0;
  for (const c of components) {
    if (c.value === null) continue;
    weighted += c.weight * c.value;
    applicableWeight += c.weight;
  }

  const pct = applicableWeight === 0 ? null : (weighted / applicableWeight) * 100;

  return { pct, components, warnings: describeComponentGaps(components, opts) };
}

/**
 * The **one** sentence this phase adds, and a deliberate refusal to write the
 * other four.
 *
 * `assets.ts`'s `describeGaps` has said four of §28.3's five components out loud
 * since Phase 8 — lines with no weight, the estimated share of project weight,
 * lines with no photograph or document, and unallocated or stored mass — in
 * wording that has already reached a client's report. Only the fifth was
 * impossible before this phase, because it needs an avoided-emissions claim to
 * exist.
 *
 * So this generates the fifth and nothing else, and the packet's §14 step 9.7
 * says why in three words: *"Phase 8's gaps unchanged."* Regenerating the other
 * four here would put each of them in the report **twice**, once in Phase 8's
 * words and once in slightly different ones — which reads as two separate
 * problems and is exactly the kind of noise §28.3's *"a report that quietly omits
 * its own gaps"* warning gets ignored because of.
 *
 * The score still weights all five. Publishing a sentence and computing a
 * component are different jobs.
 */
function describeComponentGaps(
  components: readonly DataQualityComponentResult[],
  opts: { massUnit?: MassUnit } = {}
): string[] {
  const fifth = components.find((c) => c.component === 'AVOIDED_MASS_ON_SPECIFIC_FACTOR');
  if (fifth === undefined || fifth.value === null || fifth.value >= 1) return [];

  const genericKg = fifth.total - fifth.measured;
  return [
    `Carbon benefit for ${formatMassKg(genericKg, opts.massUnit ?? 'AUTO')} uses a generic product factor.`,
  ];
}

// ── Disclosure sentences for gaps (§28.3, §41.1) ─────────────────────────────

/**
 * Turn the engine's gaps into the sentences §28.3 requires — *"no
 * waste-treatment factor exists for plasterboard in the 2027 factor set — 1.2 t
 * excluded from treatment emissions."*
 *
 * Only `GAP` outcomes reach here. `OUT_OF_SCOPE` ones deliberately produce
 * nothing (packet §0 finding 8): a retained chair was never a waste treatment,
 * and reporting it as a hole fills the report with warnings about material that
 * was handled perfectly.
 */
export function describeCarbonGaps(
  gaps: readonly CarbonGap[],
  opts: { factorSetName?: string; massUnit?: MassUnit } = {}
): string[] {
  const unit = opts.massUnit ?? 'AUTO';
  const inSet = opts.factorSetName === undefined ? '' : ` in the ${opts.factorSetName} factor set`;

  const quantity = (g: CarbonGap): string => {
    if (g.quantity === null) return 'an unrecorded quantity';
    if (g.unit === 'kg') return formatMassKg(g.quantity, unit);
    if (g.unit === null) return String(g.quantity);
    return `${g.quantity} ${g.unit}`;
  };

  return gaps.map((g) => {
    switch (g.reason) {
      case 'NO_FACTOR':
        return `No waste-treatment factor exists for ${g.subject}${inSet} — ${quantity(g)} excluded from treatment emissions.`;
      case 'NO_FACTOR_SET':
        return `No emission factor set applies to this project, so no emissions have been calculated for ${g.subject}.`;
      case 'NO_PRODUCT_FACTOR':
        return `No product carbon factor exists for ${g.subject} — no avoided-emissions claim is made for ${quantity(g)}.`;
      case 'GENERIC_NOT_ALLOWED':
        return `Only a generic product factor is available for ${g.subject}, and generic factors are switched off — no avoided-emissions claim is made for ${quantity(g)}.`;
      case 'DISPLACEMENT_UNKNOWN':
        return `No displacement assumption has been stated for ${g.subject}, so no avoided-emissions claim is made for ${quantity(g)}.`;
      case 'UNIT_MISMATCH':
        return `The factor for ${g.subject} is published in a unit that cannot be converted from ${g.unit ?? 'the recorded unit'} — ${quantity(g)} excluded.`;
      case 'AMBIGUOUS_FACTOR':
        return `More than one factor matches ${g.subject}, so none has been applied — ${quantity(g)} excluded.`;
      case 'NO_MASS':
        return `${g.subject} has no recorded weight, so no emissions or avoided-emissions figure is produced for it.`;
    }
  });
}

/**
 * Packet §0 finding 7, as a sentence.
 *
 * `RETAINED` counts as retained-in-use and displaces nothing, while `RELOCATED`
 * does both — so a project where the client kept everything reports high
 * retained-in-use beside zero avoided emissions, in the same section. That is
 * correct and it reads as a bug.
 *
 * The flag must not be flipped to fix it: `displaces_replacement = true` on
 * `RETAINED` would attach an avoided-emissions claim to every piece of furniture
 * nobody touched, which is the single largest inflation available anywhere in the
 * schema. What the section owes instead is this sentence.
 */
export function describeUnclaimedRetainedMass(
  retainedWithoutClaimKg: number,
  opts: { massUnit?: MassUnit } = {}
): string | null {
  if (retainedWithoutClaimKg <= 0) return null;
  return `${formatMassKg(retainedWithoutClaimKg, opts.massUnit ?? 'AUTO')} was retained in use by the client; no replacement was displaced, so no avoided-emissions claim is made for it.`;
}

// ── Display (§28.4, §39) ─────────────────────────────────────────────────────

/**
 * §28.4's headline figures. **The only place a carbon number is rounded**, which
 * is §41.9's *"never round mid-calculation"* enforced by there being nowhere else
 * to do it — the same guarantee `formatMassKg` gives masses.
 *
 * `AUTO` switches at a tonne, matching `formatMassKg` so a section does not show
 * masses in tonnes beside carbon in kilograms.
 */
export function formatCarbonKg(kgCo2e: number, unit: CarbonDisplayUnit = 'AUTO'): string {
  const resolved = unit === 'AUTO' ? (Math.abs(kgCo2e) >= 1000 ? 'TCO2E' : 'KGCO2E') : unit;
  if (resolved === 'TCO2E') return `${(kgCo2e / 1000).toFixed(2)} tCO₂e`;
  return `${kgCo2e.toFixed(1)} kgCO₂e`;
}

/** The completeness score, or the em dash that says there was nothing to measure. */
export function formatCompleteness(pct: number | null): string {
  if (pct === null) return '—';
  return `${Math.round(pct)}%`;
}
