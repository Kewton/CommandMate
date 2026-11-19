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

/**
 * Records of `git status --porcelain -z [args]`: `{ code, file, original }`.
 *
 * `-z`, as the product gates read it (scope-gate.ts, gate-runner.ts work-evidence):
 * paths come verbatim, where the line format C-quotes a name with a space or a
 * non-ASCII character (core.quotePath) and the quoted `".commandcode/taste/…"`
 * would never match the roster (codex review 3, P2). Each record is `XY path`
 * followed by NUL; a rename or copy (`R`/`C` in either column) is followed by
 * its original path as the next NUL field.
 */
function statusRecords(run, worktree, extra = []) {
  const args = ['status', '--porcelain', '-z', ...extra];
  const { status, stdout, stderr } = run('git', ['-C', worktree, ...args]);
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed in ${worktree}: ${stderr.trim()}`);
  const fields = stdout.split('\0');
  const records = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) continue; // "XY " plus at least one path character
    const code = field.slice(0, 2);
    const record = { code, file: field.slice(3), original: null };
    if (/[RC]/.test(code)) {
      i += 1;
      record.original = fields[i] || null;
    }
    records.push(record);
  }
  return records;
}

/** What callers are shown: the path, or `old -> new` for a rename or copy as before. */
function shownPath(record) {
  return record.original ? `${record.original} -> ${record.file}` : record.file;
}

/** Changed paths other than the contract, dev-reports and declared agent state (`git status --porcelain -z`). */
export function dirtyPaths(run, worktree) {
  const records = statusRecords(run, worktree).flatMap((record) =>
    record.code === '??' && holdsAgentState(record.file) ? statusRecords(run, worktree, ['-uall', '--', record.file]) : [record],
  );
  return records
    .filter((record) => !(record.code === '??' && isAgentStatePath(record.file)))
    .map(shownPath)
    .filter((file) => !IGNORED_DIRTY.some((prefix) => file.startsWith(prefix)));
}
