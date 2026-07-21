'use client';

import Link from 'next/link';
import { Badge, Card, Row, Stack } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { useAuth } from '@/auth/AuthProvider';

const CARDS = [
  { href: '/rates/roles', title: 'Roles', body: 'The named roles you staff — the key every rate card hangs off.' },
  { href: '/rates/cards', title: 'Rate cards', body: 'PAY (what you pay providers) and BILL (what you charge clients).' },
  { href: '/rates/templates', title: 'Templates', body: 'Holiday and timeframe definitions used when resolving rates.' },
  { href: '/rates/resolve', title: 'Resolve', body: 'Test which card wins for a role, date and shift type.' },
];

export default function OverviewPage() {
  return (
    <Shell>
      <Overview />
    </Shell>
  );
}

function Overview() {
  const { activeMembership } = useAuth();
  return (
    <Stack style={{ paddingTop: 24 }}>
      <Row between>
        <div>
          <h1 className="cq-h1">{activeMembership?.companyName ?? 'Overview'}</h1>
          <p className="cq-muted">Rate engine &amp; catalog</p>
        </div>
        {activeMembership ? <Badge accent>{activeMembership.role}</Badge> : null}
      </Row>

      <div
        style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        }}
      >
        {CARDS.map((c) => (
          <Link key={c.href} href={c.href} style={{ textDecoration: 'none', color: 'inherit' }}>
            <Card style={{ height: '100%' }}>
              <h2 className="cq-h2">{c.title}</h2>
              <p className="cq-muted" style={{ marginBottom: 0 }}>
                {c.body}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </Stack>
  );
}
