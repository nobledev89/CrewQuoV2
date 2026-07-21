import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@crewquo/ui/styles.css';
import { AuthProvider } from '@/auth/AuthProvider';

export const metadata: Metadata = {
  title: 'CrewQuo Console',
  description: 'Manage roles, rate cards and rate resolution.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
