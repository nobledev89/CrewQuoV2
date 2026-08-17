import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@crewquo/ui/styles.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  title: {
    default: 'CrewQuo — Contractor operations, controlled',
    template: '%s · CrewQuo',
  },
  description: 'Run crews, subcontractors, projects, rates, field evidence, assets, sustainability and client reporting from one operational record.',
  openGraph: {
    title: 'CrewQuo — Run the job. Know the margin. Prove the outcome.',
    description: 'Commercial control, field operations, evidence and sustainability reporting in one contractor operations platform.',
    type: 'website',
    images: [{ url: '/og.png', width: 1733, height: 909, alt: 'CrewQuo — Run the job. Know the margin. Prove the outcome.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CrewQuo — Run the job. Know the margin. Prove the outcome.',
    description: 'Commercial control, field operations, evidence and sustainability reporting in one contractor operations platform.',
    images: ['/og.png'],
  },
};

export const viewport: Viewport = {
  themeColor: '#f6f7f9',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
