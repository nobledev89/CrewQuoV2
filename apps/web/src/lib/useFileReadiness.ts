'use client';

import { useEffect, useState } from 'react';
import type { FileStatus } from '@crewquo/shared';
import { api } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';

/**
 * Wait for an uploaded file to finish being checked.
 *
 * **Why this exists at all, and it is a consequence of §22.1 rather than a
 * shortcoming of it.** Bytes never pass through the API, so the API cannot sniff
 * the content type on the way in; the check happens in the worker that downloads
 * the original to build previews. A file is therefore `SCANNING` for a moment
 * after `complete` returns — and the document route requires `READY`, because a
 * compliance record pointing at bytes that turned out to be an executable is worse
 * than a missing one.
 *
 * Without this, the document form did what the first version of it did: refused
 * with *"that upload is still being checked, try again in a moment"* and left the
 * person to guess when the moment was, with a full form they had just filled in.
 * Evidence has no equivalent, deliberately — it accepts a scanning file, so forty
 * photographs tagged in a stairwell are never lost to a slow worker.
 *
 * Polling rather than a subscription, because the wait is seconds and a websocket
 * for it would be a second transport to keep alive for one screen. The interval
 * backs off so a worker that has stopped costs a request a minute rather than one
 * a second, and it gives up loudly rather than spinning for ever: an upload that
 * never gets scanned is an operational problem, and a form that waits silently
 * forever is how it stays one.
 */

export type Readiness =
  | { state: 'CHECKING' }
  | { state: 'READY' }
  | { state: 'FAILED'; reason: string }
  | { state: 'GAVE_UP' };

const FIRST_DELAY_MS = 400;
const MAX_DELAY_MS = 5_000;
/** About two minutes with the backoff below — far longer than a scan pass takes. */
const MAX_ATTEMPTS = 40;

export function useFileReadiness(fileId: string | null): Readiness {
  const ctx = useSessionCtx();
  const [readiness, setReadiness] = useState<Readiness>({ state: 'CHECKING' });

  useEffect(() => {
    if (!ctx || !fileId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setReadiness({ state: 'CHECKING' });

    let attempt = 0;
    let delay = FIRST_DELAY_MS;

    const settle = (status: FileStatus, reason: string | null) => {
      if (status === 'READY') {
        setReadiness({ state: 'READY' });
        return true;
      }
      if (status === 'FAILED' || status === 'EXPIRED' || status === 'DELETED') {
        setReadiness({
          state: 'FAILED',
          reason: reason ?? 'That file could not be stored.',
        });
        return true;
      }
      return false;
    };

    const poll = async () => {
      if (cancelled) return;
      attempt += 1;
      try {
        const { file } = await api.getFile(ctx.accessToken, ctx.companyId, fileId);
        if (cancelled) return;
        if (settle(file.status, file.failureReason)) return;
      } catch {
        // A failed poll is not a failed file. Keep trying: the interesting error
        // is the one the record itself reports, not a dropped request.
      }
      if (cancelled) return;
      if (attempt >= MAX_ATTEMPTS) {
        setReadiness({ state: 'GAVE_UP' });
        return;
      }
      delay = Math.min(Math.round(delay * 1.4), MAX_DELAY_MS);
      timer = setTimeout(() => void poll(), delay);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ctx, fileId]);

  return readiness;
}
