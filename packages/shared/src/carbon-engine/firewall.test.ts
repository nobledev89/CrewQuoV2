import { describe, expect, it } from 'vitest';
import { addTotals, sumBucket } from './rollup';
import type { BucketedTotal } from './types';

/**
 * **The firewall test (§44), and it is a type test as much as a runtime one.**
 *
 * Locked decision #17: *"there is no query, no type and no UI component in the
 * system that adds `AVOIDED` to anything else."* §27.2 names `bucket` as the
 * firewall. A review can enforce that; a type checker enforces it on everybody,
 * including whoever adds the twelfth screen in eighteen months.
 *
 * Every `@ts-expect-error` below **fails the build if the line starts
 * compiling** — that is the whole mechanism. `tsc --noEmit` runs over this file
 * as part of `pnpm --filter @crewquo/shared type-check`, so weakening
 * `BucketBrand` breaks CI here rather than shipping a netted headline.
 */

const emissions: BucketedTotal<'PROJECT_EMISSIONS'> = {
  bucket: 'PROJECT_EMISSIONS',
  kgCo2e: 3840,
  rowCount: 4,
};
const waste: BucketedTotal<'WASTE_TREATMENT'> = {
  bucket: 'WASTE_TREATMENT',
  kgCo2e: 840,
  rowCount: 2,
};
const avoided: BucketedTotal<'AVOIDED'> = {
  bucket: 'AVOIDED',
  kgCo2e: 27420,
  rowCount: 1,
};

describe('the bucket firewall does not compile across buckets', () => {
  it('refuses to add avoided emissions to project emissions', () => {
    // @ts-expect-error — locked decision #17: AVOIDED is never added to anything.
    addTotals(emissions, avoided);
    expect(true).toBe(true);
  });

  it('refuses the other direction too', () => {
    // @ts-expect-error — the brand is invariant, so neither order unifies.
    addTotals(avoided, emissions);
    expect(true).toBe(true);
  });

  it('refuses to mix the two inventory buckets, which are summed but not interchangeable', () => {
    // §28.2 adds these two into one figure — but through `rollUpProjectCarbon`,
    // which reads `.kgCo2e` deliberately, not by pretending the totals are the
    // same kind of thing.
    // @ts-expect-error — WASTE_TREATMENT is not PROJECT_EMISSIONS.
    addTotals(emissions, waste);
    expect(true).toBe(true);
  });

  it('refuses to assign one bucket total to another', () => {
    // @ts-expect-error — an avoided total is not a project-emissions total.
    const wrong: BucketedTotal<'PROJECT_EMISSIONS'> = avoided;
    expect(wrong.kgCo2e).toBe(27420);
  });

  it('refuses to widen a specific total into the general one, which is how a mixed sum starts', () => {
    // @ts-expect-error — invariance: `BucketedTotal<'AVOIDED'>` is not a `BucketedTotal`.
    const widened: BucketedTotal = avoided;
    expect(widened.bucket).toBe('AVOIDED');
  });

  it('still allows the legitimate case: two totals from the same bucket', () => {
    const more: BucketedTotal<'PROJECT_EMISSIONS'> = {
      bucket: 'PROJECT_EMISSIONS',
      kgCo2e: 160,
      rowCount: 1,
    };
    expect(addTotals(emissions, more).kgCo2e).toBe(4000);
  });

  it('keeps the runtime honest as well: sumBucket ignores rows from other buckets', () => {
    // The type stops a developer; this stops a cast.
    const mixed = [
      { ...emissions, bucket: 'PROJECT_EMISSIONS' as const },
      { ...avoided, bucket: 'AVOIDED' as const },
    ].map((t) => ({
      bucket: t.bucket,
      scope: null,
      scope3Category: null,
      sourceType: 'MANUAL' as const,
      sourceId: null,
      method: 'MANUAL' as const,
      quantity: 1,
      unit: 'km',
      kgCo2e: t.kgCo2e,
      wttKgCo2e: null,
      isEstimate: false,
      confidence: null,
      citation: {
        factorSetId: null,
        factorId: null,
        productFactorId: null,
        factorSetName: 'n',
        factorSetVersion: 'v',
        factorReportingYear: null,
        factorKgCo2ePerUnit: null,
        methodology: null,
      },
      inputs: {},
    }));

    expect(sumBucket(mixed, 'PROJECT_EMISSIONS').kgCo2e).toBe(3840);
    expect(sumBucket(mixed, 'AVOIDED').kgCo2e).toBe(27420);
  });
});
