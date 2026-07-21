import type {
  AuthResponse,
  LoginRequest,
  MembershipSummary,
  RateCardCreate,
  RateCardTemplateCreate,
  RateCardTemplateView,
  RateCardUpdate,
  RateCardView,
  RegisterRequest,
  ResolveRateResponse,
  RoleCatalogCreate,
  RoleCatalogView,
} from '@crewquo/shared';

const API_URL: string = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface RequestOptions {
  accessToken?: string | null;
  companyId?: string | null;
  body?: unknown;
  query?: Record<string, string | undefined>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
  if (opts.companyId) headers['X-Company-Id'] = opts.companyId;

  const qs = opts.query
    ? '?' +
      new URLSearchParams(
        Object.entries(opts.query).filter(([, v]) => v !== undefined) as [string, string][]
      ).toString()
    : '';

  const res = await fetch(`${API_URL}${path}${qs}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = json?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'INTERNAL', err.message ?? res.statusText);
  }
  return json as T;
}

/** Shape of a `{ data: T[] }` list response (API §7). */
interface ListResponse<T> {
  data: T[];
}

export const api = {
  // Auth
  register: (body: RegisterRequest) =>
    request<AuthResponse>('POST', '/v1/auth/register', { body }),
  login: (body: LoginRequest) => request<AuthResponse>('POST', '/v1/auth/login', { body }),
  refresh: (refreshToken: string) =>
    request<AuthResponse>('POST', '/v1/auth/refresh', { body: { refreshToken } }),
  logout: (refreshToken: string) =>
    request<void>('POST', '/v1/auth/logout', { body: { refreshToken } }),
  memberships: (accessToken: string) =>
    request<{ memberships: MembershipSummary[] }>('GET', '/v1/me/memberships', { accessToken }),

  // Role catalog
  listRoles: (t: string, c: string) =>
    request<ListResponse<RoleCatalogView>>('GET', '/v1/role-catalog', {
      accessToken: t,
      companyId: c,
    }),
  createRole: (t: string, c: string, body: RoleCatalogCreate) =>
    request<{ role: RoleCatalogView }>('POST', '/v1/role-catalog', {
      accessToken: t,
      companyId: c,
      body,
    }),
  deleteRole: (t: string, c: string, id: string) =>
    request<void>('DELETE', `/v1/role-catalog/${id}`, { accessToken: t, companyId: c }),

  // Rate card templates
  listTemplates: (t: string, c: string) =>
    request<ListResponse<RateCardTemplateView>>('GET', '/v1/rate-card-templates', {
      accessToken: t,
      companyId: c,
    }),
  createTemplate: (t: string, c: string, body: RateCardTemplateCreate) =>
    request<{ template: RateCardTemplateView }>('POST', '/v1/rate-card-templates', {
      accessToken: t,
      companyId: c,
      body,
    }),
  deleteTemplate: (t: string, c: string, id: string) =>
    request<void>('DELETE', `/v1/rate-card-templates/${id}`, { accessToken: t, companyId: c }),

  // Rate cards
  listRateCards: (t: string, c: string) =>
    request<ListResponse<RateCardView>>('GET', '/v1/rate-cards', {
      accessToken: t,
      companyId: c,
    }),
  createRateCard: (t: string, c: string, body: RateCardCreate) =>
    request<{ rateCard: RateCardView }>('POST', '/v1/rate-cards', {
      accessToken: t,
      companyId: c,
      body,
    }),
  updateRateCard: (t: string, c: string, id: string, body: RateCardUpdate) =>
    request<{ rateCard: RateCardView }>('PATCH', `/v1/rate-cards/${id}`, {
      accessToken: t,
      companyId: c,
      body,
    }),
  deleteRateCard: (t: string, c: string, id: string) =>
    request<void>('DELETE', `/v1/rate-cards/${id}`, { accessToken: t, companyId: c }),

  // Resolve
  resolveRate: (
    t: string,
    c: string,
    q: { roleId: string; shiftType: string; date: string; kind: string; counterpartyId?: string }
  ) =>
    request<ResolveRateResponse>('GET', '/v1/rates/resolve', {
      accessToken: t,
      companyId: c,
      query: q,
    }),
};
