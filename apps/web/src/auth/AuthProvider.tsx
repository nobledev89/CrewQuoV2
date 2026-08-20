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
import type {
  AuthResponse,
  LoginChallenge,
  MembershipSummary,
  PublicUser,
  RegisterRequest,
} from '@crewquo/shared';
import { api, setSessionRecovery } from '@/api/client';

/**
 * Client-side auth/session for the web console. Tokens + the active company live
 * in localStorage; on load we refresh once so a reopened tab restarts cleanly, and
 * again whenever the API refuses the access token we sent — see `recover` below.
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
  /**
   * Sign in, which may not finish here.
   *
   * Returns either the signed-in user or the challenge the account's second factor
   * demands (`access.md` §3). A union rather than a nullable user, because the two
   * outcomes need different screens and the caller must not be able to treat an
   * unanswered challenge as a session.
   */
  login: (email: string, password: string) => Promise<PublicUser | LoginChallenge>;
  /** Answer a challenge with a TOTP code or a recovery code, completing the sign-in. */
  completeMfa: (input: {
    challengeToken: string;
    code?: string;
    recoveryCode?: string;
  }) => Promise<PublicUser>;
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

/**
 * React Strict Mode intentionally mounts effects twice in development. Refresh
 * tokens rotate on use, so two providers restoring the same saved session must
 * share one request rather than race the token against itself. The promise lives
 * at module scope because Strict Mode tears down the first provider instance
 * before mounting the second one.
 */
let refreshFlight: { token: string; promise: ReturnType<typeof api.refresh> } | null = null;

function refreshOnce(token: string): ReturnType<typeof api.refresh> {
  if (refreshFlight?.token === token) return refreshFlight.promise;

  const promise = api.refresh(token);
  refreshFlight = { token, promise };
  const clear = () => {
    if (refreshFlight?.promise === promise) refreshFlight = null;
  };
  void promise.then(clear, clear);
  return promise;
}

/**
 * The stored session, or null.
 *
 * localStorage rather than React state on purpose: the recovery below runs from a
 * closure created once, so reading state would read whatever the session was when the
 * provider mounted — which, for the one code path whose entire job is to notice that
 * the token has moved on, is the wrong answer by construction.
 */
function stored(): Session | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Session) : null;
}

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

  /**
   * Recover a session the API has just refused, without a reload.
   *
   * A tab left open past the fifteen-minute access token used to start failing and
   * keep failing: the refresh happened once on mount and never again, so the fix was
   * a page reload the person had to think of themselves. The API now says which 401s
   * are about the token (`WWW-Authenticate: Bearer`), and this answers those.
   *
   * Registered once, outside the render cycle, because the caller is `api/client.ts` —
   * a plain module with no way to reach a hook.
   */
  useEffect(() => {
    return setSessionRecovery(async (rejected) => {
      const saved = stored();
      if (!saved) return null;
      /*
       * Somebody already refreshed while this call was in flight, so hand back what
       * they got rather than rotating again.
       *
       * Best-effort, and worth saying so: an access token is a JWT with a
       * whole-second `iat`/`exp`, so two refreshes inside the same second produce the
       * *same string* and this comparison cannot see the difference. What actually
       * keeps a screen's parallel fetches from walking the refresh chain once each —
       * and eventually losing the race that revokes the family (`access.md` §9) — is
       * `refreshOnce` below, which dedupes on the refresh token, and that one is 48
       * random bytes and never repeats.
       */
      if (saved.accessToken !== rejected) return saved.accessToken;
      try {
        const next = fromAuthResponse(await refreshOnce(saved.refreshToken));
        persist(next);
        setSession(next);
        return next.accessToken;
      } catch {
        /*
         * The refresh token is dead too, so the session really has ended — revoked
         * from another device, or reuse-detected. Clearing it is what sends the
         * visitor to sign in; leaving it would retry against a string that will
         * never work again. `companyId` is left alone deliberately: it is the last
         * company they were in, and it should still be selected when they return.
         */
        persist(null);
        setSession(null);
        return null;
      }
    });
  }, []);

  // Restore + refresh on mount.
  useEffect(() => {
    const saved = stored();
    const savedCompany =
      typeof window !== 'undefined' ? localStorage.getItem(COMPANY_KEY) : null;
    if (!saved) {
      setReady(true);
      return;
    }
    refreshOnce(saved.refreshToken)
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

  /**
   * Adopt a completed sign-in. Shared by the one-step and two-step paths so the
   * session is established identically either way — a second copy of this is how a
   * two-step login ends up subtly different from a one-step one.
   */
  const adopt = useCallback(
    (res: AuthResponse) => {
      const next = fromAuthResponse(res);
      setSession(next);
      persist(next);
      setCompanyId(next.memberships[0]?.companyId ?? '');
      return next.user;
    },
    [setCompanyId]
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.login({ email, password });
      // Nothing is stored for a challenge: no session, no token, nothing to clean up
      // if the person closes the tab. The challenge string lives in the login
      // screen's own state for the seconds it is needed.
      if ('status' in res && res.status === 'mfa_required') return res;
      return adopt(res as AuthResponse);
    },
    [adopt]
  );

  const completeMfa = useCallback(
    async (input: { challengeToken: string; code?: string; recoveryCode?: string }) =>
      adopt(await api.completeMfa(input)),
    [adopt]
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
      completeMfa,
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
    completeMfa,
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
