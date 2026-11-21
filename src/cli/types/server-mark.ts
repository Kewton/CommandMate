/**
 * The launch mark a CommandMate server carries (Issue #4433).
 *
 * The built-in `env-clean` gate must tell another worktree's server from the
 * worker's own. Guessing from the listening process's directory or ancestors
 * failed both ways (Sprint 7: the detached daemon runs in the package root, a
 * sibling of every worktree). So the launcher — today only `commandmate start
 * --daemon` (src/cli/utils/daemon.ts) — leaves evidence:
 *
 *   - the server's environment gets `CM_SERVER_MARK=<absolute record path>`;
 *   - the record names the process group the launch created (`pgid`), the
 *     start time of that group's leader, and where the launch came from (the
 *     launcher's cwd, its git root, its tmux session).
 *
 * The shape also admits `launcher: 'run-server'` with a `repoRoot` (the judge's
 * UAT server, scripts/uat/run-server.sh). Nothing writes it today: that
 * launcher is left unmarked until its run ownership is designed (Sprint 10), so
 * its server is judged like any unmarked one. Accepting the value changes no
 * verdict — a record is still verified only by its group and leader.
 *
 * The verifier (src/lib/verification/env-snapshot.ts) accepts a mark only when
 * the listener is in the recorded group and that group's leader is the recorded
 * process. A copied or inherited mark therefore points at somebody else's group
 * and fails. Both sides share this module so the shape cannot drift; it has no
 * imports so the CLI build and the server build can both use it.
 *
 * @module cli/types/server-mark
 */

/** The environment variable a marked server carries. */
export const SERVER_MARK_ENV = 'CM_SERVER_MARK';

/** Moves the record directory's base; for tests only. Production uses {@link SERVER_MARK_DEFAULT_BASE}. */
export const SERVER_MARK_BASE_ENV = 'CM_SERVER_MARK_BASE';

/**
 * Fixed, not `os.tmpdir()`: a launcher that starts its server under `env -i`
 * (run-server.sh, once it writes marks) must agree with the daemon about where
 * records live.
 */
export const SERVER_MARK_DEFAULT_BASE = '/tmp';

/** The record directory is `<base>/commandmate-server-marks-<uid>`, mode 0700. */
export const SERVER_MARK_DIR_PREFIX = 'commandmate-server-marks-';

/** A record larger than this is not read. */
export const SERVER_MARK_MAX_BYTES = 4096;

export const SERVER_MARK_VERSION = 1;

/** `session` when the launcher was not inside tmux. */
export const SERVER_MARK_SESSION_NO_TMUX = 'no-tmux';

/** `session` when the launcher was inside tmux but its session could not be read. */
export const SERVER_MARK_SESSION_LOOKUP_FAILED = 'lookup-failed';

/**
 * Environment for every `ps -o lstart=` on either side: the value is compared
 * as text, so locale and time zone must not differ between writer and reader.
 */
export const SERVER_MARK_LSTART_ENV: Readonly<Record<string, string>> = { LC_ALL: 'C', TZ: 'UTC0' };

export type ServerMarkLauncher = 'daemon' | 'run-server';

export interface ServerMarkRecord {
  v: 1;
  launcher: ServerMarkLauncher;
  /** The process group the launch created; its leader's pid. */
  pgid: number;
  /** `LC_ALL=C TZ=UTC0 ps -o lstart= -p <pgid>`, whitespace collapsed. */
  leaderStartTime: string;
  /** realpath of the launcher's own cwd. */
  launcherCwd: string;
  /** realpath of `git rev-parse --show-toplevel` in the launcher's cwd; null outside git. */
  worktreeRoot: string | null;
  /** run-server.sh's checkout (realpath); null for the daemon (the only writer today). */
  repoRoot: string | null;
  /** The launcher's tmux session name, {@link SERVER_MARK_SESSION_NO_TMUX} or {@link SERVER_MARK_SESSION_LOOKUP_FAILED}. */
  session: string;
  /** ISO time the record was written. */
  launchedAt: string;
}

/** `<prefix><uid>`. */
export function serverMarkDirName(uid: number): string {
  return `${SERVER_MARK_DIR_PREFIX}${uid}`;
}

/** `ps` pads the day of month (`Nov  6`); compare with runs of whitespace collapsed. */
export function normalizeLstart(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

const isAbsolutePath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && !/[\0\n\r]/.test(value);

/**
 * Parse a record. Anything that is not exactly a v1 record — wrong types, a
 * relative path, an empty start time, a non-positive group — is null, which
 * the verifier reads as an invalid mark.
 */
export function parseServerMarkRecord(text: string): ServerMarkRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.v !== SERVER_MARK_VERSION) return null;
  if (r.launcher !== 'daemon' && r.launcher !== 'run-server') return null;
  if (typeof r.pgid !== 'number' || !Number.isInteger(r.pgid) || r.pgid <= 1) return null;
  if (typeof r.leaderStartTime !== 'string' || normalizeLstart(r.leaderStartTime) === '') return null;
  if (!isAbsolutePath(r.launcherCwd)) return null;
  if (r.worktreeRoot !== null && !isAbsolutePath(r.worktreeRoot)) return null;
  if (r.repoRoot !== null && !isAbsolutePath(r.repoRoot)) return null;
  if (typeof r.session !== 'string' || r.session === '' || /\s/.test(r.session)) return null;
  if (typeof r.launchedAt !== 'string') return null;
  return {
    v: SERVER_MARK_VERSION,
    launcher: r.launcher,
    pgid: r.pgid,
    leaderStartTime: normalizeLstart(r.leaderStartTime),
    launcherCwd: r.launcherCwd,
    worktreeRoot: r.worktreeRoot as string | null,
    repoRoot: r.repoRoot as string | null,
    session: r.session,
    launchedAt: r.launchedAt,
  };
}
