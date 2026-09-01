import * as Sentry from '@sentry/nextjs';
import { createWebSentryOptions } from './observability/sentryOptions';

/** Initialise the runtime before Next handles its first server or edge request. */
export function register(): void {
  const runtime = process.env.NEXT_RUNTIME === 'edge' ? 'edge' : 'node';
  const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
  Sentry.init(
    createWebSentryOptions({
      dsn,
      environment: process.env.NODE_ENV ?? 'development',
      release: process.env.SENTRY_RELEASE ?? process.env.NEXT_PUBLIC_SENTRY_RELEASE,
      runtime,
      tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE,
    })
  );
}

/** Nested React Server Component failures do not reach a page error boundary. */
export const onRequestError = Sentry.captureRequestError;

