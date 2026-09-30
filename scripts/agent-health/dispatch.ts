/**
 * `npx tsx scripts/agent-health/dispatch.ts [--state-dir …] [--dry-run]`
 *
 * Hands today's agent-health / metrics Issues to `/orchestrate` on develop's
 * Claude 3 (Issue #3045). See docs/user-guide/agent-health.md「自動依頼」.
 */

process.env.CM_LOG_LEVEL = process.env.CM_LOG_LEVEL ?? 'error';

void import('./dispatch-main')
  .then((module) => module.main(process.argv.slice(2)))
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `[agent-health-dispatch] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(2);
  });
