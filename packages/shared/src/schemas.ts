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
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
