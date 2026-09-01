import { scrubEvent, type RawEvent } from '@crewquo/shared';

type NamedIntegration = { name: string };

export type WebTrackingRuntime = 'browser' | 'node' | 'edge';

export type WebTrackingConfig = {
  dsn?: string;
  environment: string;
  release?: string;
  runtime: WebTrackingRuntime;
  tracesSampleRate?: string;
};

/** A configured sample rate is a fraction; an invalid value fails closed to off. */
export function parseTraceSampleRate(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
}

/** Privacy boundary shared by browser, Next server and edge events. */
export function createWebSentryOptions(config: WebTrackingConfig) {
  return {
    dsn: config.dsn,
    enabled: Boolean(config.dsn),
    environment: config.environment,
    release: config.release,
    tracesSampleRate: parseTraceSampleRate(config.tracesSampleRate),
    sendDefaultPii: false,
    enableLogs: false,
    // Breadcrumbs are typically URLs, clicks, console text and fetch metadata.
    // The allowlist drops them; zero prevents collecting them first.
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    integrations: <T extends NamedIntegration>(defaults: T[]): T[] =>
      defaults.filter(
        (integration) =>
          integration.name !== 'Breadcrumbs' &&
          integration.name !== 'LocalVariables' &&
          integration.name !== 'RequestData'
      ),
    beforeSend: (event: unknown) => scrubEvent(event as RawEvent) as never,
    beforeSendTransaction: (event: unknown) => scrubEvent(event as RawEvent) as never,
  };
}
