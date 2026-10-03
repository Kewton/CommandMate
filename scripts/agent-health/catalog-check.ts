/**
 * `npx tsx scripts/agent-health/catalog-check.ts [--state-dir …] [--dry-run]`
 *
 * Checks the slash-command catalog against each CLI's source once a day and
 * keeps one `catalog-drift` Issue in step with it (Issue #3158). Read only:
 * no tracked file is written. See docs/user-guide/agent-health.md「カタログのずれ」.
 */

process.env.CM_LOG_LEVEL = process.env.CM_LOG_LEVEL ?? 'error';

void import('./catalog-check-main')
  .then((module) => module.main(process.argv.slice(2)))
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `[agent-health-catalog] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(2);
  });
