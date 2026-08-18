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
import { usePathname, useRouter } from 'next/navigation';
import {
  resolveSelectedWorkspaceView,
  type CompanyWorkspace,
  type WorkspaceView,
} from '@crewquo/shared';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';

const VIEW_STORAGE_KEY = 'crewquo.workspaceViews';

export const WORKSPACE_VIEW_LABELS: Record<WorkspaceView, string> = {
  OPERATIONS: 'Contractor',
  SUBCONTRACTOR: 'Subcontractor',
  CLIENT: 'Client',
};

export function landingForWorkspaceView(view: WorkspaceView | null): string {
  if (view === 'SUBCONTRACTOR') return '/work';
  if (view === 'CLIENT') return '/portal';
  if (view === 'OPERATIONS') return '/app';
  return '/profile';
}

/** Customer lenses allowed to render a route; null means a shared account utility. */
export function allowedViewsForPath(pathname: string): WorkspaceView[] | null {
  if (pathname === '/work' || pathname.startsWith('/work/')) return ['SUBCONTRACTOR'];
  if (pathname === '/portal' || pathname.startsWith('/portal/')) return ['CLIENT'];
  if (pathname === '/commercial' || pathname.startsWith('/commercial/')) {
    return ['OPERATIONS', 'SUBCONTRACTOR'];
  }
  if (pathname === '/network/engagements' || pathname.startsWith('/network/engagements/')) {
    return ['OPERATIONS', 'SUBCONTRACTOR'];
  }
  if (pathname === '/invoices' || pathname.startsWith('/invoices/')) {
    return ['OPERATIONS', 'CLIENT'];
  }
  if (
    pathname === '/projects' ||
    pathname.startsWith('/projects/') ||
    pathname === '/review' ||
    pathname.startsWith('/review/') ||
    pathname === '/audit' ||
    pathname.startsWith('/audit/') ||
    pathname === '/network/providers' ||
    pathname.startsWith('/network/providers/') ||
    pathname === '/network/clients' ||
    pathname.startsWith('/network/clients/') ||
    pathname === '/rates' ||
    pathname.startsWith('/rates/')
  ) {
    return ['OPERATIONS'];
  }
  return null;
}

interface WorkspaceState {
  workspaces: CompanyWorkspace[];
  activeWorkspace: CompanyWorkspace | null;
  selectedView: WorkspaceView | null;
  loading: boolean;
  error: string | null;
  selectWorkspace: (companyId: string, view: WorkspaceView | null) => void;
  selectCompany: (companyId: string) => void;
  reload: () => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

function readStoredViews(): Record<string, WorkspaceView> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) ?? '{}') as Record<
      string,
      WorkspaceView
    >;
  } catch {
    return {};
  }
}

function rememberView(companyId: string, view: WorkspaceView | null) {
  if (typeof window === 'undefined') return;
  const stored = readStoredViews();
  if (view) stored[companyId] = view;
  else delete stored[companyId];
  localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(stored));
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { session, companyId, setCompanyId } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [workspaces, setWorkspaces] = useState<CompanyWorkspace[]>([]);
  const [selectedView, setSelectedView] = useState<WorkspaceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const membershipKey = session?.memberships.map((m) => m.companyId).join('|') ?? '';

  useEffect(() => {
    if (!session || session.memberships.length === 0) {
      setWorkspaces([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .workspaces(session.accessToken)
      .then((result) => {
        if (!cancelled) setWorkspaces(result.workspaces);
      })
      .catch((err) => {
        if (!cancelled) {
          setWorkspaces([]);
          setError(err instanceof ApiError ? err.message : 'Could not load workspace views');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.accessToken, membershipKey, nonce]);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.companyId === companyId) ?? null,
    [workspaces, companyId]
  );

  useEffect(() => {
    if (!companyId || !activeWorkspace) {
      setSelectedView(null);
      return;
    }
    const allowedForRoute = allowedViewsForPath(pathname);
    const stored = readStoredViews()[companyId];
    const hasEligibleRouteView =
      !allowedForRoute || activeWorkspace.views.some((view) => allowedForRoute.includes(view));
    const next = resolveSelectedWorkspaceView(
      activeWorkspace.views,
      allowedForRoute,
      selectedView,
      stored ?? null
    );
    setSelectedView(next);
    rememberView(companyId, next);

    // A URL is not a fourth way into a workspace. If the requested screen belongs
    // to a view this company does not have, return to its valid landing page. This
    // is a navigation boundary only; the API remains the authorization boundary.
    if (allowedForRoute && !hasEligibleRouteView) {
      router.replace(landingForWorkspaceView(next));
    }
  }, [activeWorkspace, companyId, pathname, router, selectedView]);

  const selectWorkspace = useCallback(
    (nextCompanyId: string, view: WorkspaceView | null) => {
      rememberView(nextCompanyId, view);
      setSelectedView(view);
      if (nextCompanyId !== companyId) setCompanyId(nextCompanyId);
      router.push(landingForWorkspaceView(view));
    },
    [companyId, router, setCompanyId]
  );

  const selectCompany = useCallback(
    (nextCompanyId: string) => {
      const nextWorkspace = workspaces.find((entry) => entry.companyId === nextCompanyId);
      if (!nextWorkspace) return;
      const stored = readStoredViews()[nextCompanyId] ?? null;
      const nextView = resolveSelectedWorkspaceView(nextWorkspace.views, null, null, stored);
      selectWorkspace(nextCompanyId, nextView);
    },
    [selectWorkspace, workspaces]
  );

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  const value = useMemo<WorkspaceState>(
    () => ({
      workspaces,
      activeWorkspace,
      selectedView,
      loading,
      error,
      selectWorkspace,
      selectCompany,
      reload,
    }),
    [workspaces, activeWorkspace, selectedView, loading, error, selectWorkspace, selectCompany, reload]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return value;
}
