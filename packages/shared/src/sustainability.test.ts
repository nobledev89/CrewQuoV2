import { describe, expect, it } from 'vitest';
import {
  AVOIDED_METHODOLOGY_WARNING,
  DEFAULT_REPORT_DISCLAIMER,
  REQUIRED_MEASURE_FOR_KIND,
  SETTINGS_DEFAULTS,
  UNIT_FOR_MEASURE,
  calculationsSupersededEventPayload,
  claimBlockedEventPayload,
  createActivitySchema,
  createProductFactorSchema,
  deriveIsEstimate,
  factorSetImportedEventPayload,
  resolveDisplacementUpdate,
  updateFactorSetSchema,
  updateSustainabilitySettingsSchema,
} from './sustainability';
import {
  ACTIVITY_KINDS,
  DEFAULT_DATA_QUALITY_WEIGHTS,
  VERIFICATION_STATUSES,
} from './carbon-engine';

/**
 * The Phase 9 wire contracts (§26–§28, §39).
 *
 * Two things are being pinned here rather than "the schemas parse". The first is
 * the displacement pair, which is `sustainability.md` §0 finding 1 and the reason
 * the packet exists — a settings row that can express "80%" beside a basis of
 * `UNKNOWN` is a claim nobody made. The second is that nothing in this module
 * quietly fills a blank, because §41.1 is the rule the whole phase turns on.
 */

describe('resolveDisplacementUpdate (finding 1)', () => {
  const unknown = { basis: 'UNKNOWN' as const, pct: null };

  it('accepts USER_DEFINED with a percentage', () => {
    const r = resolveDisplacementUpdate({
      current: unknown,
      patch: { basis: 'USER_DEFINED', pct: 80 },
    });
    expect(r).toEqual({ basis: 'USER_DEFINED', pct: 80, error: null });
  });

  it('refuses USER_DEFINED with no percentage, and says what is missing', () => {
    const r = resolveDisplacementUpdate({ current: unknown, patch: { basis: 'USER_DEFINED' } });
    expect(r.error).toContain('needs a percentage');
  });

  it('refuses ASSUMED_FULL carrying a stray percentage as firmly as the other way round', () => {
    // 100% is what ASSUMED_FULL *means*, and a second copy of it is a second
    // answer — which is why 0037's constraint is `=` rather than an implication.
    const r = resolveDisplacementUpdate({
      current: unknown,
      patch: { basis: 'ASSUMED_FULL', pct: 80 },
    });
    expect(r.error).toContain('already means 100%');
  });

  it('refuses UNKNOWN carrying a percentage, because that is a claim nobody made', () => {
    const r = resolveDisplacementUpdate({
      current: { basis: 'USER_DEFINED', pct: 80 },
      patch: { basis: 'UNKNOWN', pct: 80 },
    });
    expect(r.error).toContain('claim nobody made');
  });

  it('clears the old percentage when the basis changes and none is supplied', () => {
    // Leaving 80 behind an ASSUMED_FULL is the drifted pair the constraint refuses,
    // and a patch touching one half is still a change to the pair.
    const r = resolveDisplacementUpdate({
      current: { basis: 'USER_DEFINED', pct: 80 },
      patch: { basis: 'ASSUMED_FULL' },
    });
    expect(r).toEqual({ basis: 'ASSUMED_FULL', pct: null, error: null });
  });

  it('keeps the stored percentage when only unrelated fields move', () => {
    const r = resolveDisplacementUpdate({
      current: { basis: 'USER_DEFINED', pct: 80 },
      patch: {},
    });
    expect(r).toEqual({ basis: 'USER_DEFINED', pct: 80, error: null });
  });

  it('lets a percentage be corrected without restating the basis', () => {
    const r = resolveDisplacementUpdate({
      current: { basis: 'USER_DEFINED', pct: 80 },
      patch: { pct: 65 },
    });
    expect(r).toEqual({ basis: 'USER_DEFINED', pct: 65, error: null });
  });

  it('defaults to UNKNOWN, which is the whole finding', () => {
    expect(SETTINGS_DEFAULTS.defaultDisplacementBasis).toBe('UNKNOWN');
    expect(SETTINGS_DEFAULTS).not.toHaveProperty('defaultDisplacementPct');
  });
});

describe('updateSustainabilitySettingsSchema', () => {
  it('refuses an empty patch', () => {
    expect(updateSustainabilitySettingsSchema.safeParse({}).success).toBe(false);
  });

  it('refuses an unknown key rather than ignoring it', () => {
    expect(
      updateSustainabilitySettingsSchema.safeParse({ defaultDisplacementPercent: 80 }).success
    ).toBe(false);
  });

  it('refuses weights that do not sum to 1', () => {
    // A set summing to 0.9 silently rescales the published percentage upward.
    const result = updateSustainabilitySettingsSchema.safeParse({
      dataQualityWeights: {
        LINES_WITH_WEIGHT: 0.25,
        MASS_WITH_FINAL_DESTINATION: 0.25,
        MASS_DOCUMENTED_OR_VERIFIED: 0.2,
        LINES_WITH_SUPPORT: 0.15,
        AVOIDED_MASS_ON_SPECIFIC_FACTOR: 0.05,
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts the shipped defaults, which is the parity the DDL depends on', () => {
    expect(
      updateSustainabilitySettingsSchema.safeParse({
        dataQualityWeights: DEFAULT_DATA_QUALITY_WEIGHTS,
      }).success
    ).toBe(true);
  });

  it('refuses an accent colour that is not a six-digit hex', () => {
    expect(updateSustainabilitySettingsSchema.safeParse({ reportAccentHex: 'blue' }).success).toBe(false);
    expect(updateSustainabilitySettingsSchema.safeParse({ reportAccentHex: '#1f2933' }).success).toBe(true);
  });
});

describe('the default disclaimer (§29.3)', () => {
  it('says which basis electricity is reported on', () => {
    // sustainability.md §13.1, built as recommended: location-based only, LABELLED
    // wherever it appears rather than left for a reader to assume the favourable one.
    expect(DEFAULT_REPORT_DISCLAIMER).toContain('location-based');
  });

  it('says avoided emissions are reported separately', () => {
    // §27.5's prohibition on a net headline, stated to the reader rather than only
    // enforced in the type system.
    expect(DEFAULT_REPORT_DISCLAIMER).toContain('reported separately');
  });

  it('claims no verification or certification anywhere', () => {
    // §29.3: never describe a report as independently verified, ISO-certified or
    // GHG-Protocol-certified. Referencing a methodology is not certification.
    expect(DEFAULT_REPORT_DISCLAIMER).not.toMatch(/verified|certified|ISO|accredited/i);
  });

  it('is what SETTINGS_DEFAULTS carries, so 0037 and the engine cannot disagree', () => {
    expect(SETTINGS_DEFAULTS.reportDisclaimer).toBe(DEFAULT_REPORT_DISCLAIMER);
  });
});

describe('the avoided methodology warning (§27.4)', () => {
  it('says the figure is not a reduction in any scope', () => {
    expect(AVOIDED_METHODOLOGY_WARNING).toContain('not a reduction');
  });

  it('names what the figure depends on, which is what makes it contestable', () => {
    expect(AVOIDED_METHODOLOGY_WARNING).toContain('displacement assumption');
  });
});

describe('createActivitySchema (§27.3)', () => {
  const base = { activityDate: '2027-03-04' };

  it('requires the measure its kind is priced from', () => {
    expect(createActivitySchema.safeParse({ ...base, kind: 'VEHICLE_DISTANCE' }).success).toBe(false);
    expect(
      createActivitySchema.safeParse({ ...base, kind: 'VEHICLE_DISTANCE', distanceKm: 240 }).success
    ).toBe(true);
  });

  it('refuses a zero measure rather than accepting it', () => {
    // A zero-litre fuel activity is a form somebody abandoned, and it would produce
    // a 0.0 kgCO₂e calculation row that looks exactly like a computed result.
    expect(createActivitySchema.safeParse({ ...base, kind: 'FUEL', litres: 0 }).success).toBe(false);
  });

  it('names the missing field on the field itself', () => {
    const r = createActivitySchema.safeParse({ ...base, kind: 'ELECTRICITY' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['kwh']);
  });

  it('lets OTHER carry no measure at all, which is what it is for', () => {
    expect(createActivitySchema.safeParse({ ...base, kind: 'OTHER' }).success).toBe(true);
  });

  it('defaults source to ESTIMATED, the least flattering of the three', () => {
    const r = createActivitySchema.parse({ ...base, kind: 'FUEL', litres: 180 });
    expect(r.source).toBe('ESTIMATED');
  });

  it('has a rule for every kind, so adding one cannot silently need no measure', () => {
    for (const kind of ACTIVITY_KINDS) {
      expect(REQUIRED_MEASURE_FOR_KIND).toHaveProperty(kind);
    }
  });

  it('gives every required measure a factor unit', () => {
    for (const kind of ACTIVITY_KINDS) {
      const measure = REQUIRED_MEASURE_FOR_KIND[kind];
      if (measure !== null) expect(UNIT_FOR_MEASURE[measure]).toBeTruthy();
    }
  });
});

describe('createProductFactorSchema (§26.3)', () => {
  const base = {
    itemCategory: 'FURNITURE',
    lifecycleBoundary: 'A1_A3' as const,
    source: 'Manufacturer EPD',
    verificationStatus: 'EPD_VERIFIED' as const,
  };

  it('requires exactly one rate', () => {
    expect(createProductFactorSchema.safeParse(base).success).toBe(false);
    expect(createProductFactorSchema.safeParse({ ...base, kgCo2ePerItem: 75 }).success).toBe(true);
    expect(
      createProductFactorSchema.safeParse({ ...base, kgCo2ePerItem: 75, kgCo2ePerKg: 4 }).success
    ).toBe(false);
  });

  it('does not accept is_estimate at all — it is derived', () => {
    // A client-supplied boolean beside a verification_status is two answers to one
    // question, and the flattering answer is the one a form would send.
    const parsed = createProductFactorSchema.parse({ ...base, kgCo2ePerItem: 75 });
    expect(parsed).not.toHaveProperty('isEstimate');
  });
});

describe('deriveIsEstimate', () => {
  it('is false only for a verified EPD or the manufacturer figure', () => {
    expect(deriveIsEstimate('EPD_VERIFIED')).toBe(false);
    expect(deriveIsEstimate('MANUFACTURER')).toBe(false);
  });

  it('is true for everything else, including an organisation-specific factor', () => {
    // A sector dataset is a class average and an ORG_SPECIFIC factor is somebody's
    // internal assumption. Both are estimates and the report says so.
    expect(deriveIsEstimate('SECTOR_DATASET')).toBe(true);
    expect(deriveIsEstimate('ORG_SPECIFIC')).toBe(true);
    expect(deriveIsEstimate('GENERIC_ESTIMATE')).toBe(true);
  });

  it('has an answer for every status', () => {
    for (const status of VERIFICATION_STATUSES) {
      expect(typeof deriveIsEstimate(status)).toBe('boolean');
    }
  });
});

describe('updateFactorSetSchema (packet §2)', () => {
  it('permits the fields that do not change which projects a set applies to', () => {
    expect(updateFactorSetSchema.safeParse({ active: false }).success).toBe(true);
    expect(updateFactorSetSchema.safeParse({ methodology: 'note' }).success).toBe(true);
  });

  it('refuses the four selection keys outright', () => {
    // Editing one silently changes which projects a set applies to, including
    // projects already calculated and reported against it (§41.3). A publisher's
    // correction is a new set at a new version, and so is ours.
    for (const patch of [
      { reportingYear: 2028 },
      { version: 'v1.2' },
      { region: 'IE' },
      { validFrom: '2028-01-01' },
    ]) {
      expect(updateFactorSetSchema.safeParse(patch).success).toBe(false);
    }
  });
});

describe('event payloads (packet §5, §11)', () => {
  it('factor_set_imported carries counts by category and no factor values', () => {
    const payload = factorSetImportedEventPayload({
      companyId: 'c', factorSetId: 'f', name: 'Test 2027', version: 'v1.0',
      reportingYear: 2027, rowCount: 3,
      countsByCategory: { Waste: 2, Fuels: 1 }, actorUserId: 'u',
    });
    expect(payload.countsByCategory).toEqual({ Waste: 2, Fuels: 1 });
    expect(JSON.stringify(payload)).not.toMatch(/kgCo2e|perUnit/i);
  });

  it('calculations_superseded carries the per-bucket delta, which is the whole point', () => {
    // "17 calculations superseded" is unreadable. "avoided −4.30 tCO₂e, trigger
    // WEIGHT_CORRECTED" is the sentence somebody needs a year later, and this is
    // the only place it is recorded.
    const payload = calculationsSupersededEventPayload({
      projectId: 'p', companyId: 'c', trigger: 'WEIGHT_CORRECTED', triggeringId: 'a',
      supersededCount: 17, newCount: 17,
      deltaByBucket: { PROJECT_EMISSIONS: 120, AVOIDED: -4300 }, actorUserId: 'u',
    });
    expect(payload.deltaByBucket).toEqual({ PROJECT_EMISSIONS: 120, AVOIDED: -4300 });
    expect(payload.trigger).toBe('WEIGHT_CORRECTED');
  });

  it('claim_blocked carries subjects and quantities and nothing that names an item', () => {
    const payload = claimBlockedEventPayload({
      projectId: 'p', companyId: 'c', reason: 'DISPLACEMENT_UNKNOWN',
      subjects: [
        // Extra keys a caller might pass are dropped by the allowlist rather than
        // travelling to an email provider.
        { subject: 'Operator chair', quantity: 30, serialNumber: 'ABC123' } as never,
      ],
      movementCount: 1, onDate: '2027-03-04',
    });
    expect(JSON.stringify(payload)).not.toContain('ABC123');
    expect(payload.subjects).toEqual([{ subject: 'Operator chair', quantity: 30 }]);
  });
});
