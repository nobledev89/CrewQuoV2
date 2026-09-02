import { describe, expect, it } from 'vitest';
import { factor, factorSet, productFactor } from './fixtures';
import { resolveFactor, resolveProductFactor, selectFactorSet } from './factors';

/**
 * §44: *"every branch of factor selection (year, region, validity window,
 * missing)"*, plus the ambiguity refusal the packet's §9 added and the five-tier
 * product resolver of §26.3.
 */

describe('selectFactorSet — §26.2', () => {
  it('selects the set whose window contains the date', () => {
    const got = selectFactorSet([factorSet()], { date: '2027-06-01', region: 'GB' });
    expect(got.kind).toBe('SELECTED');
    expect(got.kind === 'SELECTED' && got.set.id).toBe('set-1');
  });

  it('accepts the window boundaries inclusively', () => {
    const sets = [factorSet()];
    expect(selectFactorSet(sets, { date: '2027-01-01', region: 'GB' }).kind).toBe('SELECTED');
    expect(selectFactorSet(sets, { date: '2027-12-31', region: 'GB' }).kind).toBe('SELECTED');
  });

  it('rejects a date before the window opens or after it closes', () => {
    const sets = [factorSet()];
    expect(selectFactorSet(sets, { date: '2026-12-31', region: 'GB' }).kind).toBe('NONE');
    expect(selectFactorSet(sets, { date: '2028-01-01', region: 'GB' }).kind).toBe('NONE');
  });

  it('treats a null valid_to as open-ended', () => {
    const sets = [factorSet({ validTo: null })];
    expect(selectFactorSet(sets, { date: '2099-01-01', region: 'GB' }).kind).toBe('SELECTED');
  });

  it('ignores inactive sets', () => {
    expect(
      selectFactorSet([factorSet({ active: false })], { date: '2027-06-01', region: 'GB' }).kind
    ).toBe('NONE');
  });

  it('matches region case-insensitively and excludes other regions', () => {
    const sets = [factorSet({ region: 'GB' })];
    expect(selectFactorSet(sets, { date: '2027-06-01', region: 'gb' }).kind).toBe('SELECTED');
    expect(selectFactorSet(sets, { date: '2027-06-01', region: 'IE' }).kind).toBe('NONE');
  });

  it('filters to the requested reporting year when one is given', () => {
    const sets = [
      factorSet({ id: 'y2026', reportingYear: 2026, validFrom: '2026-01-01', validTo: null }),
      factorSet({ id: 'y2027', reportingYear: 2027, validFrom: '2026-01-01', validTo: null }),
    ];
    const got = selectFactorSet(sets, { date: '2027-06-01', region: 'GB', reportingYear: 2026 });
    expect(got.kind === 'SELECTED' && got.set.id).toBe('y2026');
  });

  it('ignores the reporting year when it is null or absent', () => {
    const sets = [factorSet()];
    expect(selectFactorSet(sets, { date: '2027-06-01', region: 'GB', reportingYear: null }).kind).toBe(
      'SELECTED'
    );
  });

  it('returns NONE for an empty library', () => {
    expect(selectFactorSet([], { date: '2027-06-01', region: 'GB' }).kind).toBe('NONE');
  });

  it('refuses to guess between two sets matching one window, and names both', () => {
    const sets = [factorSet({ id: 'a' }), factorSet({ id: 'b', name: 'Other', version: 'v2' })];
    const got = selectFactorSet(sets, { date: '2027-06-01', region: 'GB' });
    expect(got.kind).toBe('AMBIGUOUS');
    expect(got.kind === 'AMBIGUOUS' && got.candidates.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it("lets a company's own set shadow the platform library rather than collide with it", () => {
    const sets = [
      factorSet({ id: 'platform', companyId: null }),
      factorSet({ id: 'mine', companyId: 'co-1' }),
    ];
    const got = selectFactorSet(sets, { date: '2027-06-01', region: 'GB' });
    expect(got.kind === 'SELECTED' && got.set.id).toBe('mine');
  });

  it('is still ambiguous between two of a company own sets — the 9.2 index is what prevents it', () => {
    const sets = [
      factorSet({ id: 'mine-a', companyId: 'co-1' }),
      factorSet({ id: 'mine-b', companyId: 'co-1' }),
    ];
    expect(selectFactorSet(sets, { date: '2027-06-01', region: 'GB' }).kind).toBe('AMBIGUOUS');
  });
});

describe('resolveFactor — §26.1', () => {
  it('matches on category and activity, case-insensitively', () => {
    const got = resolveFactor([factor()], { category: 'freighting goods', activity: 'HGV RIGID' });
    expect(got.kind === 'RESOLVED' && got.factor.id).toBe('factor-1');
  });

  it('returns NONE when nothing matches', () => {
    expect(resolveFactor([factor()], { category: 'Fuels' }).kind).toBe('NONE');
    expect(resolveFactor([], { category: 'Fuels' }).kind).toBe('NONE');
  });

  it('prefers the more specific row when one pins down a fuel type', () => {
    const generic = factor({ id: 'generic' });
    const diesel = factor({ id: 'diesel', fuelType: 'Diesel' });
    const got = resolveFactor([generic, diesel], { fuelType: 'diesel' });
    expect(got.kind === 'RESOLVED' && got.factor.id).toBe('diesel');
  });

  it('refuses a factor that does not say which fuel it is for when a fuel was asked', () => {
    // The generic row alone cannot answer a fuel-specific question: silently
    // substituting it is the invention §41.1 forbids.
    expect(resolveFactor([factor()], { fuelType: 'Diesel' }).kind).toBe('NONE');
  });

  it('does not widen to a less specific row on its own', () => {
    const diesel = factor({ id: 'diesel', fuelType: 'Diesel' });
    expect(resolveFactor([diesel], { fuelType: 'Petrol' }).kind).toBe('NONE');
  });

  it('matches waste factors on material and treatment', () => {
    const wood = factor({
      id: 'wood-landfill',
      category: 'Waste disposal',
      activity: 'Wood',
      material: 'Wood',
      treatment: 'Landfill',
      unit: 'tonne',
    });
    const got = resolveFactor([wood], { material: 'wood', treatment: 'landfill' });
    expect(got.kind === 'RESOLVED' && got.factor.id).toBe('wood-landfill');
  });

  it('honours a unit constraint', () => {
    const km = factor({ id: 'km', unit: 'km' });
    const tonne = factor({ id: 't', unit: 'tonne' });
    const got = resolveFactor([km, tonne], { unit: 'tonne' });
    expect(got.kind === 'RESOLVED' && got.factor.id).toBe('t');
  });

  it('refuses two equally specific matches and names both', () => {
    const a = factor({ id: 'a', fuelType: 'Diesel' });
    const b = factor({ id: 'b', fuelType: 'diesel' });
    const got = resolveFactor([a, b], { fuelType: 'Diesel' });
    expect(got.kind).toBe('AMBIGUOUS');
    expect(got.kind === 'AMBIGUOUS' && got.candidates).toHaveLength(2);
  });

  it('constrains nothing when the query is empty and there is one row', () => {
    expect(resolveFactor([factor()], {}).kind).toBe('RESOLVED');
  });
});

describe('resolveProductFactor — §26.3', () => {
  it('resolves a category-level factor', () => {
    const got = resolveProductFactor([productFactor()], {
      itemCategory: 'FURNITURE',
      allowGeneric: true,
    });
    expect(got.kind === 'RESOLVED' && got.factor.id).toBe('pf-1');
    expect(got.kind === 'RESOLVED' && got.tier).toBe(1);
  });

  it('walks the tiers in §26.3 order: EPD outranks sector, org and generic', () => {
    const factors = [
      productFactor({ id: 'generic', verificationStatus: 'GENERIC_ESTIMATE' }),
      productFactor({ id: 'org', verificationStatus: 'ORG_SPECIFIC' }),
      productFactor({ id: 'sector', verificationStatus: 'SECTOR_DATASET' }),
      productFactor({ id: 'epd', verificationStatus: 'EPD_VERIFIED' }),
    ];
    const got = resolveProductFactor(factors, { itemCategory: 'FURNITURE', allowGeneric: true });
    expect(got.kind === 'RESOLVED' && got.factor.id).toBe('epd');
  });

  it('treats MANUFACTURER as tier 1 alongside EPD_VERIFIED', () => {
    const factors = [
      productFactor({ id: 'sector', verificationStatus: 'SECTOR_DATASET' }),
      productFactor({ id: 'mfr', verificationStatus: 'MANUFACTURER' }),
    ];
    const got = resolveProductFactor(factors, { itemCategory: 'FURNITURE', allowGeneric: true });
    expect(got.kind === 'RESOLVED' && got.factor.id).toBe('mfr');
  });

  it('prefers tier over specificity — a verified category factor beats a generic model factor', () => {
    const factors = [
      productFactor({
        id: 'generic-exact',
        verificationStatus: 'GENERIC_ESTIMATE',
        manufacturer: 'Acme',
        productModel: 'A1',
      }),
      productFactor({ id: 'epd-category', verificationStatus: 'EPD_VERIFIED' }),
    ];
    const got = resolveProductFactor(factors, {
      itemCategory: 'FURNITURE',
      manufacturer: 'Acme',
      productModel: 'A1',
      allowGeneric: true,
    });
    expect(got.kind === 'RESOLVED' && got.factor.id).toBe('epd-category');
  });

  it('separates equal tiers by specificity', () => {
    const factors = [
      productFactor({ id: 'category' }),
      productFactor({ id: 'model', manufacturer: 'Acme', productModel: 'A1' }),
    ];
    const got = resolveProductFactor(factors, {
      itemCategory: 'FURNITURE',
      manufacturer: 'Acme',
      productModel: 'A1',
      allowGeneric: true,
    });
    expect(got.kind === 'RESOLVED' && got.factor.id).toBe('model');
  });

  it('will not answer with another manufacturer factor', () => {
    const factors = [productFactor({ id: 'other', manufacturer: 'Other', productModel: 'X' })];
    expect(
      resolveProductFactor(factors, {
        itemCategory: 'FURNITURE',
        manufacturer: 'Acme',
        productModel: 'A1',
        allowGeneric: true,
      }).kind
    ).toBe('NONE');
  });

  it('will not use a manufacturer-specific factor for an item whose manufacturer is unknown', () => {
    const factors = [productFactor({ id: 'mfr', manufacturer: 'Acme', productModel: 'A1' })];
    expect(
      resolveProductFactor(factors, { itemCategory: 'FURNITURE', allowGeneric: true }).kind
    ).toBe('NONE');
  });

  it('matches on asset type', () => {
    const factors = [productFactor({ id: 'typed', assetTypeId: 'type-chair' })];
    const got = resolveProductFactor(factors, {
      assetTypeId: 'type-chair',
      itemCategory: 'FURNITURE',
      allowGeneric: true,
    });
    expect(got.kind === 'RESOLVED' && got.factor.id).toBe('typed');
  });

  it('ignores inactive factors', () => {
    expect(
      resolveProductFactor([productFactor({ active: false })], {
        itemCategory: 'FURNITURE',
        allowGeneric: true,
      }).kind
    ).toBe('NONE');
  });

  it('returns NONE — not a claim — when the library is empty (§26.3)', () => {
    expect(resolveProductFactor([], { itemCategory: 'FURNITURE', allowGeneric: true }).kind).toBe(
      'NONE'
    );
  });

  it('refuses a generic when §39 has generics switched off, and says which one it refused', () => {
    const generic = productFactor({ id: 'generic', verificationStatus: 'GENERIC_ESTIMATE' });
    const got = resolveProductFactor([generic], { itemCategory: 'FURNITURE', allowGeneric: false });
    expect(got.kind).toBe('GENERIC_REFUSED');
    expect(got.kind === 'GENERIC_REFUSED' && got.factor.id).toBe('generic');
  });

  it('distinguishes GENERIC_REFUSED from NONE — they have different fixes', () => {
    expect(resolveProductFactor([], { itemCategory: 'FURNITURE', allowGeneric: false }).kind).toBe(
      'NONE'
    );
  });

  it('falls through to a non-generic factor when generics are off', () => {
    const factors = [
      productFactor({ id: 'generic', verificationStatus: 'GENERIC_ESTIMATE' }),
      productFactor({ id: 'org', verificationStatus: 'ORG_SPECIFIC' }),
    ];
    const got = resolveProductFactor(factors, { itemCategory: 'FURNITURE', allowGeneric: false });
    expect(got.kind === 'RESOLVED' && got.factor.id).toBe('org');
  });

  it("prefers a company's own factor over the platform library at equal rank", () => {
    const factors = [
      productFactor({ id: 'platform', companyId: null }),
      productFactor({ id: 'mine', companyId: 'co-1' }),
    ];
    const got = resolveProductFactor(factors, { itemCategory: 'FURNITURE', allowGeneric: true });
    expect(got.kind === 'RESOLVED' && got.factor.id).toBe('mine');
  });

  it('refuses two indistinguishable factors rather than picking by array order', () => {
    const factors = [productFactor({ id: 'a' }), productFactor({ id: 'b' })];
    const got = resolveProductFactor(factors, { itemCategory: 'FURNITURE', allowGeneric: true });
    expect(got.kind).toBe('AMBIGUOUS');
    expect(got.kind === 'AMBIGUOUS' && got.candidates).toHaveLength(2);
  });
});
