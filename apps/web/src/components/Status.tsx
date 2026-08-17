'use client';

import { Badge } from '@crewquo/ui';
import type { EngagementStatus, ProjectStatus, WorkStatus } from '@crewquo/shared';
import { titleCase } from '@/lib/format';

/**
 * Status chips for the four state machines the console shows. Tone is deliberate:
 * REJECTED and PAUSED are warnings, not errors — they are ordinary, recoverable
 * states in the workflow, and colouring them like failures teaches people to fear
 * a normal step.
 */

export function WorkStatusBadge({ status }: { status: WorkStatus }) {
  const tone =
    status === 'APPROVED'
      ? 'success'
      : status === 'SUBMITTED'
        ? 'accent'
        : status === 'REJECTED'
          ? 'warning'
          : 'neutral';
  return <Badge tone={tone}>{titleCase(status)}</Badge>;
}

export function EngagementStatusBadge({ status }: { status: EngagementStatus }) {
  const tone =
    status === 'ACTIVE'
      ? 'success'
      : status === 'PENDING'
        ? 'accent'
        : status === 'PAUSED'
          ? 'warning'
          : 'neutral';
  return <Badge tone={tone}>{titleCase(status)}</Badge>;
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const tone =
    status === 'ACTIVE'
      ? 'success'
      : status === 'PLANNED'
        ? 'accent'
        : status === 'COMPLETED'
          ? 'neutral'
          : 'neutral';
  return <Badge tone={tone}>{titleCase(status)}</Badge>;
}

/** `client` / `provider` — which end of an engagement the active company is on. */
export function SideBadge({ side }: { side: 'client' | 'provider' }) {
  return (
    <Badge tone={side === 'client' ? 'accent' : 'neutral'}>
      {side === 'client' ? 'You hire' : 'You deliver'}
    </Badge>
  );
}
