import * as Sentry from '@sentry/nextjs';
import { createWebSentryOptions } from './observability/sentryOptions';

Sentry.init({
  ...createWebSentryOptions({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    runtime: 'browser',
    tracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  }),
  // Session Replay is outside the adopted data contract. State both rates so
  // adding its integration later cannot silently start recording on error.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

