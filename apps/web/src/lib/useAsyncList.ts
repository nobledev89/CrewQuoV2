'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/api/client';

/**
 * Load a list once the session is ready, exposing `{ items, loading, error,
 * reload }`. `deps` re-run the loader (e.g. when the active company changes).
 */
export function useAsyncList<T>(
  loader: (() => Promise<T[]>) | null,
  deps: unknown[]
): {
  items: T[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!loader) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { items, loading, error, reload };
}
