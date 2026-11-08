/**
 * `npx tsx scripts/agent-health/claude3-reserve.ts <reserve|send|renew|release|takeover|status> …`
 *
 * The reservation of develop's Claude 3, shared by PM's briefs and the daily
 * dispatch (Issue #4243). See docs/orchestrate/team.md §4.
 */

process.env.CM_LOG_LEVEL = process.env.CM_LOG_LEVEL ?? 'error';

void import('./claude3-reserve-main')
  .then((module) => module.main(process.argv.slice(2)))
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error: unknown) => {
    process.stderr.write(`[claude3-reserve] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(2);
  });
