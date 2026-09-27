/**
 * `npx tsx scripts/agent-health/run.ts [--tools …] [--only …] [--out …] [--timeout-per-tool …]`
 *
 * Daily, AI-free check that each agent CLI still works with CommandMate
 * (Issue #2878). See docs/user-guide/agent-health.md.
 *
 * The log level is fixed before anything from `src/` is imported (the same
 * reason as scripts/canary/index.ts): module-level loggers read it once.
 */

process.env.CM_LOG_LEVEL = process.env.CM_LOG_LEVEL ?? 'error';

void import('./main')
  .then((module) => module.main(process.argv.slice(2)))
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error: unknown) => {
    process.stderr.write(`[agent-health] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(2);
  });
