/**
 * Issue #4466 PR0: the names of the table's world — one worktree, its roster and the
 * values the rows send. The database itself is built by the test file (it owns the mocks);
 * {@link FIXTURE_ROSTER} is what it writes.
 */

import { execFileSync } from 'child_process';
import type Database from 'better-sqlite3';

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

/** Where git is (`/usr/bin` holds no agy, no claude, no codex: checked when this was written). */
export const GIT_PATH = '/usr/bin:/bin';

/**
 * A git repository at `dir` on `main` with one empty commit, so mem resolves its branch
 * (r1, review P2-3). git runs with no global or system config and `HOME` = `dir`.
 */
export function gitInit(dir: string): void {
  const env = { ...process.env, PATH: GIT_PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: dir,
    env,
    stdio: 'ignore',
  });
}

/**
 * What a roster write touches beside the roster (r1, codex P2-3): a `now` slot of mem
 * (`session_notes`) for three instances, and an idempotency key of `POST /instances/roles`.
 * Present before every row, so a refusal that drops or rewrites them shows in the diff.
 */
export function seedRosterNeighbours(db: Database.Database): void {
  const insertNote = db.prepare('INSERT INTO session_notes (worktree_id, instance_id, note, updated_at, version) VALUES (?, ?, ?, ?, ?)');
  for (const instanceId of [FIXTURE.instanceOf.codex, FIXTURE.instanceOf.antigravity, FIXTURE.replyTo]) {
    insertNote.run(FIXTURE.worktreeId, instanceId, `now of ${instanceId}`, 1_700_000_000_000, 1);
  }
  db.prepare(
    'INSERT INTO agent_instance_creation_keys (worktree_id, idempotency_key, instance_id, request_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(FIXTURE.worktreeId, 'seed-key-4466-0000', FIXTURE.replyTo, 'seed-fingerprint', Date.now());
}
