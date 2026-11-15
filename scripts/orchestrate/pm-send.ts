/**
 * `npx tsx scripts/orchestrate/pm-send.ts <worktree-id> --instance <id> --note "<待つもの>" [--token <t>] "<本文>"`
 *
 * PM's one way to send: always with a relay back (Issue #4418). See
 * docs/orchestrate/team.md §3 and docs/design/pm-send-relay-4418.md.
 */

process.env.CM_LOG_LEVEL = process.env.CM_LOG_LEVEL ?? 'error';

void import('./pm-send-main')
  .then((module) => module.main(process.argv.slice(2)))
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error: unknown) => {
    process.stderr.write(`[pm-send] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(2);
  });
