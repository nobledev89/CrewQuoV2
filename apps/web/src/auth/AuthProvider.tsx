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
import type { AuthResponse, MembershipSummary } from '@crewquo/shared';
import { api } from '@/api/client';

/**
 * Client-side auth/session for the web console. Tokens + the active company live
 * in localStorage; on load we refresh once so a reopened tab restarts cleanly.
 * (Mirrors the mobile AuthProvider; a shared api-client extraction is deferred.)
 */

interface Session {
  accessToken: string;
  refreshToken: string;
  memberships: MembershipSummary[];
}

interface AuthState {
  ready: boolean;
  session: Session | null;
  companyId: string | null;
  activeMembership: MembershipSummary | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setCompanyId: (companyId: string) => void;
  /**
   * Re-read `/v1/me/memberships` into the session. Company name and currency are
   * cached in the membership list, so a screen that changes either must call this
   * or the switcher and every money label keep showing the old value.
   */
  refreshMemberships: () => Promise<void>;
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
      logout,
      setCompanyId,
      refreshMemberships,
    };
  }, [ready, session, companyId, login, logout, setCompanyId, refreshMemberships]);

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
  if (!session || !companyId) return null;
  return { accessToken: session.accessToken, companyId };
}
