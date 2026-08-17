'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/api/client';

/**
 * The single-object sibling of `useAsyncList`: load one resource once the session
 * is ready. `error` carries the API's own message so a 403 reads as the refusal it
 * is ("Your plan does not include: client_portal") rather than "Failed to load".
 */
export function useAsyncData<T>(
  loader: (() => Promise<T>) | null,
  deps: unknown[]
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** The API error itself, when the failure came from the API — for feature gates. */
  apiError: ApiError | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!loader) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setApiError(null);
    loader()
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((err) => {
        if (cancelled) return;
        setApiError(err instanceof ApiError ? err : null);
        setError(err instanceof ApiError ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, apiError, reload };
}
