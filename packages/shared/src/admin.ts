import { z } from 'zod';
import { planStatusSchema, priceIntervalSchema } from './enums';
import { featureKeySchema, limitKeySchema } from './entitlements';

/**
 * Super-admin plan management contracts (CREWQUO_V2_PLAN.md §5B, §7).
 * Plans are configurable data — these schemas type the console + api-client.
 */

const planIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_-]{1,40}$/, 'slug: lowercase letters, digits, - or _');

// limits: key -> value, null = unlimited.
const limitsMapSchema = z.record(limitKeySchema, z.number().int().min(0).nullable());

export const adminPlanCreateSchema = z.object({
  id: planIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  status: planStatusSchema.default('DRAFT'),
  isPublic: z.boolean().default(true),
  operatesDownstream: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  trialDays: z.number().int().min(0).default(0),
  features: z.array(featureKeySchema).default([]),
  limits: limitsMapSchema.default({}),
});
export type AdminPlanCreate = z.infer<typeof adminPlanCreateSchema>;

// Update: everything except id is optional; features/limits replace when provided.
export const adminPlanUpdateSchema = adminPlanCreateSchema
  .omit({ id: true })
  .partial();
export type AdminPlanUpdate = z.infer<typeof adminPlanUpdateSchema>;

export const adminPlanPriceSchema = z.object({
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/),
  interval: priceIntervalSchema,
  amountCents: z.number().int().min(0),
  providerPriceId: z.string().optional(),
  active: z.boolean().default(true),
});
export type AdminPlanPrice = z.infer<typeof adminPlanPriceSchema>;

export const adminPlanPriceViewSchema = adminPlanPriceSchema.extend({
  id: z.string().uuid(),
});
export type AdminPlanPriceView = z.infer<typeof adminPlanPriceViewSchema>;

export const adminPlanViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: planStatusSchema,
  isPublic: z.boolean(),
  operatesDownstream: z.boolean(),
  sortOrder: z.number().int(),
  trialDays: z.number().int(),
  features: z.array(featureKeySchema),
  limits: z.record(limitKeySchema, z.number().int().nullable()),
  prices: z.array(adminPlanPriceViewSchema),
});
export type AdminPlanView = z.infer<typeof adminPlanViewSchema>;
