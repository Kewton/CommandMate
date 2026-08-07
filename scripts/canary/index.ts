/**
 * Entry point for `npm run canary` (Issue #1727).
 *
 * The detection modules log through `@/lib/logger`, which would interleave INFO
 * lines with the canary's own report, so the log level is pinned before the
 * runner (and therefore the detection modules) is imported. The import is
 * dynamic for exactly that reason — a static import would be hoisted above this
 * assignment.
 */

process.env.CM_LOG_LEVEL = process.env.CM_LOG_LEVEL ?? 'error';

void import('./runner')
  .then(module => module.main())
  .then(exitCode => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 2;
  });
