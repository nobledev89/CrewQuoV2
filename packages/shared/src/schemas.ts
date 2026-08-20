import { z } from 'zod';

/** Response shape for the API health check (GET /healthz). */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  db: z.enum(['up', 'down']),
  timestamp: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Standard error envelope returned by the API (see CREWQUO_V2_PLAN.md §7). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'VALIDATION',
      'LIMIT_EXCEEDED',
      'CONFLICT',
      'RATE_LIMITED',
      'INTERNAL',
    ]),
    message: z.string(),
    details: z.unknown().optional(),
    /**
     * The request's correlation id
     * (`docs/operating-model/observability-data-lifecycle.md` §12.2).
     *
     * Here so that "it says something went wrong" can become a reference a
     * customer reads out and an operator finds — which is the whole support model
     * `access.md` §13.3 left available after refusing impersonation and
     * per-tenant operator reads.
     *
     * **Optional, and on every error rather than only on a 500.** Optional because
     * a client parsing a response from an older API must not fail on its absence.
     * On every error because the ones people actually ask about are the 403 they
     * did not expect and the 422 they cannot interpret, not the crash — and a
     * reference that exists only for crashes is missing exactly when somebody is
     * on the phone.
     *
     * It identifies a request, not a person: it is minted per request, is useless
     * without operator access to the logs, and grants nothing to whoever holds it.
     */
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
