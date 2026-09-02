import {
  PRODUCT_FACTOR_TIER,
  type EmissionFactorInput,
  type EmissionFactorSetInput,
  type FactorQuery,
  type FactorResolution,
  type FactorSetQuery,
  type FactorSetSelection,
  type ProductCarbonFactorInput,
  type ProductFactorQuery,
  type ProductFactorResolution,
} from './types';

/**
 * Factor selection and resolution (§26.1–§26.3).
 *
 * **Three functions, and all three refuse rather than guess.** Where more than
 * one candidate is equally good the answer is `AMBIGUOUS` with the candidates
 * attached, never the first row the array happened to hold. The packet's §9 puts
 * it as *"overlapping validity windows are an operator error with no correct
 * resolution — picking the newer one silently would change which factors a
 * project uses based on a data-entry mistake nobody has noticed."*
 *
 * It is also the reason `emission_factor_sets` gets two partial unique indexes
 * in 9.2 (packet §0 finding 2): without them a duplicated platform set makes
 * this function return `AMBIGUOUS` on data that looks perfectly ordinary, which
 * is the *good* failure. The bad one is picking by join order.
 */

/** Case-insensitive, whitespace-tolerant comparison of two present values. */
function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ── Factor sets (§26.2) ──────────────────────────────────────────────────────

/**
 * Pick the factor set in effect for a piece of work.
 *
 * §26.2: *"selection is by the project's reporting year, resolved against
 * `valid_from`/`valid_to` and `region`, defaulting from §39. A newer factor set
 * is never applied retrospectively to a project that has already been calculated
 * and reported."* The retrospection half is not enforced here — it cannot be,
 * because this function has no idea what has been reported. It is enforced by
 * `carbon_calculations` never being recalculated except by an explicit trigger
 * (§27.2, packet §3), and by the denormalised citation surviving whatever
 * happens to the set afterwards.
 *
 * **A company set shadows a platform set**, the way a company `asset_type`
 * shadows a system one (§25.1). Without this rule an org that imports its own
 * 2027 set is immediately ambiguous against the platform's, which would make
 * importing your own factors an error.
 */
export function selectFactorSet(
  sets: readonly EmissionFactorSetInput[],
  query: FactorSetQuery
): FactorSetSelection {
  let candidates = sets.filter((s) => {
    if (!s.active) return false;
    if (!same(s.region, query.region)) return false;
    if (s.validFrom > query.date) return false;
    if (s.validTo !== null && s.validTo < query.date) return false;
    return true;
  });

  if (query.reportingYear !== undefined && query.reportingYear !== null) {
    const year = query.reportingYear;
    candidates = candidates.filter((s) => s.reportingYear === year);
  }

  // A company's own set wins over the platform library at the same window.
  if (candidates.some((s) => s.companyId !== null)) {
    candidates = candidates.filter((s) => s.companyId !== null);
  }

  const only = candidates[0];
  if (only === undefined) return { kind: 'NONE' };
  if (candidates.length > 1) return { kind: 'AMBIGUOUS', candidates };
  return { kind: 'SELECTED', set: only };
}

// ── Activity and treatment factors (§26.1) ───────────────────────────────────

/**
 * How many of the four **nullable** discriminators a factor row pins down.
 *
 * `category` and `activity` are `not null` on every row, so they cannot separate
 * two candidates. These four can: a row naming a fuel type is a better answer for
 * a diesel van than one that names none.
 */
function specificity(f: EmissionFactorInput): number {
  return (
    (f.material === null ? 0 : 1) +
    (f.treatment === null ? 0 : 1) +
    (f.vehicleType === null ? 0 : 1) +
    (f.fuelType === null ? 0 : 1)
  );
}

/**
 * Does a factor satisfy every field the query pinned down?
 *
 * A query field that is absent constrains nothing. A query field that is present
 * must match, and a factor whose own value is null **fails** — asking for the
 * diesel factor and being handed the one that does not say which fuel it is for
 * is exactly the silent substitution §41.1 exists to prevent.
 */
function matchesQuery(f: EmissionFactorInput, q: FactorQuery): boolean {
  if (q.unit !== undefined && f.unit !== q.unit) return false;
  if (q.category !== undefined && !same(f.category, q.category)) return false;
  if (q.activity !== undefined && !same(f.activity, q.activity)) return false;

  const pairs: readonly (readonly [string | undefined, string | null])[] = [
    [q.material, f.material],
    [q.treatment, f.treatment],
    [q.vehicleType, f.vehicleType],
    [q.fuelType, f.fuelType],
  ];
  for (const [wanted, held] of pairs) {
    if (wanted === undefined) continue;
    if (held === null) return false;
    if (!same(held, wanted)) return false;
  }
  return true;
}

/**
 * Resolve one factor out of a set's rows.
 *
 * The most specific match wins; a tie at the top is `AMBIGUOUS`. **No fallback
 * to a less specific row is applied on the way down** — if the caller wants the
 * generic freight factor when the vehicle-specific one is missing, it asks a
 * second time with a looser query, and the report can then say which of the two
 * it got. A silent widening inside this function would produce a number that
 * cites a factor nobody chose.
 */
export function resolveFactor(
  factors: readonly EmissionFactorInput[],
  query: FactorQuery
): FactorResolution {
  const matching = factors.filter((f) => matchesQuery(f, query));
  const best = matching.reduce<number>((m, f) => Math.max(m, specificity(f)), -1);
  const top = matching.filter((f) => specificity(f) === best);

  const only = top[0];
  if (only === undefined) return { kind: 'NONE' };
  if (top.length > 1) return { kind: 'AMBIGUOUS', candidates: top };
  return { kind: 'RESOLVED', factor: only };
}

// ── Product carbon factors (§26.3) ───────────────────────────────────────────

/**
 * How closely a product factor names the thing in hand: manufacturer **and**
 * model is 3, the asset type is 2, the category alone is 1.
 */
function productSpecificity(f: ProductCarbonFactorInput): number {
  if (f.manufacturer !== null && f.productModel !== null) return 3;
  if (f.assetTypeId !== null) return 2;
  return 1;
}

/**
 * A product factor is a candidate when every axis it pins down agrees with what
 * we are looking for. A factor that names a manufacturer cannot answer for an
 * item whose manufacturer we do not know — that is a different chair.
 */
function productMatches(f: ProductCarbonFactorInput, q: ProductFactorQuery): boolean {
  if (!f.active) return false;

  if (f.manufacturer !== null) {
    if (q.manufacturer === null || q.manufacturer === undefined) return false;
    if (!same(f.manufacturer, q.manufacturer)) return false;
  }
  if (f.productModel !== null) {
    if (q.productModel === null || q.productModel === undefined) return false;
    if (!same(f.productModel, q.productModel)) return false;
  }
  if (f.assetTypeId !== null) {
    if (q.assetTypeId === null || q.assetTypeId === undefined) return false;
    if (f.assetTypeId !== q.assetTypeId) return false;
  }
  // The category is the one axis every row carries, so it always has to agree
  // when the caller states it.
  if (q.itemCategory !== null && q.itemCategory !== undefined) {
    if (!same(f.itemCategory, q.itemCategory)) return false;
  }
  return true;
}

/**
 * §26.3's preferred-source walk: EPD/manufacturer → sector dataset →
 * organisation-specific → generic estimate, and *"if no factor exists at any
 * tier, no avoided-emissions figure is produced for that line."*
 *
 * **Tier beats specificity**, in that order, because §26.3 states the tiers as
 * the preference and specificity only separates rows inside one. A verified EPD
 * for the category outranks a generic estimate for the exact model, which is the
 * right way round: the tier is a statement about how much the number can be
 * trusted, and the model name is a statement about what it describes.
 *
 * **`GENERIC_REFUSED` is returned rather than `NONE`** when generics are the only
 * thing available and §39 has them switched off. The two have different fixes and
 * the packet's §5 gives them different `claim_blocked` reasons, so collapsing
 * them would tell an operator to go and find a factor that is already there.
 */
export function resolveProductFactor(
  factors: readonly ProductCarbonFactorInput[],
  query: ProductFactorQuery
): ProductFactorResolution {
  const matching = factors.filter((f) => productMatches(f, query));
  if (matching.length === 0) return { kind: 'NONE' };

  const allowed = query.allowGeneric
    ? matching
    : matching.filter((f) => f.verificationStatus !== 'GENERIC_ESTIMATE');

  if (allowed.length === 0) {
    // Every candidate was a generic and §39 says no. Name one, so the operator
    // can see what they are turning on rather than being told nothing exists.
    const refused = matching[0];
    /* c8 ignore next */
    if (refused === undefined) return { kind: 'NONE' };
    return { kind: 'GENERIC_REFUSED', factor: refused };
  }

  const rank = (f: ProductCarbonFactorInput): number => PRODUCT_FACTOR_TIER[f.verificationStatus];
  const bestTier = allowed.reduce<number>((m, f) => Math.min(m, rank(f)), Number.POSITIVE_INFINITY);
  let top = allowed.filter((f) => rank(f) === bestTier);

  const bestSpec = top.reduce<number>((m, f) => Math.max(m, productSpecificity(f)), 0);
  top = top.filter((f) => productSpecificity(f) === bestSpec);

  // A company's own factor beats the platform library at equal tier and
  // specificity — the shadowing rule `selectFactorSet` applies to whole sets.
  if (top.some((f) => f.companyId !== null)) {
    top = top.filter((f) => f.companyId !== null);
  }

  const only = top[0];
  if (only === undefined) return { kind: 'NONE' };
  if (top.length > 1) return { kind: 'AMBIGUOUS', candidates: top };
  return { kind: 'RESOLVED', factor: only, tier: bestTier };
}
