'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthResponse, MembershipSummary, PublicUser, RegisterRequest } from '@crewquo/shared';
import { api } from '@/api/client';

/**
 * Client-side auth/session for the web console. Tokens + the active company live
 * in localStorage; on load we refresh once so a reopened tab restarts cleanly.
 * (Mirrors the mobile AuthProvider; a shared api-client extraction is deferred.)
 */

interface Session {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
  memberships: MembershipSummary[];
}

interface AuthState {
  ready: boolean;
  session: Session | null;
  companyId: string | null;
  activeMembership: MembershipSummary | null;
  login: (email: string, password: string) => Promise<PublicUser>;
  register: (input: RegisterRequest) => Promise<void>;
  logout: () => Promise<void>;
  setCompanyId: (companyId: string) => void;
  /**
   * Re-read `/v1/me/memberships` into the session. Company name and currency are
   * cached in the membership list, so a screen that changes either must call this
   * or the switcher and every money label keep showing the old value.
   */
  refreshMemberships: () => Promise<void>;
  /**
   * Re-read `/v1/me` into the session. The shell renders the display name from the
   * cached user, so editing the profile has to refresh it or the sidebar keeps
   * showing the old name until the next sign-in.
   */
  refreshUser: () => Promise<void>;
  /**
   * Create a company and switch to it. A user who accepted a MEMBER invite has no
   * company of their own, and a user whose only company is somebody else's needs a
   * way to start their own — so this is on the switcher, not buried in settings.
   */
  /**
   * `requestId` names an approved additional-company request (§3.1.1). Omitted
   * for the included first company, which needs no approval — and omitted on a
   * second create too, where the server resolves the caller's single approval
   * itself rather than trusting the screen to pass the right one.
   */
  createCompany: (name: string, currency: string, requestId?: string) => Promise<string>;
}

const STORAGE_KEY = 'crewquo.session';
const COMPANY_KEY = 'crewquo.companyId';

const AuthContext = createContext<AuthState | null>(null);

function persist(session: Session | null) {
  if (typeof window === 'undefined') return;
  if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(STORAGE_KEY);
}

function fromAuthResponse(res: AuthResponse): Session {
  return {
    accessToken: res.tokens.accessToken,
    refreshToken: res.tokens.refreshToken,
    user: res.user,
    memberships: res.memberships,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [companyId, setCompanyIdState] = useState<string | null>(null);

  // Restore + refresh on mount.
  useEffect(() => {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    const savedCompany =
      typeof window !== 'undefined' ? localStorage.getItem(COMPANY_KEY) : null;
    if (!raw) {
      setReady(true);
      return;
    }
    const saved = JSON.parse(raw) as Session;
    api
      .refresh(saved.refreshToken)
      .then((res) => {
        const next = fromAuthResponse(res);
        setSession(next);
        persist(next);
        const valid = savedCompany && next.memberships.some((m) => m.companyId === savedCompany);
        setCompanyIdState(valid ? savedCompany : (next.memberships[0]?.companyId ?? null));
      })
      .catch(() => {
        persist(null);
        setSession(null);
      })
      .finally(() => setReady(true));
  }, []);

  const setCompanyId = useCallback((id: string) => {
    setCompanyIdState(id);
    if (typeof window !== 'undefined') localStorage.setItem(COMPANY_KEY, id);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.login({ email, password });
      const next = fromAuthResponse(res);
      setSession(next);
      persist(next);
      setCompanyId(next.memberships[0]?.companyId ?? '');
      return next.user;
    },
    [setCompanyId]
  );

  const register = useCallback(
    async (input: RegisterRequest) => {
      const res = await api.register(input);
      const next = fromAuthResponse(res);
      setSession(next);
      persist(next);
      // Registering without a company name is allowed by the API, so there may be
      // no membership to select yet — the shell prompts for one in that case.
      setCompanyId(next.memberships[0]?.companyId ?? '');
    },
    [setCompanyId]
  );

  const refreshMemberships = useCallback(async () => {
    if (!session) return;
    const { memberships } = await api.memberships(session.accessToken);
    const next = { ...session, memberships };
    setSession(next);
    persist(next);
  }, [session]);

  const refreshUser = useCallback(async () => {
    if (!session) return;
    const { user } = await api.me(session.accessToken);
    const next = { ...session, user };
    setSession(next);
    persist(next);
  }, [session]);

  const createCompany = useCallback(
    async (name: string, currency: string, requestId?: string) => {
      if (!session) throw new Error('Not signed in');
      const { company } = await api.createCompany(session.accessToken, {
        name,
        currency,
        ...(requestId ? { requestId } : {}),
      });
      const { memberships } = await api.memberships(session.accessToken);
      const next = { ...session, memberships };
      setSession(next);
      persist(next);
      setCompanyId(company.id);
      return company.id;
    },
    [session, setCompanyId]
  );

  const logout = useCallback(async () => {
    if (session) await api.logout(session.refreshToken).catch(() => undefined);
    setSession(null);
    setCompanyIdState(null);
    persist(null);
    if (typeof window !== 'undefined') localStorage.removeItem(COMPANY_KEY);
  }, [session]);

  const value = useMemo<AuthState>(() => {
    const activeMembership =
      session?.memberships.find((m) => m.companyId === companyId) ?? null;
    return {
      ready,
      session,
      companyId,
      activeMembership,
      login,
      register,
      logout,
      setCompanyId,
      refreshMemberships,
      refreshUser,
      createCompany,
    };
  }, [
    ready,
    session,
    companyId,
    login,
    register,
    logout,
    setCompanyId,
    refreshMemberships,
    refreshUser,
    createCompany,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Convenience: the tokens+company a screen needs, or null when signed out. */
export function useSessionCtx(): { accessToken: string; companyId: string } | null {
  const { session, companyId } = useAuth();
  return useMemo(
    () => session && companyId ? { accessToken: session.accessToken, companyId } : null,
    [session, companyId]
  );
}
