/**
 * `npx tsx scripts/agent-health/release-report.ts [--date YYYY-MM-DD] [--out …] [--findings …]`
 *
 * Writes the release GO / 要判断 / NO-GO report for a JST day as one HTML
 * file (Issue #3046). See docs/user-guide/agent-health.md「リリース判断レポート」.
 */

process.env.CM_LOG_LEVEL = process.env.CM_LOG_LEVEL ?? 'error';

void import('./release-report-main')
  .then((module) => module.main(process.argv.slice(2)))
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `[release-report] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(2);
  });
