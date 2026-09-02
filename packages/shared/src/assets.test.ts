import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIDENCE_FOR_SOURCE,
  assetLinesRecordedEventPayload,
  importAssetRowSchema,
  importAssetsSchema,
  SYSTEM_ASSET_TYPES,
  SYSTEM_DESTINATION_TYPES,
  WEIGHT_SOURCES,
  canContinueMovement,
  canRecordMovement,
  compareByHierarchy,
  computeMassBalance,
  createAssetSchema,
  deriveOutcomeState,
  deriveWeights,
  describeGaps,
  documentRequiredFor,
  formatMassKg,
  formatQuantity,
  formatRate,
  isEstimatedConfidence,
  movementMassKg,
  openMovements,
  remainingQuantity,
  resolveTypeCatalog,
  resolveWeightConfidence,
  reweighForQuantity,
  summariseAsset,
  updateAssetSchema,
  type AssetForBalance,
  type DestinationSemantics,
  type MovementRow,
  type WeightConfidence,
} from './assets';

/**
 * The Phase 8 policy, tested before the table exists (packet §14 step 0).
 *
 * These are the masses §26–§29 multiply by factors, so a branch that is wrong
 * here is wrong in a client's carbon report with a full audit trail behind it.
 * The suite is organised the way the packet's findings are: the catalogs, the
 * weight algebra, the ledger, the balance — and then the invariant that ties
 * them together.
 */

const semantics = (code: string): DestinationSemantics => {
  const row = SYSTEM_DESTINATION_TYPES.find((d) => d.code === code);
  if (!row) throw new Error(`no such destination: ${code}`);
  const { name: _name, sortOrder: _sortOrder, ...rest } = row;
  return rest;
};

let seq = 0;
const move = (
  code: string,
  quantity: number,
  opts: { id?: string; weightKg?: number | null; continues?: string | null } = {}
): MovementRow => ({
  id: opts.id ?? `m${++seq}`,
  continuesMovementId: opts.continues ?? null,
  quantity,
  weightKg: opts.weightKg ?? null,
  destination: semantics(code),
});

// ── §25.1 the asset catalog ──────────────────────────────────────────────────

describe('the seeded asset catalog (§25.1)', () => {
  it('ships the 22 system types', () => {
    expect(SYSTEM_ASSET_TYPES).toHaveLength(22);
  });

  it('has unique codes', () => {
    const codes = SYSTEM_ASSET_TYPES.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  /**
   * §41.1, and the whole reason the catalog is data rather than a spreadsheet
   * somebody filled in: *"A shipped default weight is an invented number that
   * silently becomes a reported tonne."* This asserts the absence structurally —
   * there is no key to fill in, so filling one in is a type error rather than a
   * plausible pull request.
   */
  it('carries no default weight on any type, not even a null one', () => {
    for (const type of SYSTEM_ASSET_TYPES) {
      expect(Object.keys(type)).toEqual(['code', 'name', 'category', 'sortOrder']);
    }
  });
});

describe('resolveTypeCatalog', () => {
  it('returns system rows when a company has none', () => {
    const rows = [
      { code: 'DESK', companyId: null },
      { code: 'SOFA', companyId: null },
    ];
    expect(resolveTypeCatalog(rows).map((r) => r.code).sort()).toEqual(['DESK', 'SOFA']);
  });

  it('lets a company row shadow the system row with the same code', () => {
    const rows = [
      { code: 'DESK', companyId: null, name: 'system' },
      { code: 'DESK', companyId: 'c1', name: 'ours' },
    ];
    const out = resolveTypeCatalog(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('ours');
  });

  it('shadows in either input order', () => {
    const rows = [
      { code: 'DESK', companyId: 'c1', name: 'ours' },
      { code: 'DESK', companyId: null, name: 'system' },
    ];
    expect(resolveTypeCatalog(rows)[0]?.name).toBe('ours');
  });
});

// ── §25.4 the destination seed ───────────────────────────────────────────────

describe('the seeded destinations (§25.4)', () => {
  it('ships the eleven', () => {
    expect(SYSTEM_DESTINATION_TYPES).toHaveLength(11);
  });

  /**
   * Locked decision #18, asserted as one row rather than as a rule somewhere.
   * If this test ever fails, every diversion rate in the product has quietly
   * started counting a warehouse as an outcome.
   */
  it('gives STORAGE no tier, no counts-as flag, and no final outcome', () => {
    const storage = semantics('STORAGE');
    expect(storage.hierarchyTier).toBeNull();
    expect(storage.isFinalOutcome).toBe(false);
    expect(storage.countsAsReuse).toBe(false);
    expect(storage.countsAsRecycling).toBe(false);
    expect(storage.countsAsRecovery).toBe(false);
    expect(storage.countsAsLandfill).toBe(false);
    expect(storage.countsAsDiverted).toBe(false);
    expect(storage.countsAsRetainedInUse).toBe(false);
  });

  it('makes every other destination a final outcome', () => {
    for (const d of SYSTEM_DESTINATION_TYPES) {
      if (d.code === 'STORAGE') continue;
      expect(d.isFinalOutcome).toBe(true);
      expect(d.hierarchyTier).not.toBeNull();
    }
  });

  /** §41.8: *"'Diverted from landfill' is not 'reused.'"* */
  it('keeps reuse and diversion as separate flags', () => {
    const recycling = semantics('RECYCLING');
    expect(recycling.countsAsDiverted).toBe(true);
    expect(recycling.countsAsReuse).toBe(false);
  });

  it('does not count landfill or other disposal as diverted', () => {
    expect(semantics('LANDFILL').countsAsDiverted).toBe(false);
    expect(semantics('OTHER_DISPOSAL').countsAsDiverted).toBe(false);
    expect(semantics('LANDFILL').countsAsLandfill).toBe(true);
    expect(semantics('OTHER_DISPOSAL').countsAsLandfill).toBe(true);
  });

  it('marks the six reuse-shaped destinations as displacing a replacement', () => {
    const displacing = SYSTEM_DESTINATION_TYPES.filter((d) => d.displacesReplacement).map(
      (d) => d.code
    );
    expect(displacing).toEqual(['RELOCATED', 'REUSE', 'REFURBISHMENT', 'DONATION', 'RESALE']);
  });

  it('does not let recycling displace a replacement', () => {
    expect(semantics('RECYCLING').displacesReplacement).toBe(false);
  });
});

describe('compareByHierarchy (§25.5)', () => {
  it('ranks reuse above recycling', () => {
    expect(compareByHierarchy(semantics('DONATION'), semantics('RECYCLING'))).toBeLessThan(0);
  });

  it('ranks retention above reuse and recycling above landfill', () => {
    expect(compareByHierarchy(semantics('RETAINED'), semantics('REUSE'))).toBeLessThan(0);
    expect(compareByHierarchy(semantics('RECYCLING'), semantics('LANDFILL'))).toBeLessThan(0);
  });

  it('sorts storage last, since it is not an outcome to rank', () => {
    expect(compareByHierarchy(semantics('STORAGE'), semantics('LANDFILL'))).toBeGreaterThan(0);
  });

  it('breaks a tier tie by code, so a list reads the same every time', () => {
    const sorted = [...SYSTEM_DESTINATION_TYPES].sort(compareByHierarchy).map((d) => d.code);
    expect(sorted.slice(0, 2)).toEqual(['RELOCATED', 'RETAINED']);
    expect(sorted[sorted.length - 1]).toBe('STORAGE');
  });
});

// ── §25.3 weight provenance ──────────────────────────────────────────────────

describe('weight provenance (§25.3)', () => {
  it('maps all seven sources to the confidence the plan gives them', () => {
    expect(DEFAULT_CONFIDENCE_FOR_SOURCE).toEqual({
      WEIGHED: 'VERIFIED',
      WEIGHBRIDGE: 'VERIFIED',
      TRANSFER_NOTE: 'DOCUMENTED',
      SUPPLIER_DOC: 'DOCUMENTED',
      PRODUCT_SPEC: 'DOCUMENTED',
      USER_ESTIMATE: 'ESTIMATED',
      SYSTEM_ESTIMATE: 'APPROXIMATE',
    });
    expect(Object.keys(DEFAULT_CONFIDENCE_FOR_SOURCE).sort()).toEqual([...WEIGHT_SOURCES].sort());
  });

  it('derives weight_is_estimated from the confidence', () => {
    expect(isEstimatedConfidence('ESTIMATED')).toBe(true);
    expect(isEstimatedConfidence('APPROXIMATE')).toBe(true);
    expect(isEstimatedConfidence('VERIFIED')).toBe(false);
    expect(isEstimatedConfidence('DOCUMENTED')).toBe(false);
  });

  it('requires a document for every non-estimated source except WEIGHED', () => {
    expect(documentRequiredFor('WEIGHBRIDGE', 'VERIFIED')).toBe(true);
    expect(documentRequiredFor('TRANSFER_NOTE', 'DOCUMENTED')).toBe(true);
    expect(documentRequiredFor('SUPPLIER_DOC', 'DOCUMENTED')).toBe(true);
    expect(documentRequiredFor('PRODUCT_SPEC', 'DOCUMENTED')).toBe(true);
    expect(documentRequiredFor('WEIGHED', 'VERIFIED')).toBe(false);
  });

  it('requires no document for an estimate', () => {
    expect(documentRequiredFor('USER_ESTIMATE', 'ESTIMATED')).toBe(false);
    expect(documentRequiredFor('SYSTEM_ESTIMATE', 'APPROXIMATE')).toBe(false);
  });
});

describe('resolveWeightConfidence', () => {
  const base = { hasDocument: true, hasWeigher: true, canVerify: true };

  it('takes the source default when nothing is requested', () => {
    const out = resolveWeightConfidence({ source: 'WEIGHBRIDGE', ...base });
    expect(out.confidence).toBe('VERIFIED');
    expect(out.refusal).toBeNull();
  });

  /** *"overridable downward but not upward"* — downward. */
  it('allows a downgrade', () => {
    const out = resolveWeightConfidence({
      source: 'WEIGHBRIDGE',
      requested: 'ESTIMATED',
      ...base,
    });
    expect(out.confidence).toBe('ESTIMATED');
    expect(out.isEstimated).toBe(true);
    expect(out.refusal).toBeNull();
  });

  it('refuses an upgrade above what the source can support', () => {
    const out = resolveWeightConfidence({
      source: 'USER_ESTIMATE',
      requested: 'VERIFIED',
      ...base,
    });
    expect(out.confidence).toBe('ESTIMATED');
    expect(out.refusal?.code).toBe('UPGRADE_NOT_ALLOWED');
  });

  it('refuses a SYSTEM_ESTIMATE dressed up as documented', () => {
    const out = resolveWeightConfidence({
      source: 'SYSTEM_ESTIMATE',
      requested: 'DOCUMENTED',
      ...base,
    });
    expect(out.confidence).toBe('APPROXIMATE');
    expect(out.refusal?.code).toBe('UPGRADE_NOT_ALLOWED');
  });

  it('refuses VERIFIED or DOCUMENTED without the attached document', () => {
    const out = resolveWeightConfidence({
      source: 'WEIGHBRIDGE',
      requested: 'VERIFIED',
      hasDocument: false,
      hasWeigher: true,
      canVerify: true,
    });
    expect(out.confidence).toBe('ESTIMATED');
    expect(out.refusal?.code).toBe('DOCUMENT_REQUIRED');
  });

  it('refuses a WEIGHED claim with no named weigher', () => {
    const out = resolveWeightConfidence({
      source: 'WEIGHED',
      requested: 'VERIFIED',
      hasDocument: false,
      hasWeigher: false,
      canVerify: true,
    });
    expect(out.confidence).toBe('ESTIMATED');
    expect(out.refusal?.code).toBe('WEIGHER_REQUIRED');
  });

  it('accepts a WEIGHED claim with a weigher and no document', () => {
    const out = resolveWeightConfidence({
      source: 'WEIGHED',
      requested: 'VERIFIED',
      hasDocument: false,
      hasWeigher: true,
      canVerify: true,
    });
    expect(out.confidence).toBe('VERIFIED');
    expect(out.refusal).toBeNull();
  });

  /**
   * The packet's §9: *"the permission failure saves the work."* Ekene's 16.5 kg
   * is data the product exists to collect, and losing it to protect a label
   * teaches people to hand the phone to whoever has the bigger role.
   */
  it('degrades rather than refusing when the person lacks asset.weight.verify', () => {
    const out = resolveWeightConfidence({
      source: 'WEIGHED',
      requested: 'VERIFIED',
      hasDocument: true,
      hasWeigher: true,
      canVerify: false,
    });
    expect(out.confidence).toBe('ESTIMATED');
    expect(out.isEstimated).toBe(true);
    expect(out.refusal?.code).toBe('UPGRADE_NOT_ALLOWED');
    expect(out.refusal?.message).toContain('weight-verification permission');
  });

  it('lets someone without the permission record an estimate normally', () => {
    const out = resolveWeightConfidence({
      source: 'USER_ESTIMATE',
      hasDocument: false,
      hasWeigher: false,
      canVerify: false,
    });
    expect(out.confidence).toBe('ESTIMATED');
    expect(out.refusal).toBeNull();
  });

  it('degrades a SYSTEM_ESTIMATE to APPROXIMATE rather than to ESTIMATED', () => {
    const out = resolveWeightConfidence({
      source: 'SYSTEM_ESTIMATE',
      requested: 'APPROXIMATE',
      hasDocument: false,
      hasWeigher: false,
      canVerify: false,
    });
    expect(out.confidence).toBe('APPROXIMATE');
    expect(out.refusal).toBeNull();
  });
});

// ── §25.2 weight algebra ─────────────────────────────────────────────────────

describe('deriveWeights (§25.2)', () => {
  it('derives the total from a unit weight', () => {
    expect(deriveWeights({ basis: 'UNIT', quantity: 42, unitWeightKg: 16.5, totalWeightKg: null }))
      .toEqual({ unitWeightKg: 16.5, totalWeightKg: 693 });
  });

  it('derives the unit weight from a total', () => {
    expect(deriveWeights({ basis: 'TOTAL', quantity: 42, unitWeightKg: null, totalWeightKg: 693 }))
      .toEqual({ unitWeightKg: 16.5, totalWeightKg: 693 });
  });

  /**
   * §25.2: *"A line with neither weight is valid — it just contributes nothing
   * to mass metrics and drags down data completeness, which is the correct
   * incentive."* Null is a gap; zero would be a claim.
   */
  it('returns null for a line with no basis', () => {
    expect(deriveWeights({ basis: null, quantity: 42, unitWeightKg: 16.5, totalWeightKg: 693 }))
      .toBeNull();
  });

  it('returns null when the entered side is missing', () => {
    expect(deriveWeights({ basis: 'UNIT', quantity: 42, unitWeightKg: null, totalWeightKg: 693 }))
      .toBeNull();
    expect(deriveWeights({ basis: 'TOTAL', quantity: 42, unitWeightKg: 16.5, totalWeightKg: null }))
      .toBeNull();
  });

  it('keeps a zero weight, which is a claim rather than a gap', () => {
    expect(deriveWeights({ basis: 'UNIT', quantity: 42, unitWeightKg: 0, totalWeightKg: null }))
      .toEqual({ unitWeightKg: 0, totalWeightKg: 0 });
  });

  /** No NaN, no Infinity, and nothing that later renders as "∞ kg". */
  it('does not divide a total by a zero quantity', () => {
    const out = deriveWeights({ basis: 'TOTAL', quantity: 0, unitWeightKg: null, totalWeightKg: 693 });
    expect(out).toEqual({ unitWeightKg: 0, totalWeightKg: 693 });
    expect(Number.isFinite(out?.unitWeightKg)).toBe(true);
  });

  it('scales a unit-basis line by a zero quantity to zero total', () => {
    expect(deriveWeights({ basis: 'UNIT', quantity: 0, unitWeightKg: 16.5, totalWeightKg: null }))
      .toEqual({ unitWeightKg: 16.5, totalWeightKg: 0 });
  });
});

describe('reweighForQuantity (§25.2)', () => {
  /** 42 → 50 chairs at 16.5 kg is 825 kg, not 16.5 kg spread thinner. */
  it('recomputes the total on a UNIT line', () => {
    expect(
      reweighForQuantity({ basis: 'UNIT', newQuantity: 50, unitWeightKg: 16.5, totalWeightKg: 693 })
    ).toEqual({ unitWeightKg: 16.5, totalWeightKg: 825 });
  });

  /** The weighbridge said 693 kg went out; finding four more chairs on the dock
   * does not make the lorry heavier. */
  it('recomputes the unit weight on a TOTAL line and leaves the total alone', () => {
    const out = reweighForQuantity({
      basis: 'TOTAL',
      newQuantity: 46,
      unitWeightKg: 16.5,
      totalWeightKg: 693,
    });
    expect(out?.totalWeightKg).toBe(693);
    expect(out?.unitWeightKg).toBeCloseTo(15.065, 3);
  });

  it('leaves a weightless line weightless', () => {
    expect(
      reweighForQuantity({ basis: null, newQuantity: 50, unitWeightKg: null, totalWeightKg: null })
    ).toBeNull();
  });
});

// ── §25.4 the ledger ─────────────────────────────────────────────────────────

describe('openMovements — the packet §13.1 chain', () => {
  it('returns everything when nothing is continued', () => {
    const ms = [move('DONATION', 30), move('RECYCLING', 12)];
    expect(openMovements(ms)).toHaveLength(2);
  });

  it('drops a movement that a later one continues', () => {
    const stored = move('STORAGE', 12, { id: 'a' });
    const recycled = move('RECYCLING', 12, { id: 'b', continues: 'a' });
    expect(openMovements([stored, recycled]).map((m) => m.id)).toEqual(['b']);
  });

  it('keeps a chain of three down to its leaf', () => {
    const ms = [
      move('STORAGE', 12, { id: 'a' }),
      move('STORAGE', 12, { id: 'b', continues: 'a' }),
      move('RESALE', 12, { id: 'c', continues: 'b' }),
    ];
    expect(openMovements(ms).map((m) => m.id)).toEqual(['c']);
  });
});

describe('movementMassKg', () => {
  it('derives from the line when the movement asserts no weight', () => {
    expect(movementMassKg(move('DONATION', 30), { quantity: 42, unitWeightKg: 16.5 })).toBe(495);
  });

  it('uses the movement’s own claim when it has one', () => {
    expect(
      movementMassKg(move('RECYCLING', 12, { weightKg: 205 }), { quantity: 42, unitWeightKg: 16.5 })
    ).toBe(205);
  });

  it('is null when neither the movement nor the line knows', () => {
    expect(movementMassKg(move('DONATION', 30), { quantity: 42, unitWeightKg: null })).toBeNull();
  });

  it('uses a zero override rather than falling back to the line', () => {
    expect(
      movementMassKg(move('DONATION', 30, { weightKg: 0 }), { quantity: 42, unitWeightKg: 16.5 })
    ).toBe(0);
  });
});

describe('deriveOutcomeState (§25.4 rule 2)', () => {
  it('is PENDING with no movements', () => {
    expect(deriveOutcomeState(42, 0, 0)).toBe('PENDING');
  });

  it('is FINAL when the whole quantity reached a final outcome', () => {
    expect(deriveOutcomeState(42, 42, 0)).toBe('FINAL');
  });

  it('is IN_STORAGE when the whole quantity is in storage', () => {
    expect(deriveOutcomeState(42, 0, 42)).toBe('IN_STORAGE');
  });

  /**
   * The packet's §0 finding 2. Read as *"the latest movement is non-final"*, a
   * line 30 donated and 12 stored reports IN_STORAGE and the donation leaves the
   * reuse numerator.
   */
  it('is PARTIAL when some is final and some is stored', () => {
    expect(deriveOutcomeState(42, 30, 12)).toBe('PARTIAL');
  });

  it('is PARTIAL when some is allocated and the rest is untouched', () => {
    expect(deriveOutcomeState(42, 30, 0)).toBe('PARTIAL');
  });

  it('is PARTIAL when some is stored and the rest is untouched', () => {
    expect(deriveOutcomeState(42, 0, 12)).toBe('PARTIAL');
  });

  it('treats a zero-quantity line as PENDING rather than FINAL', () => {
    expect(deriveOutcomeState(0, 0, 0)).toBe('PENDING');
  });
});

describe('summariseAsset', () => {
  const line = { quantity: 42, unitWeightKg: 16.5 };

  it('reports a fresh line as entirely unallocated', () => {
    const s = summariseAsset(line, []);
    expect(s.handledKg).toBe(693);
    expect(s.allocatedKg).toBe(0);
    expect(s.pendingKg).toBe(693);
    expect(s.outcomeState).toBe('PENDING');
  });

  /** The milestone: 42 in, 30 donated / 12 recycled out. */
  it('splits 30 donated and 12 recycled', () => {
    const s = summariseAsset(line, [move('DONATION', 30), move('RECYCLING', 12)]);
    expect(s.allocatedKg).toBe(693);
    expect(s.pendingKg).toBe(0);
    expect(s.handledKg).toBe(693);
    expect(s.outcomeState).toBe('FINAL');
  });

  /** Decision #18: storage is pending, not an outcome. */
  it('keeps stored material out of allocated mass', () => {
    const s = summariseAsset(line, [move('DONATION', 30), move('STORAGE', 12)]);
    expect(s.allocatedKg).toBe(495);
    expect(s.inStorageKg).toBe(198);
    expect(s.unallocatedKg).toBe(0);
    expect(s.pendingKg).toBe(198);
    expect(s.handledKg).toBe(693);
    expect(s.outcomeState).toBe('PARTIAL');
  });

  /**
   * The finding that justified the packet. Rule 1 read literally refuses this
   * second movement; with the chain, the storage leg stops counting and the
   * totals stay whole.
   */
  it('moves material out of storage without double-counting it', () => {
    const s = summariseAsset(line, [
      move('DONATION', 30, { id: 'd' }),
      move('STORAGE', 12, { id: 's' }),
      move('RECYCLING', 12, { id: 'r', continues: 's' }),
    ]);
    expect(s.allocatedQuantity).toBe(42);
    expect(s.allocatedKg).toBe(693);
    expect(s.inStorageKg).toBe(0);
    expect(s.pendingKg).toBe(0);
    expect(s.handledKg).toBe(693);
    expect(s.outcomeState).toBe('FINAL');
  });

  /**
   * The packet's §12 step 8. Handled mass exceeds the line's own 693 kg because
   * the recycling load was weighed better than the estimate — §41.6 requires
   * that to survive into the total rather than be reconciled away.
   */
  it('lets an overriding movement weight raise the handled total', () => {
    const s = summariseAsset(line, [move('DONATION', 30), move('RECYCLING', 12, { weightKg: 205 })]);
    expect(s.allocatedKg).toBe(700);
    expect(s.handledKg).toBe(700);
    expect(s.unallocatedKg).toBe(0);
  });

  /** The arithmetic that would otherwise report −4.6 kg awaiting a destination. */
  it('never reports negative unallocated mass when a movement overrides upward', () => {
    const s = summariseAsset({ quantity: 42, unitWeightKg: 16.5 }, [
      move('DONATION', 30, { weightKg: 900 }),
    ]);
    expect(s.unallocatedQuantity).toBe(12);
    expect(s.unallocatedKg).toBe(198);
    expect(s.allocatedKg).toBe(900);
  });

  it('flags unknown mass on a weightless line and reports zero rather than NaN', () => {
    const s = summariseAsset({ quantity: 42, unitWeightKg: null }, [move('DONATION', 30)]);
    expect(s.hasUnknownMass).toBe(true);
    expect(s.allocatedKg).toBe(0);
    expect(s.handledKg).toBe(0);
    expect(s.allocatedQuantity).toBe(30);
  });

  it('does not flag unknown mass when every movement overrides its weight', () => {
    const s = summariseAsset({ quantity: 30, unitWeightKg: null }, [
      move('DONATION', 30, { weightKg: 495 }),
    ]);
    expect(s.hasUnknownMass).toBe(false);
    expect(s.allocatedKg).toBe(495);
  });
});

describe('the ceilings (§25.4 rule 1)', () => {
  const line = { quantity: 42, unitWeightKg: 16.5 };

  it('reports what is left', () => {
    expect(remainingQuantity(line, [move('DONATION', 30)])).toBe(12);
  });

  it('does not count a continued movement against the ceiling', () => {
    const ms = [
      move('STORAGE', 12, { id: 's' }),
      move('RECYCLING', 12, { id: 'r', continues: 's' }),
    ];
    expect(remainingQuantity(line, ms)).toBe(30);
  });

  it('allows a movement inside the remainder', () => {
    expect(canRecordMovement(line, [move('DONATION', 30)], 12)).toBeNull();
  });

  it('allows a movement that exactly fills the remainder', () => {
    expect(canRecordMovement(line, [move('DONATION', 42)], 0)).toBeNull();
  });

  it('refuses one that exceeds it, and says by how much is left', () => {
    const refusal = canRecordMovement(line, [move('DONATION', 30)], 13);
    expect(refusal?.code).toBe('EXCEEDS_REMAINING');
    expect(refusal?.message).toContain('Only 12 of 42');
    expect(refusal && 'remainingQuantity' in refusal && refusal.remainingQuantity).toBe(12);
  });

  it('says so plainly when nothing is left', () => {
    const refusal = canRecordMovement(line, [move('DONATION', 42)], 1);
    expect(refusal?.message).toContain('All 42 are already recorded');
  });
});

describe('canContinueMovement (§13.1)', () => {
  it('allows carrying stored material onward', () => {
    expect(canContinueMovement(move('STORAGE', 12, { id: 's' }), [], 12)).toBeNull();
  });

  it('allows a partial release from storage', () => {
    expect(canContinueMovement(move('STORAGE', 12, { id: 's' }), [], 5)).toBeNull();
  });

  /** A second claim on material already reported, not a correction. */
  it('refuses to continue a final-outcome movement', () => {
    const refusal = canContinueMovement(move('RECYCLING', 12, { id: 'r' }), [], 12);
    expect(refusal?.code).toBe('SOURCE_IS_FINAL');
  });

  /** A fork double-counts on the very next sum. */
  it('refuses to continue a movement that is already continued', () => {
    const source = move('STORAGE', 12, { id: 's' });
    const first = move('RESALE', 12, { id: 'r', continues: 's' });
    const refusal = canContinueMovement(source, [source, first], 12);
    expect(refusal?.code).toBe('ALREADY_CONTINUED');
  });

  it('refuses 15 chairs coming out of a warehouse that 12 went into', () => {
    const refusal = canContinueMovement(move('STORAGE', 12, { id: 's' }), [], 15);
    expect(refusal?.code).toBe('EXCEEDS_SOURCE');
    expect(refusal?.message).toContain('Only 12');
  });
});

// ── §28 the mass balance ─────────────────────────────────────────────────────

const asset = (
  line: { quantity: number; unitWeightKg: number | null },
  movements: MovementRow[],
  weightConfidence: WeightConfidence | null = 'ESTIMATED'
): AssetForBalance => ({ line, movements, weightConfidence, hasEvidenceOrDocument: false });

describe('computeMassBalance (§28.1, §28.2)', () => {
  it('reports nothing rather than zero rates for an empty project', () => {
    const b = computeMassBalance([]);
    expect(b.handledKg).toBe(0);
    expect(b.rates.diverted).toBeNull();
    expect(b.byDestination).toEqual([]);
  });

  /** A rate over nothing is not 0%; it is undefined, and saying 0% is a claim. */
  it('returns null rates when nothing has reached a final outcome', () => {
    const b = computeMassBalance([asset({ quantity: 42, unitWeightKg: 16.5 }, [move('STORAGE', 42)])]);
    expect(b.allocatedKg).toBe(0);
    expect(b.pendingKg).toBe(693);
    expect(b.rates.reuse).toBeNull();
    expect(b.rates.diverted).toBeNull();
  });

  it('computes the milestone split', () => {
    const b = computeMassBalance([
      asset({ quantity: 42, unitWeightKg: 16.5 }, [move('DONATION', 30), move('RECYCLING', 12)]),
    ]);
    expect(b.handledKg).toBe(693);
    expect(b.allocatedKg).toBe(693);
    expect(b.pendingKg).toBe(0);
    expect(b.rates.reuse).toBeCloseTo(495 / 693, 10);
    expect(b.rates.recycling).toBeCloseTo(198 / 693, 10);
    expect(b.rates.diverted).toBe(1);
    expect(b.rates.landfill).toBe(0);
  });

  /**
   * §28.2: *"Rates are over allocated mass, and pending mass is always shown
   * next to them. Hiding pending mass in a denominator is how a diversion rate
   * becomes a lie."*
   */
  it('divides by allocated mass and returns pending beside it', () => {
    const b = computeMassBalance([
      asset({ quantity: 42, unitWeightKg: 16.5 }, [move('DONATION', 30), move('STORAGE', 12)]),
    ]);
    expect(b.allocatedKg).toBe(495);
    expect(b.pendingKg).toBe(198);
    expect(b.handledKg).toBe(693);
    // Reuse is 100% of what was allocated, and the object cannot be rendered
    // without also holding the 198 kg that is not.
    expect(b.rates.reuse).toBe(1);
  });

  /** §41.8, at the level of the returned object rather than of a screen. */
  it('keeps reuse and diversion as separate figures when they differ', () => {
    const b = computeMassBalance([
      asset({ quantity: 10, unitWeightKg: 10 }, [move('DONATION', 5), move('RECYCLING', 5)]),
    ]);
    expect(b.rates.reuse).toBe(0.5);
    expect(b.rates.diverted).toBe(1);
  });

  it('counts landfill out of diversion', () => {
    const b = computeMassBalance([
      asset({ quantity: 10, unitWeightKg: 10 }, [move('RECYCLING', 6), move('LANDFILL', 4)]),
    ]);
    expect(b.rates.recycling).toBeCloseTo(0.6, 10);
    expect(b.rates.landfill).toBeCloseTo(0.4, 10);
    expect(b.rates.diverted).toBeCloseTo(0.6, 10);
  });

  it('orders destinations best hierarchy tier first', () => {
    const b = computeMassBalance([
      asset({ quantity: 30, unitWeightKg: 10 }, [
        move('LANDFILL', 10),
        move('RECYCLING', 10),
        move('DONATION', 10),
      ]),
    ]);
    expect(b.byDestination.map((d) => d.code)).toEqual(['DONATION', 'RECYCLING', 'LANDFILL']);
  });

  it('excludes storage from the destination breakdown entirely', () => {
    const b = computeMassBalance([
      asset({ quantity: 20, unitWeightKg: 10 }, [move('DONATION', 10), move('STORAGE', 10)]),
    ]);
    expect(b.byDestination.map((d) => d.code)).toEqual(['DONATION']);
  });

  it('sums across assets and counts lines with a weight', () => {
    const b = computeMassBalance([
      asset({ quantity: 42, unitWeightKg: 16.5 }, [move('DONATION', 42)]),
      asset({ quantity: 8, unitWeightKg: 30 }, [move('RECYCLING', 8)]),
      asset({ quantity: 3, unitWeightKg: null }, []),
    ]);
    expect(b.lineCount).toBe(3);
    expect(b.linesWithWeight).toBe(2);
    expect(b.allocatedKg).toBe(693 + 240);
    expect(b.hasUnknownMass).toBe(true);
  });

  it('counts documented mass only for non-estimated confidences', () => {
    const b = computeMassBalance([
      asset({ quantity: 10, unitWeightKg: 10 }, [move('DONATION', 10)], 'VERIFIED'),
      asset({ quantity: 10, unitWeightKg: 10 }, [move('DONATION', 10)], 'ESTIMATED'),
      asset({ quantity: 10, unitWeightKg: 10 }, [move('DONATION', 10)], 'DOCUMENTED'),
      asset({ quantity: 10, unitWeightKg: 10 }, [move('DONATION', 10)], 'APPROXIMATE'),
    ]);
    expect(b.handledKg).toBe(400);
    expect(b.documentedMassKg).toBe(200);
  });
});

// ── The invariant ────────────────────────────────────────────────────────────

/**
 * The property the packet's §12 is built to assert, tested directly rather than
 * inferred from the cases above: **handled mass is invariant under every movement
 * operation that asserts no new weight.** Recording, splitting, storing,
 * continuing, correcting a destination — none of them changes what came off the
 * floor.
 */
describe('the invariant: handled mass does not move unless somebody claims a weight', () => {
  const line = { quantity: 42, unitWeightKg: 16.5 };
  const handled = (ms: MovementRow[]) => summariseAsset(line, ms).handledKg;

  const stages: Array<[string, MovementRow[]]> = [
    ['nothing recorded', []],
    ['30 donated', [move('DONATION', 30, { id: 'd' })]],
    ['30 donated, 12 stored', [move('DONATION', 30, { id: 'd' }), move('STORAGE', 12, { id: 's' })]],
    [
      '12 carried out of storage to recycling',
      [
        move('DONATION', 30, { id: 'd' }),
        move('STORAGE', 12, { id: 's' }),
        move('RECYCLING', 12, { id: 'r', continues: 's' }),
      ],
    ],
    [
      'the recycling leg corrected to a landfill leg',
      [
        move('DONATION', 30, { id: 'd' }),
        move('STORAGE', 12, { id: 's' }),
        move('LANDFILL', 12, { id: 'r', continues: 's' }),
      ],
    ],
    [
      'the storage leg split, 5 resold and 7 still stored',
      [
        move('DONATION', 30, { id: 'd' }),
        move('STORAGE', 5, { id: 's1' }),
        move('RESALE', 5, { id: 'r1', continues: 's1' }),
        move('STORAGE', 7, { id: 's2' }),
      ],
    ],
  ];

  for (const [name, movements] of stages) {
    it(`is 693.0 kg after: ${name}`, () => {
      expect(handled(movements)).toBe(693);
    });
  }

  it('moves only when a weight is asserted', () => {
    const overridden = [move('DONATION', 30), move('RECYCLING', 12, { weightKg: 205 })];
    expect(handled(overridden)).toBe(700);
    expect(summariseAsset({ quantity: 42, unitWeightKg: 16.7 }, []).handledKg).toBeCloseTo(701.4, 10);
  });
});

// ── Display and gaps ─────────────────────────────────────────────────────────

describe('formatMassKg (§25.3)', () => {
  it('shows kilograms to 1dp below a tonne', () => {
    expect(formatMassKg(693)).toBe('693.0 kg');
    expect(formatMassKg(0)).toBe('0.0 kg');
    expect(formatMassKg(999.94)).toBe('999.9 kg');
  });

  it('shows tonnes to 2dp at a tonne and above', () => {
    expect(formatMassKg(1000)).toBe('1.00 t');
    expect(formatMassKg(21_720)).toBe('21.72 t');
  });

  /** §13.4: the §39 setting is a parameter, not a table. */
  it('honours a pinned unit in either direction', () => {
    expect(formatMassKg(693, 'TONNE')).toBe('0.69 t');
    expect(formatMassKg(21_720, 'KG')).toBe('21720.0 kg');
  });

  /** §41.9: rounding happens here and nowhere else. */
  it('rounds only at the boundary, never mid-calculation', () => {
    const third = 1000 / 3;
    expect(formatMassKg(third * 3)).toBe('1.00 t');
  });
});

describe('formatRate and formatQuantity', () => {
  it('renders a rate as a whole percent', () => {
    expect(formatRate(0.9245)).toBe('92%');
    expect(formatRate(1)).toBe('100%');
    expect(formatRate(0)).toBe('0%');
  });

  it('renders an absent rate as an em dash rather than as zero', () => {
    expect(formatRate(null)).toBe('—');
  });

  it('renders whole quantities without a decimal and fractional ones with', () => {
    expect(formatQuantity(42)).toBe('42');
    expect(formatQuantity(2.5)).toBe('2.5');
    expect(formatQuantity(2.5)).not.toBe('2.50');
  });
});

describe('describeGaps (§28.3)', () => {
  it('says nothing about a complete project', () => {
    const b = computeMassBalance([
      asset({ quantity: 10, unitWeightKg: 10 }, [move('DONATION', 10)], 'VERIFIED'),
    ]);
    expect(describeGaps(b)).toEqual([]);
  });

  it('names lines with no weight', () => {
    const b = computeMassBalance([
      asset({ quantity: 10, unitWeightKg: 10 }, [move('DONATION', 10)], 'VERIFIED'),
      asset({ quantity: 3, unitWeightKg: null }, []),
    ]);
    expect(describeGaps(b)).toContainEqual('1 of 2 asset lines has no weight recorded.');
  });

  it('agrees the verb with the count and the noun with the set', () => {
    const b = computeMassBalance([
      asset({ quantity: 10, unitWeightKg: 10 }, [move('DONATION', 10)], 'VERIFIED'),
      asset({ quantity: 3, unitWeightKg: null }, []),
      asset({ quantity: 4, unitWeightKg: null }, []),
    ]);
    expect(describeGaps(b)).toContainEqual('2 of 3 asset lines have no weight recorded.');
  });

  it('names the estimated share of project weight', () => {
    const b = computeMassBalance([
      asset({ quantity: 10, unitWeightKg: 10 }, [move('DONATION', 10)], 'VERIFIED'),
      asset({ quantity: 10, unitWeightKg: 10 }, [move('DONATION', 10)], 'ESTIMATED'),
    ]);
    expect(describeGaps(b)).toContainEqual('50% of project weight is estimated.');
  });

  /** §28.3's own example sentence, generated rather than written. */
  it('names stored material with no final destination', () => {
    const b = computeMassBalance([
      asset({ quantity: 8, unitWeightKg: 30 }, [move('STORAGE', 8)], 'VERIFIED'),
    ]);
    expect(describeGaps(b)).toContainEqual(
      'Final destination for 240.0 kg of stored material is currently unknown.'
    );
  });

  it('names mass recorded but never allocated', () => {
    const b = computeMassBalance([asset({ quantity: 10, unitWeightKg: 10 }, [], 'VERIFIED')]);
    expect(describeGaps(b)).toContainEqual(
      '100.0 kg has been recorded but not yet allocated to a destination.'
    );
  });

  it('says every figure is a minimum when some mass is unknown', () => {
    const b = computeMassBalance([asset({ quantity: 3, unitWeightKg: null }, [])]);
    expect(describeGaps(b).some((g) => g.includes('minimum rather than a total'))).toBe(true);
  });

  it('honours a pinned display unit in its sentences', () => {
    const b = computeMassBalance([
      asset({ quantity: 100, unitWeightKg: 30 }, [move('STORAGE', 100)], 'VERIFIED'),
    ]);
    expect(describeGaps(b, { massUnit: 'TONNE' })).toContainEqual(
      'Final destination for 3.00 t of stored material is currently unknown.'
    );
  });
});

// ── Write schemas ────────────────────────────────────────────────────────────

describe('the write schemas', () => {
  it('defaults a new line to bulk tracking and a quantity of one', () => {
    const parsed = createAssetSchema.parse({ assetTypeId: crypto.randomUUID() });
    expect(parsed.trackingMode).toBe('BULK');
    expect(parsed.quantity).toBe(1);
  });

  /**
   * §25.4 rule 2 makes `outcome_state` derived. A field here would let a caller
   * type FINAL onto a line with no movements, and the register would report a
   * destination nobody recorded.
   */
  it('has no way to type an outcome state on create or update', () => {
    const parsed = createAssetSchema.parse({
      assetTypeId: crypto.randomUUID(),
      outcomeState: 'FINAL',
    } as Record<string, unknown>);
    expect('outcomeState' in parsed).toBe(false);
    expect(() =>
      updateAssetSchema.parse({ outcomeState: 'FINAL' } as Record<string, unknown>)
    ).toThrow();
  });

  it('refuses an empty update rather than writing a no-op revision', () => {
    expect(() => updateAssetSchema.parse({})).toThrow();
  });

  it('accepts an expected revision for the offline contract', () => {
    expect(updateAssetSchema.parse({ quantity: 50, expectedRevision: 3 }).expectedRevision).toBe(3);
  });

  it('refuses a negative quantity or weight', () => {
    expect(() => createAssetSchema.parse({ assetTypeId: crypto.randomUUID(), quantity: -1 })).toThrow();
    expect(() =>
      createAssetSchema.parse({ assetTypeId: crypto.randomUUID(), unitWeightKg: -1 })
    ).toThrow();
  });
});

// ── The import row, and the event allowlist ──────────────────────────────────

describe('importAssetRowSchema', () => {
  it('accepts a row naming its type by code, which is what a paste carries', () => {
    const row = importAssetRowSchema.parse({ assetTypeCode: 'OPERATOR_CHAIR', quantity: 42 });
    expect(row.assetTypeCode).toBe('OPERATOR_CHAIR');
    expect(row.assetTypeId).toBeUndefined();
  });

  it('accepts a row naming its type by id', () => {
    const id = crypto.randomUUID();
    expect(importAssetRowSchema.parse({ assetTypeId: id, quantity: 1 }).assetTypeId).toBe(id);
  });

  /** The two can disagree, and nothing here could say which was meant. */
  it('refuses a row naming its type both ways', () => {
    expect(() =>
      importAssetRowSchema.parse({ assetTypeId: crypto.randomUUID(), assetTypeCode: 'DESK', quantity: 1 })
    ).toThrow();
  });

  it('refuses a row naming its type neither way', () => {
    expect(() => importAssetRowSchema.parse({ quantity: 1 })).toThrow();
  });

  it('caps a paste at 500 rows — beyond that it is a migration, not a paste', () => {
    const row = { assetTypeCode: 'DESK', quantity: 1 };
    expect(() => importAssetsSchema.parse({ rows: Array(501).fill(row) })).toThrow();
    expect(importAssetsSchema.parse({ rows: Array(500).fill(row) }).rows).toHaveLength(500);
  });

  it('refuses an empty paste rather than reporting nothing imported', () => {
    expect(() => importAssetsSchema.parse({ rows: [] })).toThrow();
  });
});

describe('assetLinesRecordedEventPayload', () => {
  const rows = [
    { assetTypeCode: 'OPERATOR_CHAIR', quantity: 42, totalWeightKg: 693 },
    { assetTypeCode: 'DESK', quantity: 8, totalWeightKg: 240 },
    { assetTypeCode: 'DESK', quantity: 3, totalWeightKg: null },
  ];
  const payload = assetLinesRecordedEventPayload({
    projectId: 'p1',
    ownerCompanyId: 'c1',
    recordingCompanyId: 'c2',
    actorUserId: 'u1',
    batchClientId: 'b1',
    rows,
  });

  it('carries the counts and masses a notification is composed from', () => {
    expect(payload.lineCount).toBe(3);
    expect(payload.totalQuantity).toBe(53);
    expect(payload.totalWeightKg).toBe(933);
    expect(payload.linesWithoutWeight).toBe(1);
    expect(payload.assetTypeCodes).toEqual(['DESK', 'OPERATOR_CHAIR']);
  });

  /**
   * §11's exclusion list asserted as an allowlist, the way `evidence.test.ts`
   * asserts its own. A serial number identifies a specific physical machine,
   * usually with a client's asset tag on it, and this payload reaches an email
   * provider.
   */
  it('is an allowlist: nothing that names what the things are can get in', () => {
    expect(Object.keys(payload).sort()).toEqual([
      'actorUserId',
      'assetTypeCodes',
      'batchClientId',
      'lineCount',
      'linesWithoutWeight',
      'ownerCompanyId',
      'projectId',
      'recordingCompanyId',
      'totalQuantity',
      'totalWeightKg',
    ]);
  });

  /**
   * Null, not zero. A zero would read as "they recorded nothing heavy" rather
   * than "nobody has weighed it yet", and the notification composed from it
   * would say the wrong thing to the one person who could fix the gap.
   */
  it('reports an unweighed batch as null mass rather than as zero', () => {
    const unweighed = assetLinesRecordedEventPayload({
      projectId: 'p1',
      ownerCompanyId: 'c1',
      recordingCompanyId: 'c2',
      actorUserId: 'u1',
      batchClientId: null,
      rows: [{ assetTypeCode: 'DESK', quantity: 3, totalWeightKg: null }],
    });
    expect(unweighed.totalWeightKg).toBeNull();
    expect(unweighed.linesWithoutWeight).toBe(1);
  });
});
