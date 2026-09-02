import { z } from 'zod';

/**
 * Assets & materials (CREWQUO_V2_PLAN.md §25) — step 0 of the Phase 8 build
 * order in `docs/operating-model/assets-materials.md` §14.
 *
 * §25 opens with the sentence that sets the stakes: *"The heart of the expansion.
 * Everything in §26–§29 is downstream of getting this record right."* The carbon
 * engine multiplies these masses by factors; the report renders those products;
 * the client sign-off attests to them. A double-counted tonne here becomes a
 * double-counted tonne of CO₂e with a full audit trail behind it.
 *
 * So this file lands **before the migration**, for the reason `rate-engine/` did:
 * §27.1's rule for Phase 9 is *"exhaustive tests before anything renders a
 * number"*, and it applies a phase early to the masses those numbers multiply.
 * Every function here is pure arithmetic over rows the API loads — no Postgres,
 * no clock, no I/O — so every branch below is a unit test rather than a fixture.
 *
 * **Numbers in, numbers out.** Postgres returns `numeric` as a string and the
 * repo layer converts with `Number(...)` exactly as `storage/repo.ts` already
 * does. §41.9 — *never round mid-calculation, never display more precision than
 * the input justifies* — is honoured by keeping every intermediate at full
 * double precision and rounding in exactly one place: `formatMassKg`.
 */

// ── Asset types (§25.1) ──────────────────────────────────────────────────────

export const ASSET_CATEGORIES = [
  'FURNITURE',
  'IT',
  'WEEE',
  'APPLIANCE',
  'TIMBER',
  'METAL',
  'PLASTIC',
  'CARDBOARD',
  'MIXED_WASTE',
  'TEXTILE',
  'GLASS',
  'OTHER',
] as const;
export const assetCategorySchema = z.enum(ASSET_CATEGORIES);
export type AssetCategory = z.infer<typeof assetCategorySchema>;

export interface SystemAssetType {
  code: string;
  name: string;
  category: AssetCategory;
  sortOrder: number;
}

/**
 * §25.1's seeded catalog, **and every `default_unit_weight_kg` is absent rather
 * than zero or guessed.**
 *
 * This is §41.1 at its most literal — *"never invent … no factor, no number"* —
 * and the plan states the consequence itself: *"A shipped default weight is an
 * invented number that silently becomes a reported tonne."* An operator chair is
 * anywhere between 9 kg and 24 kg depending on the base, and a product that
 * offers 16 kg gets 16 kg back from a hurried supervisor on a phone, permanently,
 * with `SYSTEM_ESTIMATE` provenance nobody reads.
 *
 * There is deliberately no `defaultUnitWeightKg` field on this type at all. A
 * nullable one would invite exactly one pull request to fill it in.
 */
export const SYSTEM_ASSET_TYPES: readonly SystemAssetType[] = [
  { code: 'OPERATOR_CHAIR', name: 'Operator chair', category: 'FURNITURE', sortOrder: 10 },
  { code: 'MEETING_CHAIR', name: 'Meeting chair', category: 'FURNITURE', sortOrder: 20 },
  { code: 'DESK', name: 'Desk', category: 'FURNITURE', sortOrder: 30 },
  { code: 'BENCH_DESK', name: 'Bench desk', category: 'FURNITURE', sortOrder: 40 },
  { code: 'PEDESTAL', name: 'Pedestal', category: 'FURNITURE', sortOrder: 50 },
  { code: 'CABINET', name: 'Cabinet', category: 'FURNITURE', sortOrder: 60 },
  { code: 'LOCKER', name: 'Locker', category: 'FURNITURE', sortOrder: 70 },
  { code: 'TABLE', name: 'Table', category: 'FURNITURE', sortOrder: 80 },
  { code: 'SOFA', name: 'Sofa', category: 'FURNITURE', sortOrder: 90 },
  { code: 'MONITOR', name: 'Monitor', category: 'IT', sortOrder: 100 },
  { code: 'COMPUTER', name: 'Computer', category: 'IT', sortOrder: 110 },
  { code: 'PRINTER', name: 'Printer', category: 'IT', sortOrder: 120 },
  { code: 'SERVER', name: 'Server', category: 'IT', sortOrder: 130 },
  { code: 'NETWORKING', name: 'Networking equipment', category: 'IT', sortOrder: 140 },
  { code: 'APPLIANCE', name: 'Appliance', category: 'APPLIANCE', sortOrder: 150 },
  { code: 'TIMBER', name: 'Timber', category: 'TIMBER', sortOrder: 160 },
  { code: 'METAL', name: 'Metal', category: 'METAL', sortOrder: 170 },
  { code: 'PLASTIC', name: 'Plastic', category: 'PLASTIC', sortOrder: 180 },
  { code: 'CARDBOARD', name: 'Cardboard', category: 'CARDBOARD', sortOrder: 190 },
  { code: 'MIXED_WASTE', name: 'Mixed waste', category: 'MIXED_WASTE', sortOrder: 200 },
  { code: 'WEEE', name: 'WEEE', category: 'WEEE', sortOrder: 210 },
  { code: 'OTHER', name: 'Other', category: 'OTHER', sortOrder: 220 },
];

/**
 * §25.1: *"a company row with the same `code` shadows the system one."*
 *
 * Resolution is here rather than in SQL because two screens and an importer all
 * have to agree about it, and a `coalesce` written three times is three chances
 * for one to differ. The unique indexes in migration `0033` are what make the
 * result single-valued; this is what makes it consistent.
 */
export function resolveTypeCatalog<T extends { code: string; companyId: string | null }>(
  rows: readonly T[]
): T[] {
  const byCode = new Map<string, T>();
  for (const row of rows) {
    const existing = byCode.get(row.code);
    // A company row wins; between two of a kind the first stands, because the
    // indexes make a second one unreachable.
    if (existing === undefined || (existing.companyId === null && row.companyId !== null)) {
      byCode.set(row.code, row);
    }
  }
  return [...byCode.values()];
}

// ── Weight provenance (§25.3) ────────────────────────────────────────────────

export const WEIGHT_SOURCES = [
  'WEIGHED',
  'WEIGHBRIDGE',
  'TRANSFER_NOTE',
  'SUPPLIER_DOC',
  'PRODUCT_SPEC',
  'USER_ESTIMATE',
  'SYSTEM_ESTIMATE',
] as const;
export const weightSourceSchema = z.enum(WEIGHT_SOURCES);
export type WeightSource = z.infer<typeof weightSourceSchema>;

export const WEIGHT_CONFIDENCES = ['VERIFIED', 'DOCUMENTED', 'ESTIMATED', 'APPROXIMATE'] as const;
export const weightConfidenceSchema = z.enum(WEIGHT_CONFIDENCES);
export type WeightConfidence = z.infer<typeof weightConfidenceSchema>;

/** §25.3's table, exactly. */
export const DEFAULT_CONFIDENCE_FOR_SOURCE: Readonly<Record<WeightSource, WeightConfidence>> = {
  WEIGHED: 'VERIFIED',
  WEIGHBRIDGE: 'VERIFIED',
  TRANSFER_NOTE: 'DOCUMENTED',
  SUPPLIER_DOC: 'DOCUMENTED',
  PRODUCT_SPEC: 'DOCUMENTED',
  USER_ESTIMATE: 'ESTIMATED',
  SYSTEM_ESTIMATE: 'APPROXIMATE',
};

export const WEIGHT_SOURCE_LABELS: Readonly<Record<WeightSource, string>> = {
  WEIGHED: 'Weighed on site',
  WEIGHBRIDGE: 'Weighbridge ticket',
  TRANSFER_NOTE: 'Waste transfer note',
  SUPPLIER_DOC: 'Supplier or facility document',
  PRODUCT_SPEC: 'Manufacturer product weight',
  USER_ESTIMATE: 'Estimated on site',
  SYSTEM_ESTIMATE: 'Derived from an asset-type default',
};

/**
 * Ordered best-first, so "overridable downward but not upward" is a comparison
 * rather than a table of allowed pairs.
 */
const CONFIDENCE_RANK: Readonly<Record<WeightConfidence, number>> = {
  VERIFIED: 3,
  DOCUMENTED: 2,
  ESTIMATED: 1,
  APPROXIMATE: 0,
};

/** §25.3: *"`weight_is_estimated` is derived (`ESTIMATED`/`APPROXIMATE` ⇒ true)"*. */
export function isEstimatedConfidence(confidence: WeightConfidence): boolean {
  return confidence === 'ESTIMATED' || confidence === 'APPROXIMATE';
}

/**
 * *"`VERIFIED` and `DOCUMENTED` require an attached document … unless the source
 * is `WEIGHED` with a recorded weigher."*
 *
 * The exception is not a loophole: `WEIGHED` means somebody put the thing on a
 * scale, and the person is the provenance. What makes it safe is that it demands
 * a *named* weigher, so the claim has an author who can be asked.
 */
export function documentRequiredFor(source: WeightSource, confidence: WeightConfidence): boolean {
  if (isEstimatedConfidence(confidence)) return false;
  return source !== 'WEIGHED';
}

export type ConfidenceRefusal =
  | { code: 'UPGRADE_NOT_ALLOWED'; message: string }
  | { code: 'DOCUMENT_REQUIRED'; message: string }
  | { code: 'WEIGHER_REQUIRED'; message: string };

export interface ResolvedConfidence {
  confidence: WeightConfidence;
  isEstimated: boolean;
  /** Set when `requested` could not be honoured; `confidence` then holds what was. */
  refusal: ConfidenceRefusal | null;
}

/**
 * What confidence a weight actually carries, given what was asked for and what
 * backs it.
 *
 * **It degrades rather than refuses, and that is a deliberate difference from
 * every other guard in this codebase.** A supervisor on a phone in a stairwell
 * who ticks "verified" without the ticket gets their 16.5 kg *saved*, as an
 * estimate, with a sentence saying why. Refusing the whole write would lose the
 * measurement — which is the data the product exists to collect — to protect a
 * label. The refusal is returned so a caller can say what happened; it is not an
 * error to throw.
 *
 * The capability check for `asset.weight.verify` lives in the API and reaches
 * this function as `canVerify`, so the degrade path is identical whether the
 * claim failed for want of a document or for want of a permission.
 */
export function resolveWeightConfidence(args: {
  source: WeightSource;
  /** What the user asked for. Omitted means "take the default for the source". */
  requested?: WeightConfidence;
  hasDocument: boolean;
  hasWeigher: boolean;
  /** Does this person hold `asset.weight.verify`? */
  canVerify: boolean;
}): ResolvedConfidence {
  const fallback = isEstimatedConfidence(DEFAULT_CONFIDENCE_FOR_SOURCE[args.source])
    ? DEFAULT_CONFIDENCE_FOR_SOURCE[args.source]
    : 'ESTIMATED';
  const settled = (confidence: WeightConfidence, refusal: ConfidenceRefusal | null) => ({
    confidence,
    isEstimated: isEstimatedConfidence(confidence),
    refusal,
  });

  const def = DEFAULT_CONFIDENCE_FOR_SOURCE[args.source];
  const wanted = args.requested ?? def;

  // "Defaults are suggestions, overridable downward but not upward."
  if (CONFIDENCE_RANK[wanted] > CONFIDENCE_RANK[def]) {
    return settled(def, {
      code: 'UPGRADE_NOT_ALLOWED',
      message: `A weight from ${WEIGHT_SOURCE_LABELS[args.source].toLowerCase()} can be recorded as ${def.toLowerCase()} at best. Saved as ${def.toLowerCase()}.`,
    });
  }

  if (!isEstimatedConfidence(wanted)) {
    if (!args.canVerify) {
      return settled(fallback, {
        code: 'UPGRADE_NOT_ALLOWED',
        message: `Saved as an estimate. Recording a ${wanted.toLowerCase()} weight needs the weight-verification permission.`,
      });
    }
    if (args.source === 'WEIGHED' && !args.hasWeigher) {
      return settled(fallback, {
        code: 'WEIGHER_REQUIRED',
        message: 'Saved as an estimate. A weighed figure needs the name of whoever weighed it.',
      });
    }
    if (documentRequiredFor(args.source, wanted) && !args.hasDocument) {
      return settled(fallback, {
        code: 'DOCUMENT_REQUIRED',
        message: `Saved as an estimate. A ${wanted.toLowerCase()} weight needs the document it came from attached.`,
      });
    }
  }

  return settled(wanted, null);
}

// ── Weight algebra (§25.2) ───────────────────────────────────────────────────

export const WEIGHT_BASES = ['UNIT', 'TOTAL'] as const;
export const weightBasisSchema = z.enum(WEIGHT_BASES);
export type WeightBasis = z.infer<typeof weightBasisSchema>;

export interface DerivedWeights {
  unitWeightKg: number;
  totalWeightKg: number;
}

/**
 * §25.2: *"the user enters **either** a unit weight or a total; `weight_basis`
 * records which one they typed and the other is derived at write time."*
 *
 * Returns `null` for a line with no weight, which §25.2 explicitly permits:
 * *"A line with neither weight is valid — it just contributes nothing to mass
 * metrics and drags down data completeness, which is the correct incentive."*
 * A zero-weight line and a weightless line are different records and this is the
 * function that keeps them different: `0` is a claim, `null` is a gap.
 */
export function deriveWeights(args: {
  basis: WeightBasis | null;
  quantity: number;
  unitWeightKg: number | null;
  totalWeightKg: number | null;
}): DerivedWeights | null {
  if (args.basis === null) return null;

  if (args.basis === 'UNIT') {
    if (args.unitWeightKg === null) return null;
    return {
      unitWeightKg: args.unitWeightKg,
      totalWeightKg: args.unitWeightKg * args.quantity,
    };
  }

  if (args.totalWeightKg === null) return null;
  // A total over zero units has no unit weight, and inventing one (or a NaN, or
  // an Infinity that later renders as "∞ kg") is worse than saying so. The total
  // is what the person typed and it stands; the derived side is absent.
  if (args.quantity === 0) {
    return { unitWeightKg: 0, totalWeightKg: args.totalWeightKg };
  }
  return {
    unitWeightKg: args.totalWeightKg / args.quantity,
    totalWeightKg: args.totalWeightKg,
  };
}

/**
 * §25.2: *"Editing quantity recomputes the derived side, never the entered
 * side."*
 *
 * The rule people get wrong in both directions. On a `UNIT` line, 42 → 50 chairs
 * at 16.5 kg is 825 kg, not 16.5 kg spread thinner. On a `TOTAL` line, a
 * weighbridge said 693 kg went out and finding four more chairs on the dock does
 * not make the lorry heavier — the total stands and the unit weight falls.
 */
export function reweighForQuantity(args: {
  basis: WeightBasis | null;
  newQuantity: number;
  unitWeightKg: number | null;
  totalWeightKg: number | null;
}): DerivedWeights | null {
  return deriveWeights({
    basis: args.basis,
    quantity: args.newQuantity,
    unitWeightKg: args.unitWeightKg,
    totalWeightKg: args.totalWeightKg,
  });
}

// ── Destinations and the waste hierarchy (§25.4, §25.5) ──────────────────────

/**
 * What a destination *means*, as data (locked decision #20).
 *
 * Every mass metric in §28.2 is a sum filtered by one of these booleans, which
 * is what makes the hierarchy configurable without a `switch` anywhere. The
 * consequence — a company can define a destination that calls landfill diverted
 * — is contained by disclosure rather than by prevention; see the packet §4.
 */
export interface DestinationSemantics {
  code: string;
  /** 1–5, best first (§25.5). `null` for `STORAGE`, which sits outside the hierarchy. */
  hierarchyTier: number | null;
  countsAsRetainedInUse: boolean;
  countsAsReuse: boolean;
  countsAsRecycling: boolean;
  countsAsRecovery: boolean;
  countsAsLandfill: boolean;
  countsAsDiverted: boolean;
  isFinalOutcome: boolean;
  displacesReplacement: boolean;
}

export interface SystemDestinationType extends DestinationSemantics {
  name: string;
  sortOrder: number;
}

const dest = (
  code: string,
  name: string,
  hierarchyTier: number | null,
  sortOrder: number,
  flags: Partial<Omit<DestinationSemantics, 'code' | 'hierarchyTier'>>
): SystemDestinationType => ({
  code,
  name,
  hierarchyTier,
  sortOrder,
  countsAsRetainedInUse: false,
  countsAsReuse: false,
  countsAsRecycling: false,
  countsAsRecovery: false,
  countsAsLandfill: false,
  countsAsDiverted: false,
  isFinalOutcome: true,
  displacesReplacement: false,
  ...flags,
});

/**
 * §25.4's eleven, flag for flag.
 *
 * **Row 7 is the one the whole domain turns on.** `STORAGE` has no tier, counts
 * as nothing, and `isFinalOutcome: false` — locked decision #18 in a single row
 * of data rather than a special case in a calculator. *"An asset sitting in a
 * warehouse is not a sustainability result, and CrewQuo will not report it as one
 * until someone records where it actually went."*
 */
export const SYSTEM_DESTINATION_TYPES: readonly SystemDestinationType[] = [
  dest('RETAINED', 'Retained by client', 1, 10, {
    countsAsRetainedInUse: true,
    countsAsDiverted: true,
  }),
  dest('RELOCATED', 'Relocated / redeployed', 1, 20, {
    countsAsRetainedInUse: true,
    countsAsDiverted: true,
    displacesReplacement: true,
  }),
  dest('REUSE', 'Direct reuse', 2, 30, {
    countsAsRetainedInUse: true,
    countsAsReuse: true,
    countsAsDiverted: true,
    displacesReplacement: true,
  }),
  dest('REFURBISHMENT', 'Refurbishment', 2, 40, {
    countsAsRetainedInUse: true,
    countsAsReuse: true,
    countsAsDiverted: true,
    displacesReplacement: true,
  }),
  dest('DONATION', 'Donation', 2, 50, {
    countsAsRetainedInUse: true,
    countsAsReuse: true,
    countsAsDiverted: true,
    displacesReplacement: true,
  }),
  dest('RESALE', 'Resale', 2, 60, {
    countsAsRetainedInUse: true,
    countsAsReuse: true,
    countsAsDiverted: true,
    displacesReplacement: true,
  }),
  dest('STORAGE', 'Storage', null, 70, { isFinalOutcome: false }),
  dest('RECYCLING', 'Recycling', 3, 80, { countsAsRecycling: true, countsAsDiverted: true }),
  dest('ENERGY_RECOVERY', 'Energy recovery', 4, 90, {
    countsAsRecovery: true,
    countsAsDiverted: true,
  }),
  dest('LANDFILL', 'Landfill', 5, 100, { countsAsLandfill: true }),
  dest('OTHER_DISPOSAL', 'Other disposal', 5, 110, { countsAsLandfill: true }),
];

/**
 * §25.5: *"Reuse ranks above recycling everywhere it is shown: sort order in
 * tables, order of the mass-balance bars, order of the report sections."*
 *
 * One comparator, exported, so a table and a report cannot disagree about it.
 * `STORAGE` has no tier and sorts last — it is not a worse outcome than landfill,
 * it is not an outcome, and putting it at the bottom of a hierarchy list is the
 * least misleading of the available lies. The mass balance shows it separately as
 * pending rather than as a bar (§28.2).
 */
export function compareByHierarchy(a: DestinationSemantics, b: DestinationSemantics): number {
  const at = a.hierarchyTier ?? Number.POSITIVE_INFINITY;
  const bt = b.hierarchyTier ?? Number.POSITIVE_INFINITY;
  if (at !== bt) return at - bt;
  return a.code.localeCompare(b.code);
}

// ── The movement ledger (§25.4) ──────────────────────────────────────────────

export interface AssetLineMass {
  quantity: number;
  /** Null for a line with no weight recorded — §25.2 permits it. */
  unitWeightKg: number | null;
}

export interface MovementRow {
  id: string;
  /**
   * The packet's finding 1. Set when a *later* movement carries this material
   * onward — the recycling leg that follows a storage leg. A continued movement
   * counts against nothing: not the quantity ceiling, not allocated mass, not
   * pending mass. It stays because a ledger records where material has been.
   */
  continuesMovementId: string | null;
  quantity: number;
  /**
   * **Null means derive.** The packet's finding 4: a weight copied from the line
   * at write time silently disagrees with the line the first time somebody
   * attaches a weighbridge ticket, and §25.3 expects exactly that correction. A
   * value here is an overriding claim somebody made on purpose.
   */
  weightKg: number | null;
  destination: DestinationSemantics;
}

/**
 * The movements that still say where material is: those nothing continues.
 *
 * This is the set every rule and every metric in the domain is stated over, and
 * it exists because §25.4's rule 1 and rule 3 contradict each other without it —
 * 12 chairs into storage and 12 out of it is 24 against a line of 42 that also
 * donated 30. See `assets-materials.md` §13.1, including what was rejected.
 */
export function openMovements(movements: readonly MovementRow[]): MovementRow[] {
  const continued = new Set<string>();
  for (const m of movements) {
    if (m.continuesMovementId !== null) continued.add(m.continuesMovementId);
  }
  return movements.filter((m) => !continued.has(m.id));
}

/** A movement's mass: its own claim, or the line's rate applied to its quantity. */
export function movementMassKg(movement: MovementRow, line: AssetLineMass): number | null {
  if (movement.weightKg !== null) return movement.weightKg;
  if (line.unitWeightKg === null) return null;
  return movement.quantity * line.unitWeightKg;
}

export const OUTCOME_STATES = ['PENDING', 'PARTIAL', 'IN_STORAGE', 'FINAL'] as const;
export const outcomeStateSchema = z.enum(OUTCOME_STATES);
export type OutcomeState = z.infer<typeof outcomeStateSchema>;

export interface AssetMassSummary {
  /** Σ mass of open movements to a final outcome. The denominator of every rate. */
  allocatedKg: number;
  /** Σ mass of open movements to a non-final destination — storage, today. */
  inStorageKg: number;
  /** Quantity with no open movement at all, priced at the line's unit weight. */
  unallocatedKg: number;
  pendingKg: number;
  handledKg: number;
  allocatedQuantity: number;
  inStorageQuantity: number;
  unallocatedQuantity: number;
  outcomeState: OutcomeState;
  /**
   * True when some mass could not be computed because the line has no weight and
   * a movement did not override it. The figures above are then a floor, and a
   * screen that renders them without saying so is lying by omission (§28.3).
   */
  hasUnknownMass: boolean;
}

/**
 * One asset line's contribution to the mass balance.
 *
 * **`unallocatedKg` is computed from quantity, never by subtracting masses**, and
 * the packet's §0 finding 2 gives the reason: a movement may override its weight,
 * so `line mass − Σ movement mass` goes negative the moment a weighbridge weighs
 * the load better than the estimate did. Handled mass may therefore exceed the
 * line's own stated mass — which is correct, and which §41.6 requires to survive
 * into the total rather than be reconciled away.
 */
export function summariseAsset(
  line: AssetLineMass,
  movements: readonly MovementRow[]
): AssetMassSummary {
  const open = openMovements(movements);

  let allocatedKg = 0;
  let inStorageKg = 0;
  let allocatedQuantity = 0;
  let inStorageQuantity = 0;
  let hasUnknownMass = false;

  for (const m of open) {
    const mass = movementMassKg(m, line);
    if (mass === null) hasUnknownMass = true;
    if (m.destination.isFinalOutcome) {
      allocatedQuantity += m.quantity;
      allocatedKg += mass ?? 0;
    } else {
      inStorageQuantity += m.quantity;
      inStorageKg += mass ?? 0;
    }
  }

  const movedQuantity = allocatedQuantity + inStorageQuantity;
  // The ceiling guarantees this is non-negative; `max` is a belt against a row
  // written before the ceiling existed, or by a hand-run correction.
  const unallocatedQuantity = Math.max(0, line.quantity - movedQuantity);
  if (unallocatedQuantity > 0 && line.unitWeightKg === null) hasUnknownMass = true;
  const unallocatedKg = unallocatedQuantity * (line.unitWeightKg ?? 0);

  return {
    allocatedKg,
    inStorageKg,
    unallocatedKg,
    pendingKg: inStorageKg + unallocatedKg,
    handledKg: allocatedKg + inStorageKg + unallocatedKg,
    allocatedQuantity,
    inStorageQuantity,
    unallocatedQuantity,
    outcomeState: deriveOutcomeState(line.quantity, allocatedQuantity, inStorageQuantity),
    hasUnknownMass,
  };
}

/**
 * §25.4 rule 2: *"`outcome_state` is derived, never typed."*
 *
 * `IN_STORAGE` is stated over *all* open movements rather than the plan's
 * *"latest movement is a non-final destination"*, for the packet's §0 finding 2
 * reason: on a partial split the latest movement is a fact about recording order,
 * not about where the material is. A line 30 donated and 12 stored is `PARTIAL`,
 * and it should be — there is still something to do.
 */
export function deriveOutcomeState(
  quantity: number,
  allocatedQuantity: number,
  inStorageQuantity: number
): OutcomeState {
  if (allocatedQuantity >= quantity && quantity > 0) return 'FINAL';
  if (allocatedQuantity === 0 && inStorageQuantity === 0) return 'PENDING';
  if (allocatedQuantity === 0 && inStorageQuantity >= quantity) return 'IN_STORAGE';
  return 'PARTIAL';
}

// ── The two ceilings (§25.4 rule 1, and its restatement) ─────────────────────

export type MovementRefusal =
  | { code: 'EXCEEDS_REMAINING'; message: string; remainingQuantity: number }
  | { code: 'SOURCE_IS_FINAL'; message: string }
  | { code: 'ALREADY_CONTINUED'; message: string }
  | { code: 'EXCEEDS_SOURCE'; message: string; sourceQuantity: number };

/** What is left to allocate: the line, minus every open movement. */
export function remainingQuantity(
  line: AssetLineMass,
  movements: readonly MovementRow[]
): number {
  const open = openMovements(movements);
  const moved = open.reduce((sum, m) => sum + m.quantity, 0);
  return Math.max(0, line.quantity - moved);
}

/**
 * §25.4 rule 1, restated over open movements.
 *
 * The check itself is one comparison; what matters is where it is called from.
 * The API must hold `select … from project_assets where id = $1 for update`
 * across this check and the insert, or it is a check-then-act and two clerks put
 * 54 chairs of destinations against a line of 42 — the shape `money-boundary.md`
 * §3 already paid for once in rate pinning.
 */
export function canRecordMovement(
  line: AssetLineMass,
  movements: readonly MovementRow[],
  quantity: number
): MovementRefusal | null {
  const remaining = remainingQuantity(line, movements);
  if (quantity <= remaining) return null;
  return {
    code: 'EXCEEDS_REMAINING',
    message:
      remaining === 0
        ? `All ${formatQuantity(line.quantity)} are already recorded to a destination.`
        : `Only ${formatQuantity(remaining)} of ${formatQuantity(line.quantity)} are still unallocated.`,
    remainingQuantity: remaining,
  };
}

/**
 * Continuing a movement — the mechanism that makes storage a door rather than a
 * hole (§13.1).
 *
 * Three refusals, and each is a way the ledger would otherwise stop meaning what
 * it says. Continuing a **final** movement is not a correction, it is a second
 * claim on material already reported. Continuing an **already-continued**
 * movement forks the chain, and a fork double-counts on the very next sum. And a
 * continuation **larger than what it continues** is 15 chairs coming out of a
 * warehouse that 12 went into.
 */
export function canContinueMovement(
  source: MovementRow,
  movements: readonly MovementRow[],
  quantity: number
): MovementRefusal | null {
  if (source.destination.isFinalOutcome) {
    return {
      code: 'SOURCE_IS_FINAL',
      message:
        'These are already recorded at a final destination. Correct that movement instead of adding another.',
    };
  }
  if (movements.some((m) => m.continuesMovementId === source.id)) {
    return {
      code: 'ALREADY_CONTINUED',
      message: 'This movement has already been carried onward. Correct the later movement instead.',
    };
  }
  if (quantity > source.quantity) {
    return {
      code: 'EXCEEDS_SOURCE',
      message: `Only ${formatQuantity(source.quantity)} went to this destination.`,
      sourceQuantity: source.quantity,
    };
  }
  return null;
}

// ── The project mass balance (§28.1, §28.2) ──────────────────────────────────

export interface AssetForBalance {
  line: AssetLineMass;
  movements: readonly MovementRow[];
  /** For §28.3's gap sentences, not for any figure. */
  weightConfidence: WeightConfidence | null;
  hasEvidenceOrDocument: boolean;
}

export interface DestinationMass {
  code: string;
  hierarchyTier: number | null;
  massKg: number;
}

export interface MassRates {
  /** Every rate is `null` when allocated mass is zero. A rate over nothing is not 0%. */
  reuse: number | null;
  recycling: number | null;
  recovery: number | null;
  landfill: number | null;
  diverted: number | null;
  retainedInUse: number | null;
}

export interface MassBalance {
  handledKg: number;
  allocatedKg: number;
  pendingKg: number;
  inStorageKg: number;
  unallocatedKg: number;
  /** Final-outcome mass per destination, best hierarchy tier first (§25.5). */
  byDestination: DestinationMass[];
  rates: MassRates;
  lineCount: number;
  linesWithWeight: number;
  documentedMassKg: number;
  /** Some mass could not be computed. Every figure above is a floor. */
  hasUnknownMass: boolean;
}

/**
 * §28.1's headline and §28.2's definitions, over a whole project.
 *
 * **The rates divide by allocated mass and pending is returned beside them**, per
 * §28.2: *"Hiding pending mass in a denominator is how a diversion rate becomes a
 * lie."* A caller cannot render the rates without also holding the pending
 * figure, because they arrive in the same object.
 *
 * **No carbon.** Phase 8's milestone is a tonnage split; §26–§28's factors are
 * Phase 9, and §41.1 means the absence of a factor produces no number rather than
 * a zero.
 */
export function computeMassBalance(assets: readonly AssetForBalance[]): MassBalance {
  let handledKg = 0;
  let allocatedKg = 0;
  let inStorageKg = 0;
  let unallocatedKg = 0;
  let linesWithWeight = 0;
  let documentedMassKg = 0;
  let hasUnknownMass = false;

  const byCode = new Map<string, DestinationMass>();
  const flagged = {
    reuse: 0,
    recycling: 0,
    recovery: 0,
    landfill: 0,
    diverted: 0,
    retainedInUse: 0,
  };

  for (const asset of assets) {
    const summary = summariseAsset(asset.line, asset.movements);
    handledKg += summary.handledKg;
    allocatedKg += summary.allocatedKg;
    inStorageKg += summary.inStorageKg;
    unallocatedKg += summary.unallocatedKg;
    if (summary.hasUnknownMass) hasUnknownMass = true;
    if (asset.line.unitWeightKg !== null) linesWithWeight += 1;
    if (asset.weightConfidence !== null && !isEstimatedConfidence(asset.weightConfidence)) {
      documentedMassKg += summary.handledKg;
    }

    for (const m of openMovements(asset.movements)) {
      if (!m.destination.isFinalOutcome) continue;
      const mass = movementMassKg(m, asset.line) ?? 0;
      const existing = byCode.get(m.destination.code);
      if (existing) existing.massKg += mass;
      else
        byCode.set(m.destination.code, {
          code: m.destination.code,
          hierarchyTier: m.destination.hierarchyTier,
          massKg: mass,
        });

      // Six independent flags, six independent sums. A destination may set
      // several — donation is reuse AND retained AND diverted — and §41.8 is
      // kept by never deriving one of these from another.
      if (m.destination.countsAsReuse) flagged.reuse += mass;
      if (m.destination.countsAsRecycling) flagged.recycling += mass;
      if (m.destination.countsAsRecovery) flagged.recovery += mass;
      if (m.destination.countsAsLandfill) flagged.landfill += mass;
      if (m.destination.countsAsDiverted) flagged.diverted += mass;
      if (m.destination.countsAsRetainedInUse) flagged.retainedInUse += mass;
    }
  }

  const rate = (mass: number): number | null => (allocatedKg > 0 ? mass / allocatedKg : null);

  return {
    handledKg,
    allocatedKg,
    pendingKg: inStorageKg + unallocatedKg,
    inStorageKg,
    unallocatedKg,
    byDestination: [...byCode.values()].sort((a, b) => {
      const at = a.hierarchyTier ?? Number.POSITIVE_INFINITY;
      const bt = b.hierarchyTier ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      return a.code.localeCompare(b.code);
    }),
    rates: {
      reuse: rate(flagged.reuse),
      recycling: rate(flagged.recycling),
      recovery: rate(flagged.recovery),
      landfill: rate(flagged.landfill),
      diverted: rate(flagged.diverted),
      retainedInUse: rate(flagged.retainedInUse),
    },
    lineCount: assets.length,
    linesWithWeight,
    documentedMassKg,
    hasUnknownMass,
  };
}

// ── Display (§25.3) ──────────────────────────────────────────────────────────

export const MASS_UNITS = ['KG', 'TONNE', 'AUTO'] as const;
export type MassUnit = (typeof MASS_UNITS)[number];

/**
 * §25.3: *"`< 1000 kg` shows kg to 1dp, `≥ 1000 kg` shows tonnes to 2dp, unless
 * the org pins a unit in §39. Stored value is always kg at full precision."*
 *
 * **The §39 setting is a parameter, not a table** (packet §13.4). §39 arrives in
 * Phase 9; inventing a settings mechanism to hold one enum four weeks early is
 * the migration this packet exists to avoid. When it lands, the caller passes a
 * value instead of taking the default and this function does not change.
 *
 * This is also the **only** place a mass is rounded, which is §41.9's *"never
 * round mid-calculation"* enforced by there being nowhere else to do it.
 */
export function formatMassKg(kg: number, unit: MassUnit = 'AUTO'): string {
  const resolved = unit === 'AUTO' ? (Math.abs(kg) >= 1000 ? 'TONNE' : 'KG') : unit;
  if (resolved === 'TONNE') return `${(kg / 1000).toFixed(2)} t`;
  return `${kg.toFixed(1)} kg`;
}

/** A rate as a whole percent, or the em dash that says there is nothing to divide by. */
export function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** Quantities are `numeric(12,2)`: 42 chairs prints as 42, 2.5 tonnes of timber as 2.5. */
export function formatQuantity(quantity: number): string {
  return Number.isInteger(quantity) ? String(quantity) : String(Number(quantity.toFixed(2)));
}

// ── Data completeness gaps (§28.3) ───────────────────────────────────────────

/**
 * §28.3's named gaps — **and deliberately not its composite percentage.**
 *
 * The score has five weighted components and Phase 8 can compute four; the fifth
 * (*"avoided-emissions mass using a product-specific factor"*) is Phase 9 and
 * cannot exist here. A percentage published over four fifths of a definition
 * **changes meaning** when Phase 9 lands, downward, on projects nobody touched —
 * so a customer who screenshots 92% and later sees 74% has been told something
 * false by both. The gaps have no such problem: each is true on its own.
 *
 * §28.3's own words for what these are: *"generated data, not hand-written copy"*,
 * and they appear in the UI **and** in the report — *"a report that quietly omits
 * its own gaps is the failure mode this whole section exists to prevent."*
 */
export function describeGaps(
  balance: MassBalance,
  opts: { massUnit?: MassUnit } = {}
): string[] {
  const gaps: string[] = [];
  const unit = opts.massUnit ?? 'AUTO';

  if (balance.lineCount > 0 && balance.linesWithWeight < balance.lineCount) {
    const missing = balance.lineCount - balance.linesWithWeight;
    // "1 of 2 asset lines has", not "1 of 2 asset line has": the noun agrees with
    // the set being counted over and only the verb agrees with the count. These
    // sentences reach a client's report (§28.3), so the grammar is not cosmetic.
    gaps.push(
      `${missing} of ${balance.lineCount} asset lines ${missing === 1 ? 'has' : 'have'} no weight recorded.`
    );
  }

  if (balance.handledKg > 0) {
    const estimatedKg = balance.handledKg - balance.documentedMassKg;
    if (estimatedKg > 0) {
      const pct = Math.round((estimatedKg / balance.handledKg) * 100);
      if (pct > 0) gaps.push(`${pct}% of project weight is estimated.`);
    }
  }

  if (balance.inStorageKg > 0) {
    gaps.push(
      `Final destination for ${formatMassKg(balance.inStorageKg, unit)} of stored material is currently unknown.`
    );
  }

  if (balance.unallocatedKg > 0) {
    gaps.push(
      `${formatMassKg(balance.unallocatedKg, unit)} has been recorded but not yet allocated to a destination.`
    );
  }

  if (balance.hasUnknownMass) {
    gaps.push(
      'Some material has no weight at all, so every mass figure on this project is a minimum rather than a total.'
    );
  }

  return gaps;
}

// ── Write schemas ────────────────────────────────────────────────────────────

export const TRACKING_MODES = ['BULK', 'ITEM'] as const;
export const trackingModeSchema = z.enum(TRACKING_MODES);
export type TrackingMode = z.infer<typeof trackingModeSchema>;

export const ASSET_CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'SCRAP'] as const;
export const assetConditionSchema = z.enum(ASSET_CONDITIONS);
export type AssetCondition = z.infer<typeof assetConditionSchema>;

const quantity = z.number().min(0).max(1_000_000);
const massKg = z.number().min(0).max(100_000_000);

const assetMetadata = z.object({
  description: z.string().trim().max(500).nullable(),
  quantity,
  weightBasis: weightBasisSchema.nullable(),
  unitWeightKg: massKg.nullable(),
  totalWeightKg: massKg.nullable(),
  weightSource: weightSourceSchema.nullable(),
  weightConfidence: weightConfidenceSchema.nullable(),
  weightDocumentId: z.string().uuid().nullable(),
  weighedByUserId: z.string().uuid().nullable(),
  manufacturer: z.string().trim().max(200).nullable(),
  model: z.string().trim().max(200).nullable(),
  serialNumber: z.string().trim().max(200).nullable(),
  assetTag: z.string().trim().max(200).nullable(),
  condition: assetConditionSchema.nullable(),
  originLocationId: z.string().uuid().nullable(),
  notes: z.string().trim().max(4000).nullable(),
});

/**
 * **`outcomeState` is absent, and its absence is the design.** §25.4 rule 2 makes
 * it derived; a field here would let a caller type `FINAL` onto a line with no
 * movements, and the register would report a destination nobody recorded.
 */
export const createAssetSchema = assetMetadata.partial().extend({
  assetTypeId: z.string().uuid(),
  trackingMode: trackingModeSchema.default('BULK'),
  quantity: quantity.default(1),
  /** Idempotency key for a retry that could not tell whether it landed (item 7.7). */
  clientId: z.string().uuid().optional(),
});
export type CreateAsset = z.infer<typeof createAssetSchema>;

export const updateAssetSchema = assetMetadata
  .extend({
    assetTypeId: z.string().uuid(),
    trackingMode: trackingModeSchema,
    /** The revision this edit was composed against (item 7.7). Optional by design. */
    expectedRevision: z.number().int().min(1),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateAsset = z.infer<typeof updateAssetSchema>;

/**
 * One row of a pasted schedule.
 *
 * **It names its asset type by `assetTypeCode`, not only by `assetTypeId`**, and
 * that is the difference between an importer and a form with more fields. What
 * somebody pastes out of a client's asset schedule is text — `OPERATOR_CHAIR`,
 * `Desk` — and a caller that could only supply a uuid would have to resolve every
 * type itself before pasting, which is the work the import exists to save. A row
 * may give either; giving both is a contradiction rather than a convenience,
 * because the two can disagree and nothing here could say which was meant.
 */
export const importAssetRowSchema = createAssetSchema
  .omit({ clientId: true, assetTypeId: true })
  .extend({
    assetTypeId: z.string().uuid().optional(),
    /** Matched case-insensitively against the company catalog, then the system one. */
    assetTypeCode: z.string().trim().min(1).max(100).optional(),
  })
  .refine((v) => (v.assetTypeId === undefined) !== (v.assetTypeCode === undefined), {
    message: 'Give either an asset type id or an asset type code, not both',
  });
export type ImportAssetRow = z.infer<typeof importAssetRowSchema>;

/**
 * A pasted schedule. **One `clientId` for the batch, and partial success is the
 * design** (packet §8): sixty rows where four name an unknown type import
 * fifty-six and return four errors by row number. Rolling back all sixty means a
 * person retypes fifty-nine rows identically, and they will get one of them wrong.
 *
 * The 500 cap is a paste, not a migration. §12 of the packet is explicit that any
 * v1 customer-data onboarding needs its own specification; an importer that
 * quietly accepts fifty thousand rows becomes that, without one.
 */
export const importAssetsSchema = z.object({
  rows: z.array(importAssetRowSchema).min(1).max(500),
  clientId: z.string().uuid().optional(),
});
export type ImportAssets = z.infer<typeof importAssetsSchema>;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const createMovementSchema = z.object({
  destinationTypeId: z.string().uuid(),
  destinationOrgId: z.string().uuid().nullable().default(null),
  destinationAddress: z.string().trim().max(500).nullable().default(null),
  fromLocationId: z.string().uuid().nullable().default(null),
  quantity,
  /** Null means derive from the line. A value is an overriding claim (finding 4). */
  weightKg: massKg.nullable().default(null),
  movedOn: dateOnly,
  distanceKm: z.number().min(0).max(100_000).nullable().default(null),
  documentId: z.string().uuid().nullable().default(null),
  notes: z.string().trim().max(4000).nullable().default(null),
  clientId: z.string().uuid().optional(),
});
export type CreateMovement = z.infer<typeof createMovementSchema>;

/**
 * Carrying material onward from a non-final destination.
 *
 * A separate route from `createMovement` rather than a nullable field on it,
 * because the guards are different and the mistake is expensive: a continuation
 * silently written as a fresh movement is finding 1's double-count, back again
 * through a field somebody added because it seemed symmetrical.
 */
export const continueMovementSchema = createMovementSchema;
export type ContinueMovement = z.infer<typeof continueMovementSchema>;

/**
 * Correcting a movement.
 *
 * **`continuesMovementId` is not here**, and its absence is the design. Re-pointing
 * a chain through a patch would let somebody detach a storage leg from its outcome
 * and leave both open — 12 chairs counted in the warehouse and 12 counted as
 * recycled, from a line of 42 that also donated 30. The chain is written once, by
 * the route that exists to write it.
 */
export const updateMovementSchema = createMovementSchema
  .omit({ clientId: true })
  .partial()
  .extend({ expectedRevision: z.number().int().min(1).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateMovement = z.infer<typeof updateMovementSchema>;

export const DESTINATION_ORG_KINDS = [
  'CHARITY',
  'REUSE_ORG',
  'RECYCLER',
  'STORAGE',
  'RESELLER',
  'WASTE_CONTRACTOR',
  'CLIENT_SITE',
  'MANUFACTURER',
  'OTHER',
] as const;
export const destinationOrgKindSchema = z.enum(DESTINATION_ORG_KINDS);
export type DestinationOrgKind = z.infer<typeof destinationOrgKindSchema>;

export const DESTINATION_ORG_KIND_LABELS: Readonly<Record<DestinationOrgKind, string>> = {
  CHARITY: 'Charity',
  REUSE_ORG: 'Reuse organisation',
  RECYCLER: 'Recycler',
  STORAGE: 'Storage facility',
  RESELLER: 'Reseller',
  WASTE_CONTRACTOR: 'Waste contractor',
  CLIENT_SITE: 'Client site',
  MANUFACTURER: 'Manufacturer',
  OTHER: 'Other',
};

// ── Events (§5 of the packet) ────────────────────────────────────────────────

/**
 * The payload of `asset.lines_recorded`, built by an **allowlist**.
 *
 * The same discipline `evidenceBatchEventPayload` uses, and here it is protecting
 * a stronger field than a filename. §11 excludes descriptions, manufacturer,
 * model, notes and destination names — and **serial numbers**, which identify a
 * specific physical machine, usually with a client's asset tag on it, and would
 * otherwise travel to an email provider as an ordinary string.
 *
 * What survives is counts, masses and type codes: enough to say *"12 items —
 * 340 kg — recorded"* and nothing that names what they are or whose they were.
 */
export function assetLinesRecordedEventPayload(args: {
  projectId: string;
  ownerCompanyId: string;
  recordingCompanyId: string;
  actorUserId: string;
  batchClientId: string | null;
  rows: readonly { assetTypeCode: string; quantity: number; totalWeightKg: number | null }[];
}): Record<string, string | number | string[] | null> {
  const weighed = args.rows.filter((r) => r.totalWeightKg !== null);
  return {
    projectId: args.projectId,
    ownerCompanyId: args.ownerCompanyId,
    recordingCompanyId: args.recordingCompanyId,
    actorUserId: args.actorUserId,
    batchClientId: args.batchClientId,
    lineCount: args.rows.length,
    totalQuantity: args.rows.reduce((sum, r) => sum + r.quantity, 0),
    // Null rather than 0 when nothing was weighed. A zero here would read as
    // "they recorded nothing heavy" rather than "nobody has weighed it yet",
    // and the notification composed from it would say the wrong thing.
    totalWeightKg: weighed.length > 0 ? weighed.reduce((s, r) => s + (r.totalWeightKg ?? 0), 0) : null,
    linesWithoutWeight: args.rows.length - weighed.length,
    assetTypeCodes: [...new Set(args.rows.map((r) => r.assetTypeCode))].sort(),
  };
}

const destinationOrgFields = z.object({
  name: z.string().trim().min(1).max(300),
  kind: destinationOrgKindSchema,
  /**
   * Only a company this one already has an engagement edge with, checked in the
   * API. §23's `provider_company_id` got the same bound in Phase 7 for the same
   * reason: "Redstone Reuse take our donations" is an assertion about a named
   * business, in a record that business cannot see and cannot contest.
   */
  linkedCompanyId: z.string().uuid().nullable(),
  address: z.string().trim().max(500).nullable(),
  /**
   * A third party's personal data, held about somebody with no CrewQuo account,
   * no consent flow and no way to ask what is held about them. Optional by
   * design, and no screen pushes for them (packet §7).
   */
  contactName: z.string().trim().max(200).nullable(),
  contactEmail: z.string().trim().email().max(320).nullable(),
  contactPhone: z.string().trim().max(60).nullable(),
  /** A waste carrier licence or permit number. Recorded and shown; never blocking. */
  licenceNumber: z.string().trim().max(120).nullable(),
  licenceExpiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').nullable(),
  notes: z.string().trim().max(4000).nullable(),
});

export const createDestinationOrgSchema = destinationOrgFields.partial().extend({
  name: z.string().trim().min(1).max(300),
  kind: destinationOrgKindSchema,
  clientId: z.string().uuid().optional(),
});
export type CreateDestinationOrg = z.infer<typeof createDestinationOrgSchema>;

export const updateDestinationOrgSchema = destinationOrgFields
  .extend({
    /** `false` retires it. The row stays, because a two-year-old movement names it. */
    active: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateDestinationOrg = z.infer<typeof updateDestinationOrgSchema>;
