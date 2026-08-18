import type {
  AcceptInviteResponse,
  AdminCompaniesResponse,
  AdminCompanyDetail,
  AdminCompanySummary,
  AdminCompTrial,
  AdminOverrideCreate,
  AdminOverrideView,
  AdminPlanCreate,
  AdminPlanPrice,
  AdminPlanPriceView,
  AdminPlanUpdate,
  AdminPlanView,
  AdminSetSubscription,
  AssignmentView,
  AuditLogsResponse,
  AuditSettings,
  AuthResponse,
  ClientView,
  CommercialAgreement,
  CompanySummary,
  CreateAssignment,
  CreateClient,
  CreateClientResponse,
  CreateCompanyRequest,
  CreateEngagement,
  CreateExpense,
  CreateInvoice,
  CreateInvoiceItem,
  CreateLineItemNote,
  CreateProject,
  CreateProvider,
  CreateProviderResponse,
  CreateRateProposal,
  CreateSubmission,
  CreateTimeLog,
  DirectRateSchedule,
  EngagementTermsView,
  EngagementView,
  EntitlementsResponse,
  ExpenseView,
  FeatureKey,
  InviteMember,
  InviteView,
  InvoiceView,
  LimitKey,
  LineItemNoteView,
  LoginRequest,
  MeResponse,
  MemberView,
  MembershipSummary,
  PendingAssignmentView,
  PortalProjectDetail,
  PortalProjectView,
  ProjectSummary,
  ProjectView,
  ProviderView,
  RateCardCreate,
  RateCardTemplateCreate,
  RateCardTemplateUpdate,
  RateCardTemplateView,
  RateCardUpdate,
  RateCardView,
  RateProposalView,
  RegisterRequest,
  ResolveRateResponse,
  RoleCatalogCreate,
  RoleCatalogView,
  SubmissionView,
  TimeLogView,
  UpdateAuditSettings,
  UpdateCompany,
  UpdateEngagement,
  UpdateEngagementTerms,
  UpdateExpense,
  UpdateInvoice,
  UpdateInvoiceItem,
  UpdateLineItemNote,
  UpdateMe,
  UpdateMember,
  UpdateProject,
  UpdateRateProposal,
  UpdateTimeLog,
  WorkContext,
  WorkStatus,
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
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * The feature key an entitlement refusal names, when it names one. The API sends
 * `{ error: { code: 'FORBIDDEN', details: { feature: 'client_portal' } } }`, which
 * lets a screen say *which* upgrade unlocks the action instead of "forbidden".
 */
export function refusedFeature(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details;
  if (details && typeof details === 'object' && 'feature' in details) {
    const feature = (details as { feature?: unknown }).feature;
    if (typeof feature === 'string') return feature;
  }
  return null;
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
    throw new ApiError(
      res.status,
      err.code ?? 'INTERNAL',
      err.message ?? res.statusText,
      err.details
    );
  }
  return json as T;
}

/**
 * Download a binary export as a Blob. Exports are the one endpoint that does not
 * return JSON, and a failure still carries the §7 error envelope — so parse the
 * body as an envelope before deciding it was a transport problem.
 */
async function download(path: string, opts: RequestOptions): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
  if (opts.companyId) headers['X-Company-Id'] = opts.companyId;

  const res = await fetch(`${API_URL}${path}`, { method: 'GET', headers, cache: 'no-store' });
  if (!res.ok) {
    let code = 'INTERNAL';
    let message = res.statusText;
    try {
      const parsed = JSON.parse(await res.text());
      code = parsed?.error?.code ?? code;
      message = parsed?.error?.message ?? message;
    } catch {
      /* a non-JSON failure body: keep the status text */
    }
    throw new ApiError(res.status, code, message);
  }
  return res.blob();
}

/** Shape of a `{ data: T[] }` list response (API §7). */
interface ListResponse<T> {
  data: T[];
}

/** Filters accepted by the three worklist endpoints (time logs, expenses, submissions). */
export interface WorkListQuery {
  status?: WorkStatus;
  engagementId?: string;
  projectId?: string;
}

function workQuery(q: WorkListQuery): Record<string, string | undefined> {
  return { status: q.status, engagementId: q.engagementId, projectId: q.projectId };
}

export const api = {
  // ── Auth ─────────────────────────────────────────────────────────────────────
  register: (body: RegisterRequest) =>
    request<AuthResponse>('POST', '/v1/auth/register', { body }),
  login: (body: LoginRequest) => request<AuthResponse>('POST', '/v1/auth/login', { body }),
  refresh: (refreshToken: string) =>
    request<AuthResponse>('POST', '/v1/auth/refresh', { body: { refreshToken } }),
  logout: (refreshToken: string) =>
    request<void>('POST', '/v1/auth/logout', { body: { refreshToken } }),
  requestPasswordReset: (email: string) =>
    request<{ ok: true }>('POST', '/v1/auth/request-password-reset', { body: { email } }),
  resetPassword: (token: string, password: string) =>
    request<{ ok: true }>('POST', '/v1/auth/reset-password', { body: { token, password } }),
  verifyEmail: (token: string) =>
    request<{ ok: true }>('POST', '/v1/auth/verify-email', { body: { token } }),

  // ── Me / context ─────────────────────────────────────────────────────────────
  me: (t: string) => request<MeResponse>('GET', '/v1/me', { accessToken: t }),
  updateMe: (t: string, body: UpdateMe) =>
    request<MeResponse>('PATCH', '/v1/me', { accessToken: t, body }),
  memberships: (accessToken: string) =>
    request<{ memberships: MembershipSummary[] }>('GET', '/v1/me/memberships', { accessToken }),
  createCompany: (t: string, body: CreateCompanyRequest) =>
    request<{ company: CompanySummary }>('POST', '/v1/me/companies', {
      accessToken: t,
      body,
    }),

  // ── Company settings (§7) — OWNER/ADMIN may change the currency ──────────────
  getCompany: (t: string, c: string) =>
    request<{ company: CompanySummary }>('GET', `/v1/companies/${c}`, {
      accessToken: t,
      companyId: c,
    }),
  updateCompany: (t: string, c: string, body: UpdateCompany) =>
    request<{ company: CompanySummary }>('PATCH', `/v1/companies/${c}`, {
      accessToken: t,
      companyId: c,
      body,
    }),

  // ── Entitlements ─────────────────────────────────────────────────────────────
  entitlements: (t: string, c: string) =>
    request<EntitlementsResponse>('GET', '/v1/entitlements', { accessToken: t, companyId: c }),

  // ── Role catalog ─────────────────────────────────────────────────────────────
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

  // ── Rate card templates ──────────────────────────────────────────────────────
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
  updateTemplate: (t: string, c: string, id: string, body: RateCardTemplateUpdate) =>
    request<{ template: RateCardTemplateView }>('PATCH', `/v1/rate-card-templates/${id}`, {
      accessToken: t,
      companyId: c,
      body,
    }),
  deleteTemplate: (t: string, c: string, id: string) =>
    request<void>('DELETE', `/v1/rate-card-templates/${id}`, { accessToken: t, companyId: c }),

  // ── Rate cards ───────────────────────────────────────────────────────────────
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

  // ── Resolve ──────────────────────────────────────────────────────────────────
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

  // ── Engagements ──────────────────────────────────────────────────────────────
  listEngagements: (t: string, c: string) =>
    request<ListResponse<EngagementView>>('GET', '/v1/engagements', {
      accessToken: t,
      companyId: c,
    }),
  createEngagement: (t: string, c: string, body: CreateEngagement) =>
    request<{ engagement: EngagementView }>('POST', '/v1/engagements', {
      accessToken: t,
      companyId: c,
      body,
    }),
  updateEngagement: (t: string, c: string, id: string, body: UpdateEngagement) =>
    request<{ engagement: EngagementView }>('PATCH', `/v1/engagements/${id}`, {
      accessToken: t,
      companyId: c,
      body,
    }),

  // ── Providers & clients ──────────────────────────────────────────────────────
  listProviders: (t: string, c: string) =>
    request<ListResponse<ProviderView>>('GET', '/v1/providers', { accessToken: t, companyId: c }),
  createProvider: (t: string, c: string, body: CreateProvider) =>
    request<CreateProviderResponse>('POST', '/v1/providers', {
      accessToken: t,
      companyId: c,
      body,
    }),
  listClients: (t: string, c: string) =>
    request<ListResponse<ClientView>>('GET', '/v1/clients', { accessToken: t, companyId: c }),
  createClient: (t: string, c: string, body: CreateClient) =>
    request<CreateClientResponse>('POST', '/v1/clients', { accessToken: t, companyId: c, body }),

  // ── Members & invites ────────────────────────────────────────────────────────
  listMembers: (t: string, c: string) =>
    request<ListResponse<MemberView>>('GET', '/v1/members', { accessToken: t, companyId: c }),
  inviteMember: (t: string, c: string, body: InviteMember) =>
    request<{ inviteToken: string }>('POST', '/v1/members/invite', {
      accessToken: t,
      companyId: c,
      body,
    }),
  /** Addressed by membership id, not user id — the same person may be a member of several companies. */
  updateMember: (t: string, c: string, membershipId: string, body: UpdateMember) =>
    request<{ member: MemberView }>('PATCH', `/v1/members/${membershipId}`, {
      accessToken: t,
      companyId: c,
      body,
    }),
  removeMember: (t: string, c: string, membershipId: string) =>
    request<void>('DELETE', `/v1/members/${membershipId}`, { accessToken: t, companyId: c }),
  /** Public — the token is the capability, so no auth (§7). */
  getInvite: (token: string) =>
    request<{ invite: InviteView }>('GET', `/v1/invites/${encodeURIComponent(token)}`),
  /**
   * Accept an invite. `companyId` is optional and only a *preference*: for an edge
   * invite it tells the merge which of the accepter's companies to claim the
   * placeholder into (§3.6 auto-merge).
   */
  acceptInvite: (t: string, token: string, companyId?: string | null) =>
    request<AcceptInviteResponse>('POST', `/v1/invites/${encodeURIComponent(token)}/accept`, {
      accessToken: t,
      companyId: companyId ?? undefined,
    }),

  // ── Projects ─────────────────────────────────────────────────────────────────
  listProjects: (t: string, c: string) =>
    request<ListResponse<ProjectView>>('GET', '/v1/projects', { accessToken: t, companyId: c }),
  getProject: (t: string, c: string, id: string) =>
    request<{ project: ProjectView }>('GET', `/v1/projects/${id}`, {
      accessToken: t,
      companyId: c,
    }),
  createProject: (t: string, c: string, body: CreateProject) =>
    request<{ project: ProjectView }>('POST', '/v1/projects', {
      accessToken: t,
      companyId: c,
      body,
    }),
  updateProject: (t: string, c: string, id: string, body: UpdateProject) =>
    request<{ project: ProjectView }>('PATCH', `/v1/projects/${id}`, {
      accessToken: t,
      companyId: c,
      body,
    }),
  deleteProject: (t: string, c: string, id: string) =>
    request<void>('DELETE', `/v1/projects/${id}`, { accessToken: t, companyId: c }),
  listAssignments: (t: string, c: string, id: string) =>
    request<ListResponse<AssignmentView>>('GET', `/v1/projects/${id}/assignments`, {
      accessToken: t,
      companyId: c,
    }),
  createAssignment: (t: string, c: string, id: string, body: CreateAssignment) =>
    request<ListResponse<AssignmentView>>('POST', `/v1/projects/${id}/assignments`, {
      accessToken: t,
      companyId: c,
      body,
    }),
  projectSummary: (t: string, c: string, id: string) =>
    request<{ summary: ProjectSummary }>('GET', `/v1/projects/${id}/summary`, {
      accessToken: t,
      companyId: c,
    }),
  /** Owner-side export (feature: `exports`). Returns the file itself. */
  exportProject: (t: string, c: string, id: string, format: 'pdf' | 'xlsx') =>
    download(`/v1/projects/${id}/export.${format}`, { accessToken: t, companyId: c }),

  // ── Invoices (§3.5) ─────────────────────────────────────────────────────────
  listInvoices: (t: string, c: string) =>
    request<ListResponse<InvoiceView>>('GET', '/v1/invoices', { accessToken: t, companyId: c }),
  getInvoice: (t: string, c: string, id: string) =>
    request<{ invoice: InvoiceView }>('GET', `/v1/invoices/${id}`, {
      accessToken: t, companyId: c,
    }),
  createInvoice: (t: string, c: string, body: CreateInvoice) =>
    request<{ invoice: InvoiceView }>('POST', '/v1/invoices', {
      accessToken: t, companyId: c, body,
    }),
  updateInvoice: (t: string, c: string, id: string, body: UpdateInvoice) =>
    request<{ invoice: InvoiceView }>('PATCH', `/v1/invoices/${id}`, {
      accessToken: t, companyId: c, body,
    }),
  deleteInvoice: (t: string, c: string, id: string) =>
    request<void>('DELETE', `/v1/invoices/${id}`, { accessToken: t, companyId: c }),
  addInvoiceItem: (t: string, c: string, id: string, body: CreateInvoiceItem) =>
    request<{ invoice: InvoiceView }>('POST', `/v1/invoices/${id}/items`, {
      accessToken: t, companyId: c, body,
    }),
  importApprovedInvoiceItems: (t: string, c: string, id: string) =>
    request<{ invoice: InvoiceView }>('POST', `/v1/invoices/${id}/items/import-approved`, {
      accessToken: t, companyId: c,
    }),
  updateInvoiceItem: (t: string, c: string, id: string, itemId: string, body: UpdateInvoiceItem) =>
    request<{ invoice: InvoiceView }>('PATCH', `/v1/invoices/${id}/items/${itemId}`, {
      accessToken: t, companyId: c, body,
    }),
  deleteInvoiceItem: (t: string, c: string, id: string, itemId: string) =>
    request<{ invoice: InvoiceView }>('DELETE', `/v1/invoices/${id}/items/${itemId}`, {
      accessToken: t, companyId: c,
    }),
  issueInvoice: (t: string, c: string, id: string) =>
    request<{ invoice: InvoiceView }>('POST', `/v1/invoices/${id}/issue`, {
      accessToken: t, companyId: c,
    }),
  markInvoicePaid: (t: string, c: string, id: string) =>
    request<{ invoice: InvoiceView }>('POST', `/v1/invoices/${id}/paid`, {
      accessToken: t, companyId: c,
    }),
  voidInvoice: (t: string, c: string, id: string) =>
    request<{ invoice: InvoiceView }>('POST', `/v1/invoices/${id}/void`, {
      accessToken: t, companyId: c,
    }),

  // ── Commercial agreements (§3.3.1) ──────────────────────────────────────────
  /** One engagement's terms, live PAY schedule and proposal history in one call. */
  getCommercialAgreement: (t: string, c: string, engagementId: string) =>
    request<{ agreement: CommercialAgreement }>(
      'GET', `/v1/commercial-agreements/${engagementId}`, { accessToken: t, companyId: c }
    ),
  /** Hiring-side direct entry for a schedule agreed outside CrewQuo. */
  recordRateSchedule: (t: string, c: string, engagementId: string, body: Omit<DirectRateSchedule, 'engagementId'>) =>
    request<{ rateCardIds: string[]; supersededRateCardIds: string[]; currency: string }>(
      'POST', `/v1/commercial-agreements/${engagementId}/schedule`,
      { accessToken: t, companyId: c, body }
    ),
  listRateProposals: (t: string, c: string, engagementId?: string) =>
    request<ListResponse<RateProposalView>>('GET', '/v1/rate-proposals', {
      accessToken: t, companyId: c, query: { engagementId },
    }),
  getRateProposal: (t: string, c: string, id: string) =>
    request<{ proposal: RateProposalView }>('GET', `/v1/rate-proposals/${id}`, {
      accessToken: t, companyId: c,
    }),
  createRateProposal: (t: string, c: string, body: CreateRateProposal) =>
    request<{ proposal: RateProposalView }>('POST', '/v1/rate-proposals', {
      accessToken: t, companyId: c, body,
    }),
  updateRateProposal: (t: string, c: string, id: string, body: UpdateRateProposal) =>
    request<{ proposal: RateProposalView }>('PATCH', `/v1/rate-proposals/${id}`, {
      accessToken: t, companyId: c, body,
    }),
  deleteRateProposal: (t: string, c: string, id: string) =>
    request<void>('DELETE', `/v1/rate-proposals/${id}`, { accessToken: t, companyId: c }),
  submitRateProposal: (t: string, c: string, id: string) =>
    request<{ proposal: RateProposalView }>('POST', `/v1/rate-proposals/${id}/submit`, {
      accessToken: t, companyId: c,
    }),
  withdrawRateProposal: (t: string, c: string, id: string) =>
    request<{ proposal: RateProposalView }>('POST', `/v1/rate-proposals/${id}/withdraw`, {
      accessToken: t, companyId: c,
    }),
  approveRateProposal: (t: string, c: string, id: string, retroactiveReason: string | null = null) =>
    request<{ proposal: RateProposalView; rateCardIds: string[]; supersededRateCardIds: string[] }>(
      'POST', `/v1/rate-proposals/${id}/approve`,
      { accessToken: t, companyId: c, body: { retroactiveReason } }
    ),
  rejectRateProposal: (t: string, c: string, id: string, reason: string) =>
    request<{ proposal: RateProposalView }>('POST', `/v1/rate-proposals/${id}/reject`, {
      accessToken: t, companyId: c, body: { reason },
    }),

  // ── Engagement commercial terms + acceptance ────────────────────────────────
  getEngagementTerms: (t: string, c: string, id: string) =>
    request<{ terms: EngagementTermsView }>('GET', `/v1/engagements/${id}/terms`, {
      accessToken: t, companyId: c,
    }),
  updateEngagementTerms: (t: string, c: string, id: string, body: UpdateEngagementTerms) =>
    request<{ terms: EngagementTermsView }>('PATCH', `/v1/engagements/${id}/terms`, {
      accessToken: t, companyId: c, body,
    }),
  acceptEngagement: (t: string, c: string, id: string, reason: string | null = null) =>
    request<{ engagement: EngagementView }>('POST', `/v1/engagements/${id}/accept`, {
      accessToken: t, companyId: c, body: { reason },
    }),
  declineEngagement: (t: string, c: string, id: string, reason: string | null = null) =>
    request<{ engagement: EngagementView }>('POST', `/v1/engagements/${id}/decline`, {
      accessToken: t, companyId: c, body: { reason },
    }),
  listPendingAssignments: (t: string, c: string) =>
    request<ListResponse<PendingAssignmentView>>('GET', '/v1/projects/assignments/pending', {
      accessToken: t, companyId: c,
    }),
  acceptAssignment: (t: string, c: string, assignmentId: string, reason: string | null = null) =>
    request<{ assignment: PendingAssignmentView }>(
      'POST', `/v1/projects/assignments/${assignmentId}/accept`,
      { accessToken: t, companyId: c, body: { reason } }
    ),
  declineAssignment: (t: string, c: string, assignmentId: string, reason: string | null = null) =>
    request<{ assignment: PendingAssignmentView }>(
      'POST', `/v1/projects/assignments/${assignmentId}/decline`,
      { accessToken: t, companyId: c, body: { reason } }
    ),

  // ── Work: time logs ──────────────────────────────────────────────────────────
  workContext: (t: string, c: string) =>
    request<WorkContext>('GET', '/v1/work-context', { accessToken: t, companyId: c }),
  listTimeLogs: (t: string, c: string, q: WorkListQuery = {}) =>
    request<ListResponse<TimeLogView>>('GET', '/v1/time-logs', {
      accessToken: t,
      companyId: c,
      query: workQuery(q),
    }),
  createTimeLog: (t: string, c: string, body: CreateTimeLog) =>
    request<{ timeLog: TimeLogView }>('POST', '/v1/time-logs', {
      accessToken: t,
      companyId: c,
      body,
    }),
  updateTimeLog: (t: string, c: string, id: string, body: UpdateTimeLog) =>
    request<{ timeLog: TimeLogView }>('PATCH', `/v1/time-logs/${id}`, {
      accessToken: t,
      companyId: c,
      body,
    }),
  submitTimeLog: (t: string, c: string, id: string) =>
    request<{ timeLog: TimeLogView }>('POST', `/v1/time-logs/${id}/submit`, {
      accessToken: t,
      companyId: c,
    }),
  approveTimeLog: (t: string, c: string, id: string) =>
    request<{ timeLog: TimeLogView }>('POST', `/v1/time-logs/${id}/approve`, {
      accessToken: t,
      companyId: c,
    }),
  rejectTimeLog: (t: string, c: string, id: string, reason?: string) =>
    request<{ timeLog: TimeLogView }>('POST', `/v1/time-logs/${id}/reject`, {
      accessToken: t,
      companyId: c,
      body: reason ? { reason } : {},
    }),
  deleteTimeLog: (t: string, c: string, id: string) =>
    request<void>('DELETE', `/v1/time-logs/${id}`, { accessToken: t, companyId: c }),

  // ── Work: expenses ───────────────────────────────────────────────────────────
  listExpenses: (t: string, c: string, q: WorkListQuery = {}) =>
    request<ListResponse<ExpenseView>>('GET', '/v1/expenses', {
      accessToken: t,
      companyId: c,
      query: workQuery(q),
    }),
  createExpense: (t: string, c: string, body: CreateExpense) =>
    request<{ expense: ExpenseView }>('POST', '/v1/expenses', {
      accessToken: t,
      companyId: c,
      body,
    }),
  updateExpense: (t: string, c: string, id: string, body: UpdateExpense) =>
    request<{ expense: ExpenseView }>('PATCH', `/v1/expenses/${id}`, {
      accessToken: t,
      companyId: c,
      body,
    }),
  submitExpense: (t: string, c: string, id: string) =>
    request<{ expense: ExpenseView }>('POST', `/v1/expenses/${id}/submit`, {
      accessToken: t,
      companyId: c,
    }),
  approveExpense: (t: string, c: string, id: string) =>
    request<{ expense: ExpenseView }>('POST', `/v1/expenses/${id}/approve`, {
      accessToken: t,
      companyId: c,
    }),
  rejectExpense: (t: string, c: string, id: string, reason?: string) =>
    request<{ expense: ExpenseView }>('POST', `/v1/expenses/${id}/reject`, {
      accessToken: t,
      companyId: c,
      body: reason ? { reason } : {},
    }),
  deleteExpense: (t: string, c: string, id: string) =>
    request<void>('DELETE', `/v1/expenses/${id}`, { accessToken: t, companyId: c }),

  // ── Work: project submissions ────────────────────────────────────────────────
  listSubmissions: (t: string, c: string, q: WorkListQuery = {}) =>
    request<ListResponse<SubmissionView>>('GET', '/v1/project-submissions', {
      accessToken: t,
      companyId: c,
      query: workQuery(q),
    }),
  createSubmission: (t: string, c: string, body: CreateSubmission) =>
    request<{ submission: SubmissionView }>('POST', '/v1/project-submissions', {
      accessToken: t,
      companyId: c,
      body,
    }),
  submitSubmission: (t: string, c: string, id: string) =>
    request<{ submission: SubmissionView }>('POST', `/v1/project-submissions/${id}/submit`, {
      accessToken: t,
      companyId: c,
    }),
  approveSubmission: (t: string, c: string, id: string) =>
    request<{ submission: SubmissionView }>('POST', `/v1/project-submissions/${id}/approve`, {
      accessToken: t,
      companyId: c,
    }),
  rejectSubmission: (t: string, c: string, id: string, reason?: string) =>
    request<{ submission: SubmissionView }>('POST', `/v1/project-submissions/${id}/reject`, {
      accessToken: t,
      companyId: c,
      body: reason ? { reason } : {},
    }),

  // ── Client portal (active company is the CLIENT on the edge) ─────────────────
  portalProjects: (t: string, c: string) =>
    request<ListResponse<PortalProjectView>>('GET', '/v1/portal/projects', {
      accessToken: t,
      companyId: c,
    }),
  portalProject: (t: string, c: string, id: string) =>
    request<PortalProjectDetail>('GET', `/v1/portal/projects/${id}`, {
      accessToken: t,
      companyId: c,
    }),

  // ── Line-item notes ──────────────────────────────────────────────────────────
  listNotes: (
    t: string,
    c: string,
    q: { engagementId?: string; entityType?: string; entityId?: string } = {}
  ) =>
    request<ListResponse<LineItemNoteView>>('GET', '/v1/line-item-notes', {
      accessToken: t,
      companyId: c,
      query: q,
    }),
  createNote: (t: string, c: string, body: CreateLineItemNote) =>
    request<{ note: LineItemNoteView }>('POST', '/v1/line-item-notes', {
      accessToken: t,
      companyId: c,
      body,
    }),
  updateNote: (t: string, c: string, id: string, body: UpdateLineItemNote) =>
    request<{ note: LineItemNoteView }>('PATCH', `/v1/line-item-notes/${id}`, {
      accessToken: t,
      companyId: c,
      body,
    }),
  deleteNote: (t: string, c: string, id: string) =>
    request<void>('DELETE', `/v1/line-item-notes/${id}`, { accessToken: t, companyId: c }),

  // ── Audit ────────────────────────────────────────────────────────────────────
  listAuditLogs: (
    t: string,
    c: string,
    q: { engagementId?: string; entityType?: string; entityId?: string; limit?: number; before?: string } = {}
  ) =>
    request<AuditLogsResponse>('GET', '/v1/audit-logs', {
      accessToken: t,
      companyId: c,
      query: {
        engagementId: q.engagementId,
        entityType: q.entityType,
        entityId: q.entityId,
        limit: q.limit === undefined ? undefined : String(q.limit),
        before: q.before,
      },
    }),
  getAuditSettings: (t: string, c: string, engagementId: string) =>
    request<{ settings: AuditSettings }>('GET', `/v1/audit-settings/${engagementId}`, {
      accessToken: t,
      companyId: c,
    }),
  updateAuditSettings: (t: string, c: string, engagementId: string, body: UpdateAuditSettings) =>
    request<{ settings: AuditSettings }>('PUT', `/v1/audit-settings/${engagementId}`, {
      accessToken: t,
      companyId: c,
      body,
    }),

  // ── Super-admin (isSuperAdmin only) ──────────────────────────────────────────
  adminListPlans: (t: string) =>
    request<{ plans: AdminPlanView[] }>('GET', '/v1/admin/plans', { accessToken: t }),
  adminCreatePlan: (t: string, body: AdminPlanCreate) =>
    request<{ plan: AdminPlanView }>('POST', '/v1/admin/plans', { accessToken: t, body }),
  adminUpdatePlan: (t: string, id: string, body: AdminPlanUpdate) =>
    request<{ plan: AdminPlanView }>('PATCH', `/v1/admin/plans/${id}`, { accessToken: t, body }),
  adminUpsertPrice: (t: string, id: string, body: AdminPlanPrice) =>
    request<{ price: AdminPlanPriceView }>('POST', `/v1/admin/plans/${id}/prices`, {
      accessToken: t,
      body,
    }),
  /** Companies console (§5B). `cursor` is opaque — echo back what the last page returned. */
  adminListCompanies: (
    t: string,
    q: { search?: string; planId?: string; includePlaceholders?: boolean; cursor?: string } = {}
  ) =>
    request<AdminCompaniesResponse>('GET', '/v1/admin/companies', {
      accessToken: t,
      query: {
        search: q.search || undefined,
        planId: q.planId || undefined,
        includePlaceholders: q.includePlaceholders ? 'true' : undefined,
        cursor: q.cursor || undefined,
      },
    }),
  adminCompany: (t: string, id: string) =>
    request<AdminCompanyDetail>('GET', `/v1/admin/companies/${id}`, { accessToken: t }),
  adminAddOverride: (t: string, id: string, body: AdminOverrideCreate) =>
    request<{ override: AdminOverrideView }>('POST', `/v1/admin/companies/${id}/overrides`, {
      accessToken: t,
      body,
    }),
  adminRemoveOverride: (t: string, id: string, overrideId: string) =>
    request<void>('DELETE', `/v1/admin/companies/${id}/overrides/${overrideId}`, {
      accessToken: t,
    }),
  adminSetSubscription: (t: string, id: string, body: AdminSetSubscription) =>
    request<{ company: AdminCompanySummary }>('POST', `/v1/admin/companies/${id}/subscription`, {
      accessToken: t,
      body,
    }),
  adminCompTrial: (t: string, id: string, body: AdminCompTrial) =>
    request<{ company: AdminCompanySummary }>('POST', `/v1/admin/companies/${id}/comp-trial`, {
      accessToken: t,
      body,
    }),
  adminFeatures: (t: string) =>
    request<{ features: { key: FeatureKey; name: string; description: string | null; category: string | null }[] }>(
      'GET',
      '/v1/admin/features',
      { accessToken: t }
    ),
  adminLimits: (t: string) =>
    request<{ limits: { key: LimitKey; name: string; description: string | null; unit: string; unlimitedAllowed: boolean }[] }>(
      'GET',
      '/v1/admin/limits',
      { accessToken: t }
    ),
};
