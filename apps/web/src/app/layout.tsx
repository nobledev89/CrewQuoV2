import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@crewquo/ui/styles.css';
import { AuthProvider } from '@/auth/AuthProvider';

export const metadata: Metadata = {
  title: 'CrewQuo',
  description: 'Contractor operations, rate management and financial controls.',
};

export const viewport: Viewport = {
  themeColor: '#f6f7f9',
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
