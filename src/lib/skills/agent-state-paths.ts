/**
 * State files an agent CLI writes into the worktree on its own (Issue #3126)
 *
 * Command Code leaves `.commandcode/settings.local.json` and
 * `.commandcode/taste/**` behind in any folder it runs in. Counted as change,
 * they made a contract's `requireScopeClean` fail on a worktree whose worker
 * stayed inside `allow`, and made `work-evidence` pass on one nobody worked in.
 *
 * Unlike receipt-owned paths (#3092) there is no receipt to vouch for them, so
 * the declaration below is the whole rule, and it names files, never a whole
 * directory: `.commandcode/` also holds things a task may legitimately change,
 * and allowing it wholesale would wave those through. Callers apply this to
 * **untracked** entries only, as for #3092: a committed or tracked-and-modified
 * file is history the branch carries.
 *
 * Only paths whose existence is confirmed are declared. Other agents (claude,
 * codex, ...) are deliberately absent until someone has seen them write one.
 *
 * @module lib/skills/agent-state-paths
 */

/** Exact repository-relative files an agent CLI manages itself. */
export const AGENT_STATE_FILES: readonly string[] = ['.commandcode/settings.local.json'];

/** Directory prefixes (with trailing slash) an agent CLI manages itself. */
export const AGENT_STATE_DIR_PREFIXES: readonly string[] = ['.commandcode/taste/'];

/** Whether `path` is a declared agent-managed state path. */
export function isAgentStatePath(path: string): boolean {
  if (AGENT_STATE_FILES.includes(path)) return true;
  return AGENT_STATE_DIR_PREFIXES.some(
    (prefix) => path.startsWith(prefix) && !path.slice(prefix.length).split('/').includes('..')
  );
}

/** Whether a porcelain record is an untracked file made only of such paths. */
export function isAgentStateUntrackedEntry(entry: { status: string; paths: string[] }): boolean {
  return entry.status === '??' && entry.paths.every(isAgentStatePath);
}
