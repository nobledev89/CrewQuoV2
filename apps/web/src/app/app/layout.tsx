import type { ReactNode } from 'react';
import { AuthProvider } from '@/auth/AuthProvider';

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
