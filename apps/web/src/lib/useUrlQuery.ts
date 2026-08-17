'use client';

import { useCallback, useEffect, useState } from 'react';

/** Keeps lightweight table search state shareable without triggering navigation. */
export function useUrlQuery(key = 'q'): [string, (value: string) => void] {
  const [value, setValue] = useState('');

  useEffect(() => {
    setValue(new URLSearchParams(window.location.search).get(key) ?? '');
  }, [key]);

  const update = useCallback((next: string) => {
    setValue(next);
    const url = new URL(window.location.href);
    if (next.trim()) url.searchParams.set(key, next);
    else url.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [key]);

  return [value, update];
}
