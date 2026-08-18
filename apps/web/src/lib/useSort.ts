'use client';

import { useCallback, useMemo, useState } from 'react';
import type { SortState } from '@crewquo/ui';

/**
 * Client-side column sorting for the register screens (§40: "a table with sortable
 * columns").
 *
 * Sorting happens in the browser on the rows already loaded, which is honest for every
 * list in the product today — they are all fetched whole. The moment a list is paged
 * server-side, sorting has to move with it, or the first column click would silently
 * reorder one page and call it the answer.
 *
 * `null` sorts last in both directions on purpose. A missing figure is not a small one:
 * an unpriced line ranked as zero would read as the cheapest work on the project.
 */
export type SortValue = string | number | null | undefined;

export function useSort<T>(
  accessors: Record<string, (row: T) => SortValue>,
  initial?: SortState
) {
  const [sort, setSort] = useState<SortState | null>(initial ?? null);

  const onSort = useCallback((key: string) => {
    setSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    );
  }, []);

  const apply = useCallback(
    (rows: T[]): T[] => {
      if (!sort) return rows;
      const get = accessors[sort.key];
      if (!get) return rows;
      const factor = sort.direction === 'asc' ? 1 : -1;
      // Copy first: Array.prototype.sort mutates, and these arrays come straight from
      // the fetch hooks' state.
      return [...rows].sort((a, b) => {
        const av = get(a);
        const bv = get(b);
        const aMissing = av === null || av === undefined;
        const bMissing = bv === null || bv === undefined;
        if (aMissing || bMissing) return aMissing && bMissing ? 0 : aMissing ? 1 : -1;
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
        return String(av).localeCompare(String(bv), undefined, { numeric: true }) * factor;
      });
    },
    [sort, accessors]
  );

  return useMemo(() => ({ sort, onSort, apply }), [sort, onSort, apply]);
}
