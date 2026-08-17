import Constants from 'expo-constants';
import type {
  AuthResponse,
  CreateCompanyRequest,
  CreateTimeLog,
  EntitlementsResponse,
  LoginRequest,
  MembershipsResponse,
  MeResponse,
  RegisterRequest,
  TimeLogView,
  WorkContext,
  WorkStatus,
} from '@crewquo/shared';

const API_URL: string =
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://localhost:4000';

export interface RequestOptions {
  accessToken?: string;
  companyId?: string | null;
  body?: unknown;
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

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const err = json?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'INTERNAL', err.message ?? res.statusText);
  }
  return json as T;
}

export const api = {
  register: (body: RegisterRequest) =>
    request<AuthResponse>('POST', '/v1/auth/register', { body }),
  login: (body: LoginRequest) => request<AuthResponse>('POST', '/v1/auth/login', { body }),
  refresh: (refreshToken: string) =>
    request<AuthResponse>('POST', '/v1/auth/refresh', { body: { refreshToken } }),
  logout: (refreshToken: string) =>
    request<void>('POST', '/v1/auth/logout', { body: { refreshToken } }),

  me: (accessToken: string) => request<MeResponse>('GET', '/v1/me', { accessToken }),
  memberships: (accessToken: string) =>
    request<MembershipsResponse>('GET', '/v1/me/memberships', { accessToken }),
  createCompany: (accessToken: string, body: CreateCompanyRequest) =>
    request<{ company: { id: string; name: string } }>('POST', '/v1/me/companies', {
      accessToken,
      body,
    }),

  entitlements: (accessToken: string, companyId: string) =>
    request<EntitlementsResponse>('GET', '/v1/entitlements', { accessToken, companyId }),

  // ── Phase 3: work loop ──────────────────────────────────────────────────────
  workContext: (accessToken: string, companyId: string) =>
    request<WorkContext>('GET', '/v1/work-context', { accessToken, companyId }),

  timeLogs: (accessToken: string, companyId: string, status?: WorkStatus) =>
    request<{ data: TimeLogView[] }>(
      'GET',
      `/v1/time-logs${status ? `?status=${status}` : ''}`,
      { accessToken, companyId }
    ),

  createTimeLog: (accessToken: string, companyId: string, body: CreateTimeLog) =>
    request<{ timeLog: TimeLogView }>('POST', '/v1/time-logs', { accessToken, companyId, body }),

  submitTimeLog: (accessToken: string, companyId: string, id: string) =>
    request<{ timeLog: TimeLogView }>('POST', `/v1/time-logs/${id}/submit`, {
      accessToken,
      companyId,
    }),

  approveTimeLog: (accessToken: string, companyId: string, id: string) =>
    request<{ timeLog: TimeLogView }>('POST', `/v1/time-logs/${id}/approve`, {
      accessToken,
      companyId,
    }),

  rejectTimeLog: (accessToken: string, companyId: string, id: string, reason?: string) =>
    request<{ timeLog: TimeLogView }>('POST', `/v1/time-logs/${id}/reject`, {
      accessToken,
      companyId,
      body: { reason },
    }),

  registerPushToken: (accessToken: string, token: string, platform?: string) =>
    request<void>('POST', '/v1/push/tokens', { accessToken, body: { token, platform } }),
};
