'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CapabilityKey } from '@crewquo/shared';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';

/**
 * The caller's own capabilities in the active company (§37), loaded once per
 * company.
 *
 * **The sibling of `useEntitlements`, and it answers the other half of the
 * question.** An entitlement says *does this plan sell it*; a capability says
 * *may this person do it*. §37's rule is that both are checked and neither
 * substitutes for the other, so a screen that shows an action needs both to be
 * true and a screen that hides one should be able to say which was missing.
 *
 * Like entitlements, this **explains rather than enforces**. The API is the gate;
 * `can()` returning false means "do not offer this and say why", never "the
 * endpoint does not exist". Every action a screen hides on this basis must still
 * survive the 403 that arrives when somebody's bundle changed under them.
 *
 * **Absent while loading is `false`, deliberately.** The alternative — treating an
 * unknown capability as permitted until proven otherwise — flashes a button that
 * then vanishes, and a person who clicked it in that window gets a refusal for an
 * action the product offered them. `loading` is exposed so a screen can render
 * nothing rather than render a lie.
 */
export interface CapabilityState {
  loading: boolean;
  error: string | null;
  /** Every capability the caller holds here, resolved through their bundle and overrides. */
  mine: CapabilityKey[];
  /** True once loaded and the caller holds `key`. False while loading. */
  can: (key: CapabilityKey) => boolean;
  reload: () => void;
}

export function useCapabilities(): CapabilityState {
  const ctx = useSessionCtx();
  const [mine, setMine] = useState<CapabilityKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!ctx) {
      setMine([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .capabilities(ctx.accessToken, ctx.companyId)
      .then((res) => {
        if (!cancelled) setMine(res.mine);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : 'Could not load what you can do here'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, nonce]);

  const can = useCallback((key: CapabilityKey) => mine.includes(key), [mine]);

  return { loading, error, mine, can, reload };
}
