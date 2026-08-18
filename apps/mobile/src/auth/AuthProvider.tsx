import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthResponse, MembershipSummary, PublicUser } from '@crewquo/shared';
import { api } from '@/api/client';
import {
  clearActiveCompanyId,
  clearTokens,
  loadActiveCompanyId,
  loadTokens,
  saveActiveCompanyId,
  saveTokens,
} from './store';

interface AuthState {
  ready: boolean; // finished restoring from secure store
  user: PublicUser | null;
  memberships: MembershipSummary[];
  accessToken: string | null;
  refreshToken: string | null;
  activeCompanyId: string | null;
}

interface AuthContextValue extends AuthState {
  applyAuth: (res: AuthResponse) => Promise<void>;
  setActiveCompany: (companyId: string) => Promise<void>;
  refreshMemberships: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const EMPTY: AuthState = {
  ready: false,
  user: null,
  memberships: [],
  accessToken: null,
  refreshToken: null,
  activeCompanyId: null,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(EMPTY);

  // Restore a session on launch: use the refresh token to get a fresh pair.
  useEffect(() => {
    void (async () => {
      const [tokens, activeCompanyId] = await Promise.all([loadTokens(), loadActiveCompanyId()]);
      if (!tokens) {
        setState({ ...EMPTY, ready: true });
        return;
      }
      try {
        const res = await api.refresh(tokens.refreshToken);
        await saveTokens(res.tokens);
        setState({
          ready: true,
          user: res.user,
          memberships: res.memberships,
          accessToken: res.tokens.accessToken,
          refreshToken: res.tokens.refreshToken,
          activeCompanyId: pickActiveCompany(activeCompanyId, res.memberships),
        });
      } catch {
        await clearTokens();
        setState({ ...EMPTY, ready: true });
      }
    })();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      applyAuth: async (res) => {
        await saveTokens(res.tokens);
        const active = pickActiveCompany(state.activeCompanyId, res.memberships);
        if (active) await saveActiveCompanyId(active);
        setState({
          ready: true,
          user: res.user,
          memberships: res.memberships,
          accessToken: res.tokens.accessToken,
          refreshToken: res.tokens.refreshToken,
          activeCompanyId: active,
        });
      },
      setActiveCompany: async (companyId) => {
        await saveActiveCompanyId(companyId);
        setState((s) => ({ ...s, activeCompanyId: companyId }));
      },
      refreshMemberships: async () => {
        if (!state.accessToken) return;
        const { memberships } = await api.memberships(state.accessToken);
        setState((s) => ({
          ...s,
          memberships,
          activeCompanyId: pickActiveCompany(s.activeCompanyId, memberships),
        }));
      },
      signOut: async () => {
        if (state.refreshToken) {
          try {
            await api.logout(state.refreshToken);
          } catch {
            // best-effort; clear locally regardless
          }
        }
        await Promise.all([clearTokens(), clearActiveCompanyId()]);
        setState({ ...EMPTY, ready: true });
      },
    }),
    [state]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Keep the stored active company if still valid, else fall back to the first. */
function pickActiveCompany(
  current: string | null,
  memberships: MembershipSummary[]
): string | null {
  if (current && memberships.some((m) => m.companyId === current)) return current;
  return memberships[0]?.companyId ?? null;
}
