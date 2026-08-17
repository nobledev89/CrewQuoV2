import type { ReactNode } from 'react';
import { AuthProvider } from '@/auth/AuthProvider';

/**
 * Sign-in, registration, password recovery, email verification and invite accept.
 *
 * These pages need the session provider — they create a session, and the invite
 * page reads one — but unlike the workspace they must never *require* one, so none
 * of them renders inside `Shell`.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
