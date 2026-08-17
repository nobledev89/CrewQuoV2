import type { ReactNode } from 'react';
import { AuthProvider } from '@/auth/AuthProvider';

/**
 * One provider for the whole authenticated app.
 *
 * Phases 1-2 gave each section its own `AuthProvider` layout, which meant moving
 * from `/rates/cards` to `/settings` unmounted the provider, dropped the in-memory
 * session and re-ran the refresh-on-mount effect — a token round trip and a
 * "Loading workspace..." flash on every section change. A route group shares one
 * instance across every route inside it, and the URLs are unchanged: a directory in
 * parentheses is a grouping only.
 */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
