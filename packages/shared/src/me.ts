import { z } from 'zod';
import { membershipSummarySchema, publicUserSchema } from './auth';

/** GET /v1/me — the authenticated profile. */
export const meResponseSchema = z.object({
  user: publicUserSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** GET /v1/me/memberships — company switcher source. */
export const membershipsResponseSchema = z.object({
  memberships: z.array(membershipSummarySchema),
});
export type MembershipsResponse = z.infer<typeof membershipsResponseSchema>;

/** ISO 4217 currency code; set per company, rate cards inherit it (§3.1). */
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 code');

/**
 * Currency a company starts on (owner decision, 2026-08-17: USD, changeable via
 * `PATCH /v1/companies/:id`). This is the only place the default lives in code —
 * `companies.currency`'s column default (migration 0006) mirrors it, and every
 * read-side fallback imports it rather than repeating the literal.
 */
export const DEFAULT_CURRENCY = 'USD';

/** POST /v1/me/companies — create a company; the caller becomes OWNER. */
export const createCompanyRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  currency: currencyCodeSchema.default(DEFAULT_CURRENCY),
});
export type CreateCompanyRequest = z.infer<typeof createCompanyRequestSchema>;

export const companySummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  currency: z.string(),
  isPlaceholder: z.boolean(),
});
export type CompanySummary = z.infer<typeof companySummarySchema>;

/**
 * PATCH /v1/companies/:id (§7, OWNER/ADMIN). Company settings — today the name
 * and the currency.
 *
 * Changing currency re-denominates every figure the company displays: money is
 * stored as integer minor units with no FX rate anywhere, so 5000 reads as
 * $50.00 or £50.00 depending only on this field. That is why it is an
 * OWNER/ADMIN action and why it is audited.
 */
export const updateCompanySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    currency: currencyCodeSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateCompany = z.infer<typeof updateCompanySchema>;
