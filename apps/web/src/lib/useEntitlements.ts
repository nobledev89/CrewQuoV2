'use client';

import { useCallback, useEffect, useState } from 'react';
import type { EntitlementsResponse, FeatureKey, LimitKey } from '@crewquo/shared';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';

/**
 * The active company's resolved entitlements (§5B), loaded once per company.
 *
 * The UI uses this to *explain* rather than to enforce: the API is still the gate,
 * so a screen that hides a locked action must also handle the 403 if the plan
 * changed under it. `has()` returning false means "tell them what unlocks it",
 * never "pretend the endpoint doesn't exist".
 */
export interface EntitlementState {
  loading: boolean;
  error: string | null;
  data: EntitlementsResponse | null;
  /** True once loaded and the feature is enabled. Absent while loading. */
  has: (key: FeatureKey) => boolean;
  /** Usage for a metered limit, or null when the key isn't metered on this plan. */
  usage: (key: LimitKey) => { used: number; value: number | null } | null;
  /** True when the limit is at or over its cap — the "23 / 23" state. */
  atLimit: (key: LimitKey) => boolean;
  reload: () => void;
}

export function useEntitlements(): EntitlementState {
  const ctx = useSessionCtx();
  const [data, setData] = useState<EntitlementsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!ctx) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .entitlements(ctx.accessToken, ctx.companyId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load your plan');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, nonce]);

  const has = useCallback(
    (key: FeatureKey) => data?.features.includes(key) ?? false,
    [data]
  );

  const usage = useCallback(
    (key: LimitKey) => {
      const row = data?.usage.find((u) => u.key === key);
      return row ? { used: row.used, value: row.value } : null;
    },
    [data]
  );

  const atLimit = useCallback(
    (key: LimitKey) => {
      const row = usage(key);
      if (!row || row.value === null) return false; // null = unlimited
      return row.used >= row.value;
    },
    [usage]
  );

  return { loading, error, data, has, usage, atLimit, reload };
}
