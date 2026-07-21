import { z } from 'zod';
import { rateKindSchema, rateLabelSchema, rateModeSchema, shiftTypeSchema } from './enums';

/**
 * Rate engine & catalog API contracts (CREWQUO_V2_PLAN.md §3.3, §6, §7).
 * These type the API handlers, the api-client, and the web management screens.
 */

// ── Role catalog ────────────────────────────────────────────────────────────

export const roleCatalogCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export type RoleCatalogCreate = z.infer<typeof roleCatalogCreateSchema>;

export const roleCatalogUpdateSchema = roleCatalogCreateSchema.partial();
export type RoleCatalogUpdate = z.infer<typeof roleCatalogUpdateSchema>;

export const roleCatalogViewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RoleCatalogView = z.infer<typeof roleCatalogViewSchema>;

// ── Rate card templates (holiday / timeframe definitions) ─────────────────────

export const holidayTimeframeSchema = z.object({
  type: z.literal('holiday'),
  holidayDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  holidayMultiplier: z.number().positive(),
});
export const timeframeDefinitionSchema = holidayTimeframeSchema; // discriminated union point
export type TimeframeDefinitionInput = z.infer<typeof timeframeDefinitionSchema>;

export const rateCardTemplateCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timeframeDefinitions: z.array(timeframeDefinitionSchema).default([]),
});
export type RateCardTemplateCreate = z.infer<typeof rateCardTemplateCreateSchema>;

export const rateCardTemplateUpdateSchema = rateCardTemplateCreateSchema.partial();
export type RateCardTemplateUpdate = z.infer<typeof rateCardTemplateUpdateSchema>;

export const rateCardTemplateViewSchema = rateCardTemplateCreateSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RateCardTemplateView = z.infer<typeof rateCardTemplateViewSchema>;

// ── Rate cards (PAY / BILL) ───────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const cents = z.number().int().min(0);

export const rateCardCreateSchema = z
  .object({
    kind: rateKindSchema,
    counterpartyCompanyId: z.string().uuid().nullable().default(null),
    roleId: z.string().uuid(),
    rateMode: rateModeSchema,
    rateLabel: rateLabelSchema,
    hourlyRateCents: cents.nullable().default(null),
    otHourlyRateCents: cents.nullable().default(null),
    shiftRateCents: cents.nullable().default(null),
    dailyRateCents: cents.nullable().default(null),
    minHours: z.number().min(0).nullable().default(null),
    weekendMultiplier: z.number().positive().nullable().default(null),
    nightMultiplier: z.number().positive().nullable().default(null),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable().default(null),
    active: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    // The mode dictates which rate column is mandatory (§6 extractRate).
    const need = (
      field: 'hourlyRateCents' | 'shiftRateCents' | 'dailyRateCents',
      label: string
    ) => {
      if (v[field] === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${label} rate cards require ${field}`,
        });
      }
    };
    if (v.rateMode === 'HOURLY') need('hourlyRateCents', 'HOURLY');
    if (v.rateMode === 'SHIFT') need('shiftRateCents', 'SHIFT');
    if (v.rateMode === 'DAILY') need('dailyRateCents', 'DAILY');
    if (v.effectiveTo !== null && v.effectiveTo < v.effectiveFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveTo'],
        message: 'effectiveTo must be on or after effectiveFrom',
      });
    }
  });
export type RateCardCreate = z.infer<typeof rateCardCreateSchema>;

// Update reuses the same fields but all optional; the base object (pre-refine)
// is what `.partial()` can operate on.
const rateCardObjectSchema = z.object({
  kind: rateKindSchema,
  counterpartyCompanyId: z.string().uuid().nullable(),
  roleId: z.string().uuid(),
  rateMode: rateModeSchema,
  rateLabel: rateLabelSchema,
  hourlyRateCents: cents.nullable(),
  otHourlyRateCents: cents.nullable(),
  shiftRateCents: cents.nullable(),
  dailyRateCents: cents.nullable(),
  minHours: z.number().min(0).nullable(),
  weekendMultiplier: z.number().positive().nullable(),
  nightMultiplier: z.number().positive().nullable(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable(),
  active: z.boolean(),
});
export const rateCardUpdateSchema = rateCardObjectSchema.partial();
export type RateCardUpdate = z.infer<typeof rateCardUpdateSchema>;

export const rateCardViewSchema = rateCardObjectSchema.extend({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RateCardView = z.infer<typeof rateCardViewSchema>;

// ── Resolve endpoint ──────────────────────────────────────────────────────────

export const resolveRateQuerySchema = z.object({
  roleId: z.string().uuid(),
  shiftType: shiftTypeSchema,
  date: isoDate,
  kind: rateKindSchema,
  counterpartyId: z.string().uuid().optional(),
});
export type ResolveRateQuery = z.infer<typeof resolveRateQuerySchema>;

export const resolveRateResponseSchema = z.object({
  label: rateLabelSchema,
  rateCardId: z.string().uuid(),
  rateMode: rateModeSchema,
  baseCents: z.number().int(),
  otCents: z.number().int().nullable(),
});
export type ResolveRateResponse = z.infer<typeof resolveRateResponseSchema>;
