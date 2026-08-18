'use client';

import type { ReactNode } from 'react';
import { EmptyState, PageHeader, Stack } from '@crewquo/ui';
import { useAuth } from '@/auth/AuthProvider';

export function AdminGate({ children, title }: { children: ReactNode; title: string }) {
  const { session } = useAuth();
  if (session?.user.isSuperAdmin) return children;
  return (
    <Stack>
      <PageHeader eyebrow="CrewQuo Platform" title={title} />
      <EmptyState title="Super Admin only">
        This platform workspace is available only to active CrewQuo super administrators.
      </EmptyState>
    </Stack>
  );
}

