/**
 * Issue #4466 PR0: the names of the table's world — one worktree, its roster and the
 * values the rows send. The database itself is built by the test file (it owns the mocks);
 * {@link FIXTURE_ROSTER} is what it writes.
 */

export const FIXTURE = {
  worktreeId: 'wt-4466',
  /** A roster instance of each tool, the targets of the rows (`cx` is not the primary). */
  instanceOf: { codex: 'cx', antigravity: 'agy', claude: 'cl' },
  /** The reply-to ends: a claude session, and an antigravity one (rule 0). */
  replyTo: 'review',
  replyToAntigravity: 'review-agy',
  /** An id on no roster (the `--register` and ad-hoc rows). */
  adHoc: 'adhoc-new',
  roleName: 'reviewer',
  contractPath: '.commandmate/tasks/x.yaml',
  contract: 'version: 1\ntitle: t\ngoal: |\n  Do the work.\nscope:\n  allow: ["src/**"]\n',
  message: 'hello',
  noteText: 'the review',
  antigravityModel: 'gemini-3-pro',
  claudeModel: 'sonnet',
} as const;

/** The roster every row starts from (the primary `codex` first). */
export const FIXTURE_ROSTER = [
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
  { id: 'cx', cliTool: 'codex', alias: 'Codex 2', order: 1 },
  { id: 'agy', cliTool: 'antigravity', alias: 'Agy', order: 2 },
  { id: 'cl', cliTool: 'claude', alias: 'Claude', order: 3 },
  { id: 'review', cliTool: 'claude', alias: 'Review', order: 4 },
  { id: 'review-agy', cliTool: 'antigravity', alias: 'Review Agy', order: 5 },
] as const;

/** Rows that fill the roster to its limit (`MAX_AGENT_INSTANCES`) for the roster-refusal rows. */
export function fillerRows(limit: number): Array<{ id: string; cliTool: string; alias: string; order: number }> {
  return Array.from({ length: Math.max(0, limit - FIXTURE_ROSTER.length) }, (_unused, index) => ({
    id: `filler-${index}`,
    cliTool: 'codex',
    alias: `Filler ${index}`,
    order: FIXTURE_ROSTER.length + index,
  }));
}
