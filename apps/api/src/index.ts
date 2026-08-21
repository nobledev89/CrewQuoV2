import { buildApp } from './app';
import { env } from './env';
import { initErrorTracking } from './observability/errorTracking';

// Before the app is built, so a failure while wiring routes is itself reportable.
initErrorTracking();

const app = buildApp();

app.listen(env.PORT, () => {
  console.log(`[api] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});
