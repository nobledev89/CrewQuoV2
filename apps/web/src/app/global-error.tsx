'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/** The final boundary, including failures that replace the root layout itself. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div className="cq-auth">
          <header className="cq-auth__bar">
            <span className="cq-brand" translate="no">
              <span className="cq-brand__mark" aria-hidden="true">CQ</span>
              <span className="cq-brand__name">CrewQuo</span>
            </span>
          </header>
          <main className="cq-auth__main">
            <div className="cq-auth__panel" role="alert">
              <div className="cq-auth__heading">
                <p className="cq-overline">Unexpected error</p>
                <h1 className="cq-h1">This page could not finish loading</h1>
                <p className="cq-page-header__description">
                  Try the page again. If it still fails, contact support and include the time it happened.
                </p>
              </div>
              <button className="cq-btn" type="button" onClick={reset}>Try again</button>
            </div>
          </main>
          <footer className="cq-auth__footer">Secure access to your CrewQuo workspace</footer>
        </div>
      </body>
    </html>
  );
}

