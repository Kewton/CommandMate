/** Files the orchestrator leaves in a worktree that are not the worker's work. */
export const IGNORED_DIRTY = ['.commandmate/tasks/', 'dev-reports/'];

/** Changed paths other than the contract and dev-reports (`git status --porcelain`). */
export function dirtyPaths(run, worktree) {
  const args = ['status', '--porcelain'];
  const { status, stdout, stderr } = run('git', ['-C', worktree, ...args]);
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed in ${worktree}: ${stderr.trim()}`);
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\S+\s+/, ''))
    .filter((file) => !IGNORED_DIRTY.some((prefix) => file.startsWith(prefix)));
}
