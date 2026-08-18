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

/**
 * PATCH /v1/me (§7) — the signed-in account's own profile.
 *
 * Name and avatar only. Email is deliberately absent: it is the identity an
 * invite is bound to and the address a reset link is sent to, so changing it is a
 * re-verification flow rather than a text field. `avatarUrl` accepts null to
 * clear it — `undefined` means "leave alone", which is a different instruction.
 */
export const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    avatarUrl: z.string().trim().url().max(2000).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateMe = z.infer<typeof updateMeSchema>;

/**
 * POST /v1/me/companies — create a company; the caller becomes OWNER.
 *
 * The same endpoint serves both authorities in §3.1.1: the once-per-identity
 * automatic allowance, and an `APPROVED` additional-company request. `requestId`
 * is optional because a first-time creator has no request and should not have to
 * know the concept exists; when the allowance is spent the server resolves the
 * caller's single approved request itself, so passing it is a precision, not a
 * requirement.
 *
 * `country`/`registrationId` are the legal identity the duplicate check reads
 * later (§3.1.1(6)). Optional here so the empty-state form stays two fields; the
 * approval path carries them over from the request that was reviewed.
 *
 * `idempotencyKey` is what makes a retried create return the *same* company
 * rather than a second one — the ledger row stores it, so the guarantee outlives
 * the process.
 */
export const createCompanyRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  currency: currencyCodeSchema.default(DEFAULT_CURRENCY),
  requestId: z.string().uuid().optional(),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'must be a 2-letter ISO 3166-1 country code')
    .optional(),
  registrationId: z.string().trim().max(80).optional().nullable(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});
export type CreateCompanyRequest = z.infer<typeof createCompanyRequestSchema>;

export const companySummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  currency: z.string(),
  isPlaceholder: z.boolean(),
  country: z.string().nullable().optional(),
  registrationId: z.string().nullable().optional(),
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
