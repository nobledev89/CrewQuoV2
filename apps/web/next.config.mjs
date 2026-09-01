import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Shared workspace packages ship raw TS/TSX — let Next compile them.
  transpilePackages: ['@crewquo/shared', '@crewquo/ui'],
  // Required by Next 14; Next 15 makes the instrumentation hook stable.
  experimental: { instrumentationHook: true },
};

export default withSentryConfig(nextConfig, {
  telemetry: false,
  silent: true,
  // A local build has no upload credential and must make no Sentry network call.
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  webpack: { treeshake: { removeDebugLogging: true } },
});
