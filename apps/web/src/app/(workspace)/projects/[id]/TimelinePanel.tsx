'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  TIMELINE_SOURCES,
  type TimelineEventType,
  type TimelineItem,
  type TimelineResponse,
} from '@crewquo/shared';
import { Badge, Button, EmptyState, ErrorText, Notice, Row, Section, Select, Stack } from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { formatDateTime } from '@/lib/format';

/**
 * The project timeline (§35) — step 11.8's screen.
 *
 * §35's test of whether this works is a sentence rather than a metric: *"Someone
 * who was not on site should be able to read the timeline and understand what
 * happened."* So it renders as a chronology of one-line descriptions with links,
 * and deliberately carries **no figures at all** — the money lives on the record a
 * reader follows the link to, where the §4 authorization matrix already governs it.
 *
 * Two things it does that a plain list would not:
 *
 *  - **It says why a filter is empty.** `sources` comes back with each class marked
 *    `OK`, `NO_FEATURE`, `NO_TABLE` or `FILTERED_OUT`, and a reader who filters to
 *    Incidents is told there is no such record in CrewQuo rather than being shown a
 *    blank panel. §35 lists incidents and the plan declares no table for them
 *    anywhere; saying so is the honest answer.
 *  - **It pages forward with the server's cursor** rather than re-fetching a
 *    growing limit, because a chronology over ten tables has no index that spans
 *    them and the bound is what keeps it cheap.
 */

const REASON_COPY: Readonly<Record<string, string>> = {
  NO_FEATURE: 'not on this project’s plan',
  NO_TABLE: 'CrewQuo does not record this',
  NOT_FOR_THIS_AUDIENCE: 'not shown to this reader',
  FILTERED_OUT: 'filtered out',
};

const TYPE_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  TIMELINE_SOURCES.map((s) => [s.type, s.label])
);

export function TimelinePanel({ projectId }: { projectId: string }) {
  const ctx = useSessionCtx();
  const [type, setType] = useState<TimelineEventType | ''>('');
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [sources, setSources] = useState<TimelineResponse['sources']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const load = async (nextType: TimelineEventType | '', append: string | null) => {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.projectTimeline(ctx.accessToken, ctx.companyId, projectId, {
        types: nextType === '' ? undefined : [nextType],
        cursor: append ?? undefined,
        limit: 40,
      });
      setItems((prev) => (append === null ? result.items : [...(prev ?? []), ...result.items]));
      setSources(result.sources);
      setCursor(result.nextCursor);
      setLoadedFor(`${projectId}:${nextType}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the timeline');
    } finally {
      setBusy(false);
    }
  };

  // Loaded on first render and whenever the filter changes, keyed so a project
  // switch re-fetches rather than showing the previous project's story.
  if (loadedFor !== `${projectId}:${type}` && !busy && error === null) {
    void load(type, null);
  }

  const unavailable = sources.filter((s) => !s.included && s.reason !== 'FILTERED_OUT');

  return (
    <Section
      title="Timeline"
      description="Everything that happened on this project, in order, assembled from the records themselves. Nothing here is written separately."
      actions={
        <Select
          value={type}
          aria-label="Filter the timeline by kind of event"
          onChange={(e) => {
            const next = e.target.value as TimelineEventType | '';
            setType(next);
            setItems(null);
            setCursor(null);
            void load(next, null);
          }}
        >
          <option value="">Everything</option>
          {TIMELINE_SOURCES.filter((s) => s.sourceTable !== null).map((source) => (
            <option key={source.type} value={source.type}>
              {source.label}
            </option>
          ))}
        </Select>
      }
    >
      <Stack>
        <ErrorText>{error}</ErrorText>

        {items === null ? (
          <p className="cq-muted">Loading the timeline…</p>
        ) : items.length === 0 ? (
          <EmptyState title="Nothing recorded yet">
            {type === ''
              ? 'As work, photographs, diary entries and variations are recorded, they appear here in order.'
              : `Nothing of that kind has been recorded on this project.`}
          </EmptyState>
        ) : (
          <ol className="cq-timeline">
            {items.map((item) => (
              <li key={item.id} className="cq-timeline__item">
                <Row between>
                  <div>
                    <Badge tone="neutral">{TYPE_LABEL[item.type] ?? item.type}</Badge>{' '}
                    {item.href ? <Link href={item.href}>{item.description}</Link> : item.description}
                  </div>
                  <span className="cq-muted">{formatDateTime(item.at)}</span>
                </Row>
                <p className="cq-muted">
                  {item.actorName ?? 'Somebody'}
                  {item.companyName ? ` · ${item.companyName}` : ''}
                </p>
              </li>
            ))}
          </ol>
        )}

        {cursor !== null ? (
          <Row>
            <Button variant="secondary" disabled={busy} onClick={() => void load(type, cursor)}>
              {busy ? 'Loading…' : 'Show more'}
            </Button>
          </Row>
        ) : null}

        {/*
          * Why a class is missing, rather than a silently shorter list. §35 names
          * incidents and the plan declares no table for them anywhere, so a reader
          * who goes looking is told that rather than shown a blank panel.
          */}
        {unavailable.length > 0 ? (
          <Notice>
            Not shown:{' '}
            {unavailable
              .map(
                (s) =>
                  `${TYPE_LABEL[s.type] ?? s.type} (${REASON_COPY[s.reason] ?? s.reason.toLowerCase()})`
              )
              .join(' · ')}
          </Notice>
        ) : null}
      </Stack>
    </Section>
  );
}
