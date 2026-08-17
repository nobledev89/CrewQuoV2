import type { ReactNode } from 'react';
import { AuthProvider } from '@/auth/AuthProvider';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
