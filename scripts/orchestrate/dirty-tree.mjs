/** Files the orchestrator leaves in a worktree that are not the worker's work. */
export const IGNORED_DIRTY = ['.commandmate/tasks/', 'dev-reports/'];

/**
 * State an agent CLI writes into the worktree on its own (#3126, #4406): Command Code's
 * `.commandcode/settings.local.json` (CommandMate writes it at every Command Code start) and
 * `.commandcode/taste/`. A copy of `AGENT_STATE_FILES` / `AGENT_STATE_DIR_PREFIXES` in
 * src/lib/skills/agent-state-paths.ts — the roster the product's scope and work-evidence gates
 * use — since a `.mjs` script cannot import it; a unit test keeps the two equal.
 *
 * Matched here, case-sensitively, rather than through `.gitignore`: git's `core.ignorecase`
 * (on by default on macOS) would also hide `.COMMANDCODE/Settings.local.json`, which the roster
 * does not excuse. Untracked entries only: a tracked file that changed is history the branch
 * carries. The rest of `.commandcode/` (skills/, commands/, a directory named
 * settings.local.json) is still the worker's.
 */
export const AGENT_STATE_FILES = ['.commandcode/settings.local.json'];
export const AGENT_STATE_DIR_PREFIXES = ['.commandcode/taste/'];

/** Whether `file` is a declared agent state path (exact file, or inside a declared directory). */
export function isAgentStatePath(file) {
  if (AGENT_STATE_FILES.includes(file)) return true;
  return AGENT_STATE_DIR_PREFIXES.some((prefix) => file.startsWith(prefix) && !file.slice(prefix.length).split('/').includes('..'));
}

/**
 * An untracked directory git reported collapsed (`?? .commandcode/`) that holds a declared path.
 * Only such a directory is listed file by file; every other entry is read exactly as before.
 */
function holdsAgentState(entry) {
  return entry.endsWith('/') && [...AGENT_STATE_FILES, ...AGENT_STATE_DIR_PREFIXES].some((p) => p.startsWith(entry) && p !== entry);
}

/** `XY path` records of `git status --porcelain [args]`, with the status kept. */
function statusRecords(run, worktree, extra = []) {
  const args = ['status', '--porcelain', ...extra];
  const { status, stdout, stderr } = run('git', ['-C', worktree, ...args]);
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed in ${worktree}: ${stderr.trim()}`);
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const code = /^\S+/.exec(line)[0];
      return { code, file: line.replace(/^\S+\s+/, '') };
    });
}

/** Changed paths other than the contract, dev-reports and declared agent state (`git status --porcelain`). */
export function dirtyPaths(run, worktree) {
  const records = statusRecords(run, worktree).flatMap((record) =>
    record.code === '??' && holdsAgentState(record.file) ? statusRecords(run, worktree, ['-uall', '--', record.file]) : [record],
  );
  return records
    .filter((record) => !(record.code === '??' && isAgentStatePath(record.file)))
    .map((record) => record.file)
    .filter((file) => !IGNORED_DIRTY.some((prefix) => file.startsWith(prefix)));
}
