/**
 * Environment snapshots for the built-in `env-clean` gate (Issue #1740).
 *
 * `scope` judges what a delegation changed *inside* the repository. Nothing
 * judged what it changed *outside* one, so the failures of 2026-08-06 all passed
 * every gate: a worker's `pkill -f "node dist/server/server.js"` stopped the
 * user's production server (#1739), another left `~/.commandmate-uat-1726` in
 * `$HOME`, another left an isolated server listening on 3779, and a fourth wrote
 * into `~/.commandmate/hooks` (#1722). This module records the four observable
 * facts those failures moved, so the pair (task start, task end) can be diffed.
 *
 * The one rule the whole design hangs on: **a probe that could not answer is
 * never an empty answer.** Reporting "no listeners found" when `lsof` is missing
 * would hand out a green verdict computed from nothing — the #1614 failure mode
 * of shipping a 0 that was never measured. Every probe therefore carries its own
 * {@link EnvProbeStatus}, and {@link EnvProbeResult.entries} is only meaningful
 * when that status is `ok`.
 *
 * Server-only: spawns processes and reads the filesystem.
 *
 * @module lib/verification/env-snapshot
 */

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { parse as parseYaml } from 'yaml';
import {
  SERVER_MARK_ENV,
  SERVER_MARK_LSTART_ENV,
  SERVER_MARK_MAX_BYTES,
  normalizeLstart,
  parseServerMarkRecord,
  serverMarkDirName,
  type ServerMarkRecord,
} from '@/cli/types/server-mark';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { MACHINE_LOCK_DIR_NAME } from './machine-lock';
import { SESSION_KILL_LEDGER_DIR_NAME } from './session-kill-ledger';
import { WORKTREE_INDEX_DIR_NAME } from './worktree-index';

const logger = createLogger('lib/verification/env-snapshot');

/** Bumped only when a stored snapshot stops being readable by this module. */
export const ENV_SNAPSHOT_VERSION = 1;

/**
 * The four facts the gate watches, one per row of the Issue's table.
 *
 * Ordered as the report prints them: the two that cost a running system first,
 * then the two that only cost disk.
 */
export const ENV_PROBE_IDS = [
  'listeners',
  'tmux-sessions',
  'home-entries',
  'commandmate-entries',
] as const;

export type EnvProbeId = (typeof ENV_PROBE_IDS)[number];

/** Human label used in the gate report. */
export const ENV_PROBE_LABELS: Record<EnvProbeId, string> = {
  listeners: 'CommandMate TCP listeners',
  'tmux-sessions': 'mcbd-* tmux sessions',
  'home-entries': '$HOME entries',
  'commandmate-entries': '~/.commandmate entries',
};

/**
 * One observed entity.
 *
 * `key` is the identity compared across snapshots and must be stable for "the
 * same thing" — a server that restarts on the same port keeps its key, so an
 * ordinary restart is not reported as a kill plus a leak.
 */
export interface EnvEntry {
  key: string;
  /** Context for the reader; never compared. */
  detail: string | null;
  /**
   * Filesystem path the entity is anchored to (a listener's process cwd).
   *
   * For a listener it can only make the listener this task's (`self`); since
   * Issue #4433 only a verified {@link EnvEntry.marks} entry can make it
   * another worktree's. Null means unattributable, which is deliberately the
   * strict answer (see `attributeListener` in env-clean-gate).
   */
  anchor: string | null;
  /**
   * What reading `~/.commandmate/resource.yaml` found (Issue #4406). Only ever
   * set on that one entry of `commandmate-entries`, and never compared or used
   * for the verdict: the addition stays a violation whatever this says. It is
   * there so the person adjudicating the violation can tell, without opening
   * the machine, whether the file has the reader's shape and which bytes it
   * held. Absent on snapshots written before #4406.
   */
  config?: EnvConfigCheck;
  /**
   * `listeners` only (Issue #4433): one reading of the launch mark per process
   * listening on this key, in the order lsof listed them. The only evidence
   * that may excuse an added listener as another worktree's
   * (`attributeListener` in env-clean-gate); never compared. Absent on
   * snapshots written before #4433, which leaves such a listener judged.
   */
  marks?: EnvListenerMark[];
}

/**
 * Why a listener's mark was not verified — a fixed vocabulary, printed as
 * `mark=<reason>` on the report line (Issue #4433).
 *
 * `absent`: the process carries no readable mark (`env-unreadable`, `no-mark`,
 * `pgid-unreadable`). `invalid`: it carries one that does not hold
 * (`duplicate-mark`, `bad-path`, `dir-not-private`, `record-unreadable`,
 * `record-too-large`, `record-malformed`, `pgid-mismatch`, `lstart-unreadable`,
 * `leader-gone`, `leader-start-mismatch`). Either way the listener is judged.
 */
export const ENV_LISTENER_MARK_REASONS = [
  'env-unreadable',
  'no-mark',
  'pgid-unreadable',
  'duplicate-mark',
  'bad-path',
  'dir-not-private',
  'record-unreadable',
  'record-too-large',
  'record-malformed',
  'pgid-mismatch',
  'lstart-unreadable',
  'leader-gone',
  'leader-start-mismatch',
] as const;

export type EnvListenerMarkReason = (typeof ENV_LISTENER_MARK_REASONS)[number];

/** One listening process's mark, as read at capture time (Issue #4433). */
export interface EnvListenerMark {
  pid: number;
  /** Null when `ps` could not say. */
  pgid: number | null;
  /** The process's cwd (the same reading as {@link EnvEntry.anchor}, per pid). */
  anchor: string | null;
  status: 'verified' | 'absent' | 'invalid';
  /** Null exactly when `verified`. */
  reason: EnvListenerMarkReason | null;
  /** The record's launch origin; set only when `verified`. */
  launcherCwd?: string | null;
  worktreeRoot?: string | null;
  repoRoot?: string | null;
  session?: string | null;
}

/**
 * The result of reading one user config file for the report (Issue #4406).
 *
 * `invalid` covers every way the file could not be shown to be a config the
 * reader would accept — not a regular file, a symlink, a hard link, too big,
 * unreadable, not YAML, the wrong shape — with the cause in `reason`. On `ok`,
 * `reason` is an optional note for the reader of the report.
 */
export interface EnvConfigCheck {
  shape: 'ok' | 'invalid';
  reason: string | null;
  /** sha256 of the file's bytes as read (what `shasum -a 256` prints); null when unread. */
  sha256: string | null;
  /** Bytes read; null when unread. */
  size: number | null;
}

export type EnvProbeStatus = 'ok' | 'unavailable';

export interface EnvProbeResult {
  status: EnvProbeStatus;
  /** Meaningful only when `status === 'ok'`; always empty otherwise. */
  entries: EnvEntry[];
  /** Non-null exactly when `status === 'unavailable'`. */
  reason: string | null;
}

export interface EnvSnapshot {
  version: number;
  /** Epoch ms. */
  capturedAt: number;
  /** Worktree the snapshot was taken for, recorded for provenance. */
  worktreeId: string;
  probes: Record<EnvProbeId, EnvProbeResult>;
}

// =============================================================================
// Probe inputs (injected so tests never touch the real machine)
// =============================================================================

export interface CommandResult {
  /** Null when the process could not be spawned or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Non-null when the command never produced an exit status at all. */
  failure: string | null;
}

export interface EnvProbeDeps {
  /** `options.env` is added to this process's environment for that one command. */
  run(command: string, args: string[], options?: { env?: Readonly<Record<string, string>> }): Promise<CommandResult>;
  /** Throws the way `fs.readdirSync` does; the caller turns that into `unavailable`. */
  readDir(path: string): string[];
  homeDir(): string;
  /**
   * Read a user config file's bytes for {@link inspectResourceConfig}; throws
   * with the reason when the file is not one to read. Optional so existing
   * probe fakes keep working; defaults to {@link readRegularFileNoFollow}.
   */
  readConfigFile?(path: string, maxBytes: number): Buffer;
  /**
   * The rest are for reading launch marks (Issue #4433) and are optional so
   * existing probe fakes keep working. `platform` picks how a process's
   * environment is read: `/proc/<pid>/environ` on linux, `ps -E` elsewhere.
   */
  platform?(): NodeJS.Platform;
  /** `/proc/<pid>/environ` as text (NUL separated); null when unreadable. */
  readProcEnviron?(pid: number): string | null;
  getuid?(): number;
  /** Defaults to {@link readServerMarkRecord} with {@link getuid}. */
  readMarkRecord?(path: string): ServerMarkRecordReading;
}

/** Probes are bounded: a hung `lsof` must not hold a verification run open. */
const PROBE_TIMEOUT_MS = 5000;

/** Output kept per probe command; far above any real listing. */
const PROBE_MAX_BUFFER = 4 * 1024 * 1024;

function runCommand(
  command: string,
  args: string[],
  options?: { env?: Readonly<Record<string, string>> }
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
        encoding: 'utf8',
        ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr, failure: null });
          return;
        }
        const withCode = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        // execFile reports a non-zero exit as `code: <number>` and a spawn
        // failure or timeout as `code: 'ENOENT'` / `killed: true`. Only the
        // first is an answer; the rest are the absence of one.
        if (typeof withCode.code === 'number' && !withCode.killed) {
          resolve({ code: withCode.code, stdout, stderr, failure: null });
          return;
        }
        resolve({
          code: null,
          stdout,
          stderr,
          failure: withCode.killed
            ? `${command} exceeded ${PROBE_TIMEOUT_MS}ms and was terminated`
            : `${command} could not be run: ${error.message}`,
        });
      }
    );
  });
}

/**
 * Read a regular file without following a link, checking and reading the same
 * open file (Issue #4406).
 *
 * `O_NOFOLLOW` refuses a symlink at the final component; `fstat` on the open fd
 * then checks the file that is actually being read, so a swap between the check
 * and the read cannot substitute another file. `nlink === 1` refuses a hard link
 * to a file kept elsewhere. `O_NONBLOCK` keeps a FIFO from hanging the probe
 * (it is then refused as not a regular file). A deliberate swap by the same user
 * is out of scope: that user can write the directory and the baselines alike.
 *
 * @throws Error whose message is the reason the file was not read
 */
export function readRegularFileNoFollow(path: string, maxBytes: number): Buffer {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    throw new Error(code === 'ELOOP' ? 'a symlink (not followed)' : `cannot open (${code})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.nlink !== 1) throw new Error(`a hard link (nlink=${stat.nlink})`);
    if (stat.size > maxBytes) throw new Error(`larger than ${maxBytes} bytes (${stat.size})`);
    // Read up to one byte past the limit: a file that grew after fstat is still caught.
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
    }
    return buffer.subarray(0, total);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw code ? new Error(`cannot read (${code})`) : error;
  } finally {
    closeSync(fd);
  }
}

/** `/proc/<pid>/environ`, or null when it cannot be read. Never throws. */
function readProcEnvironFile(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return null;
  }
}

/** -1 where the platform has no uids, which no record directory is named for. */
const currentUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

export const DEFAULT_ENV_PROBE_DEPS: EnvProbeDeps = {
  run: runCommand,
  readDir: (path: string) => readdirSync(path),
  homeDir: () => homedir(),
  readConfigFile: readRegularFileNoFollow,
  platform: () => process.platform,
  readProcEnviron: readProcEnvironFile,
  getuid: currentUid,
};

// =============================================================================
// Launch marks (Issue #4433)
// =============================================================================

export type ServerMarkRecordReading =
  | { ok: true; record: ServerMarkRecord }
  | { ok: false; reason: EnvListenerMarkReason };

/** What the launchers name a record: 32 hex digits. */
const RECORD_FILE_NAME = /^[0-9a-f]{32}\.json$/;

/**
 * Read a launch record from the path a server's `CM_SERVER_MARK` names.
 *
 * The path comes from the process's own environment, so it is checked before
 * anything is read: absolute, a `<32 hex>.json` file directly in a directory
 * named for this user (`commandmate-server-marks-<uid>`), that directory a real
 * directory of this user's with no access for anyone else, the file a regular
 * file of this user's (not a symlink, not a hard link) no larger than 4 KiB,
 * and its content a v1 record. Any miss is a reason, never a throw.
 */
export function readServerMarkRecord(path: string, uid: number): ServerMarkRecordReading {
  if (!path.startsWith('/') || /\s|\0/.test(path)) return { ok: false, reason: 'bad-path' };
  const dir = dirname(path);
  if (basename(dir) !== serverMarkDirName(uid) || !RECORD_FILE_NAME.test(basename(path))) {
    return { ok: false, reason: 'bad-path' };
  }
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      return { ok: false, reason: 'dir-not-private' };
    }
  } catch {
    return { ok: false, reason: 'record-unreadable' };
  }
  let text: string;
  try {
    if (lstatSync(path).uid !== uid) return { ok: false, reason: 'record-unreadable' };
    text = readRegularFileNoFollow(path, SERVER_MARK_MAX_BYTES).toString('utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return { ok: false, reason: message.startsWith('larger than') ? 'record-too-large' : 'record-unreadable' };
  }
  const record = parseServerMarkRecord(text);
  return record ? { ok: true, record } : { ok: false, reason: 'record-malformed' };
}

const answered = (result: CommandResult): boolean =>
  result.failure === null && (result.code === 0 || result.code === 1);

/** The `CM_SERVER_MARK=` values among one environment's entries; null stays null (unreadable). */
function markValues(tokens: string[] | null): string[] | null {
  if (tokens === null) return null;
  const prefix = `${SERVER_MARK_ENV}=`;
  return tokens.filter((token) => token.startsWith(prefix)).map((token) => token.slice(prefix.length));
}

/**
 * Each process's environment entries, or null when it could not be read.
 *
 * linux: `/proc/<pid>/environ`, exact. Elsewhere (macOS): `ps -E` prints the
 * command line and then the environment with no boundary, so only what follows
 * the command line `ps -A -o command=` printed for the same pid is read — a
 * mark-shaped *argument* is not the environment. A line that does not start
 * with that command line is unreadable.
 */
async function readEnvironments(
  deps: EnvProbeDeps,
  pids: number[],
  commandLines: Map<number, string>
): Promise<Map<number, string[] | null>> {
  const result = new Map<number, string[] | null>();
  const platform = deps.platform?.() ?? process.platform;
  if (platform === 'linux') {
    for (const pid of pids) {
      const text = deps.readProcEnviron?.(pid) ?? null;
      result.set(pid, text === null ? null : text.split('\0').filter((token) => token !== ''));
    }
    return result;
  }
  const listing = await deps.run('ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', pids.join(',')]);
  const lines = answered(listing) ? parseProcessTable(listing.stdout) : new Map<number, string>();
  for (const pid of pids) {
    const line = lines.get(pid);
    const command = commandLines.get(pid);
    if (line === undefined || command === undefined || !line.startsWith(command)) {
      result.set(pid, null);
      continue;
    }
    result.set(pid, line.slice(command.length).split(/\s+/).filter((token) => token !== ''));
  }
  return result;
}

/**
 * Read and check each listening process's launch mark (Issue #4433).
 *
 * A mark holds only when the record it names says this process's group is the
 * launch's group and that group's leader is still the recorded process (same
 * start time, read as `LC_ALL=C TZ=UTC0 ps -o lstart=`). That ties the mark to
 * one launch: a mark inherited through the environment or copied from another
 * server names a group this process is not in, and a reused pid has another
 * start time. The extra commands are separate from the listing's own, and a
 * failure in any of them only makes marks absent or invalid — the listing, its
 * keys and details are what they were before #4433.
 */
async function readListenerMarks(
  deps: EnvProbeDeps,
  pids: number[],
  commandLines: Map<number, string>,
  cwdByPid: Map<number, string>
): Promise<Map<number, EnvListenerMark>> {
  const pidList = pids.join(',');
  const pgidListing = await deps.run('ps', ['-o', 'pid=,pgid=', '-p', pidList]);
  const pgidByPid = new Map<number, number>();
  if (answered(pgidListing)) {
    for (const [pid, rest] of parseProcessTable(pgidListing.stdout)) {
      if (/^\d+$/.test(rest)) pgidByPid.set(pid, Number(rest));
    }
  }
  const environments = await readEnvironments(deps, pids, commandLines);
  const uid = deps.getuid?.() ?? currentUid();
  const readRecord = deps.readMarkRecord ?? ((path: string) => readServerMarkRecord(path, uid));

  const marks = new Map<number, EnvListenerMark>();
  const candidates = new Map<number, ServerMarkRecord>();
  for (const pid of pids) {
    const base = { pid, pgid: pgidByPid.get(pid) ?? null, anchor: cwdByPid.get(pid) ?? null };
    const fail = (status: 'absent' | 'invalid', reason: EnvListenerMarkReason) =>
      marks.set(pid, { ...base, status, reason });
    const values = markValues(environments.get(pid) ?? null);
    if (values === null) {
      fail('absent', 'env-unreadable');
      continue;
    }
    if (values.length === 0) {
      fail('absent', 'no-mark');
      continue;
    }
    // Which one `getenv` would return is not knowable from here: refuse both.
    if (values.length > 1) {
      fail('invalid', 'duplicate-mark');
      continue;
    }
    if (base.pgid === null) {
      fail('absent', 'pgid-unreadable');
      continue;
    }
    const reading = readRecord(values[0]);
    if (!reading.ok) {
      fail('invalid', reading.reason);
      continue;
    }
    if (reading.record.pgid !== base.pgid) {
      fail('invalid', 'pgid-mismatch');
      continue;
    }
    candidates.set(pid, reading.record);
  }
  if (candidates.size === 0) return marks;

  // One reading for every leader, taken from the observed groups.
  const leaders = [...new Set(pids.map((pid) => pgidByPid.get(pid)).filter((pgid): pgid is number => pgid !== undefined))];
  const lstartListing = await deps.run('ps', ['-o', 'pid=,lstart=', '-p', leaders.join(',')], {
    env: SERVER_MARK_LSTART_ENV,
  });
  const lstartByPid = new Map<number, string>();
  if (answered(lstartListing)) {
    for (const [pid, rest] of parseProcessTable(lstartListing.stdout)) lstartByPid.set(pid, normalizeLstart(rest));
  }
  for (const [pid, record] of candidates) {
    const base = { pid, pgid: record.pgid, anchor: cwdByPid.get(pid) ?? null };
    if (!answered(lstartListing)) {
      marks.set(pid, { ...base, status: 'invalid', reason: 'lstart-unreadable' });
      continue;
    }
    const leaderStart = lstartByPid.get(record.pgid);
    if (leaderStart === undefined || leaderStart === '') {
      marks.set(pid, { ...base, status: 'invalid', reason: 'leader-gone' });
      continue;
    }
    if (leaderStart !== record.leaderStartTime) {
      marks.set(pid, { ...base, status: 'invalid', reason: 'leader-start-mismatch' });
      continue;
    }
    marks.set(pid, {
      ...base,
      status: 'verified',
      reason: null,
      launcherCwd: record.launcherCwd,
      worktreeRoot: record.worktreeRoot,
      repoRoot: record.repoRoot,
      session: record.session,
    });
  }
  return marks;
}

// =============================================================================
// Probe: TCP listeners
// =============================================================================

/**
 * Command lines that make a listening socket "CommandMate's".
 *
 * Recording *every* listener would make the gate useless within a minute: a
 * browser, a language server or a container runtime opens and closes ports
 * constantly, and each one would read as a violation. The Issue scopes the item
 * to "CommandMate 関連" for exactly that reason, so relevance is decided from
 * the owning process's command line rather than from the port number — a
 * developer's `commandmate start --port 3179` is as relevant as port 3000.
 *
 * This is only the vocabulary, and a cheap first filter. Matched against the
 * whole command line it also hits a process that merely *mentions* a
 * CommandMate path among its arguments — an editor's language server started
 * with `--workspace_id …_commandmate_issue_2616` was recorded as a CommandMate
 * listener and then read as "killed" when it exited (#2627). The decision is
 * {@link isCommandMateCommandLine}'s, which looks only at the program.
 */
export const COMMANDMATE_PROCESS_PATTERN =
  /commandmate|dist\/server\/server\.js|next-server|next (dev|start)|server\.ts/i;

/**
 * Executables that run a script named by a later argument. CommandMate is
 * never a native binary of its own: every shape it runs as is one of these
 * with a CommandMate script, or a process title set by one of them.
 */
const SCRIPT_LAUNCHERS = new Set(['node', 'nodejs', 'bun', 'tsx', 'ts-node', 'npx', 'next']);

/** Executables that are CommandMate by their own name (process title or bin). */
const COMMANDMATE_EXECUTABLES = /^(commandmate(\.js)?|next-server)$/i;

/** A script argument that is CommandMate's server or CLI, judged by its path's end. */
function isCommandMateScript(token: string): boolean {
  const name = basename(token);
  return (
    /(^|\/)dist\/server\/server\.js$/.test(token) ||
    name === 'server.ts' ||
    /^commandmate(\.js)?$/i.test(name)
  );
}

/**
 * Whether a `ps` command line is a CommandMate process (#2627).
 *
 * Judged on the program, never on free-form arguments:
 *
 *   - the executable itself (`next-server (v14…)`, a `commandmate` bin run
 *     directly) — its basename, so a directory called `commandmate` in the
 *     executable's *path* does not count either;
 *   - or, when the executable is a script launcher (`node`, `tsx`, `next`, …),
 *     its positional arguments matched as whole paths by their end:
 *     `…/dist/server/server.js`, `server.ts`, a `commandmate` bin, or `next`
 *     followed by `dev` / `start`.
 *
 * Flags are dropped before matching, `--workspace=/x/commandmate` included,
 * and a positional counts only as a whole token: `/x/commandmate-issue-1` is a
 * path that mentions CommandMate, not CommandMate. Any other executable —
 * `language_server_macos_arm`, Chrome, postgres — is not CommandMate whatever
 * its arguments say.
 *
 * Why not `ps -o comm=` (the executable alone): `node dist/server/server.js` is
 * `node` there, indistinguishable from every other node process, so the
 * production server itself would stop being recorded.
 */
export function isCommandMateCommandLine(commandLine: string): boolean {
  if (!COMMANDMATE_PROCESS_PATTERN.test(commandLine)) return false;
  const [program, ...rest] = commandLine.trim().split(/\s+/);
  if (!program) return false;
  const name = basename(program);
  if (COMMANDMATE_EXECUTABLES.test(name)) return true;
  if (!SCRIPT_LAUNCHERS.has(name.toLowerCase())) return false;

  const positionals = [name, ...rest.filter((token) => !token.startsWith('-'))];
  return positionals.some((token, index) => {
    if (index > 0 && isCommandMateScript(token)) return true;
    return basename(token) === 'next' && /^(dev|start)$/.test(positionals[index + 1] ?? '');
  });
}

/** `ps` line: leading pid, then the full command line. */
function parseProcessTable(stdout: string): Map<number, string> {
  const table = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    table.set(Number(match[1]), match[2].trim());
  }
  return table;
}

/**
 * `lsof -F` output: one field per line, the field's letter first.
 *
 * A `p` line opens a process block and every following field belongs to it
 * until the next `p`.
 */
function parseLsofFields(stdout: string): Array<{ pid: number; fields: Map<string, string[]> }> {
  const blocks: Array<{ pid: number; fields: Map<string, string[]> }> = [];
  let current: { pid: number; fields: Map<string, string[]> } | null = null;

  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const letter = line[0];
    const value = line.slice(1);
    if (letter === 'p') {
      const pid = Number(value);
      if (!Number.isInteger(pid)) {
        current = null;
        continue;
      }
      current = { pid, fields: new Map() };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    const bucket = current.fields.get(letter);
    if (bucket) bucket.push(value);
    else current.fields.set(letter, [value]);
  }

  return blocks;
}

/** `*:3000`, `127.0.0.1:3000`, `[::1]:3000` → `3000`. */
function portOf(name: string): string | null {
  const colon = name.lastIndexOf(':');
  if (colon < 0) return null;
  const port = name.slice(colon + 1);
  return /^\d+$/.test(port) ? port : null;
}

function unavailable(reason: string): EnvProbeResult {
  return { status: 'unavailable', entries: [], reason };
}

function ok(entries: EnvEntry[]): EnvProbeResult {
  // Deduplicated by key: one server answers on both IPv4 and IPv6, and lsof
  // reports that as two rows for one listener.
  const byKey = new Map<string, EnvEntry>();
  for (const entry of entries) {
    if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
  }
  return {
    status: 'ok',
    entries: [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    reason: null,
  };
}

/**
 * CommandMate processes listening on a TCP port, keyed by port.
 *
 * Keyed by port rather than by pid so a plain restart is invisible: what the
 * gate is asked to notice is a port that stopped answering (the production
 * server was killed) or one that started and stayed (an isolated server was
 * left behind), not that a supervisor replaced a process.
 *
 * `lsof` failing makes the probe `unavailable` rather than empty, and so does
 * `ps`: without the process table there is no way to tell a CommandMate server
 * from any other listener, and guessing would be the fail-open this gate exists
 * to prevent.
 */
export async function probeListeners(deps: EnvProbeDeps): Promise<EnvProbeResult> {
  const listeners = await deps.run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
  // lsof exits 1 when it simply matched nothing, and that is a real "none".
  if (listeners.failure !== null) return unavailable(listeners.failure);
  if (listeners.code !== 0 && listeners.code !== 1) {
    return unavailable(
      `lsof exited ${listeners.code}: ${listeners.stderr.trim() || 'no diagnostic output'}`
    );
  }

  const blocks = parseLsofFields(listeners.stdout);
  if (blocks.length === 0) return ok([]);

  const processes = await deps.run('ps', ['-A', '-o', 'pid=,command=']);
  if (processes.failure !== null || processes.code !== 0) {
    return unavailable(
      processes.failure ??
        `ps exited ${processes.code}: ${processes.stderr.trim() || 'no diagnostic output'}`
    );
  }
  const table = parseProcessTable(processes.stdout);

  const relevant = blocks.filter((block) => {
    const commandLine = table.get(block.pid);
    return commandLine !== undefined && isCommandMateCommandLine(commandLine);
  });
  if (relevant.length === 0) return ok([]);

  // cwd is what attributes an added listener to a worker. Its absence weakens
  // attribution (the entry becomes unattributed, which is the strict verdict)
  // but does not invalidate the listing, so a failure here is not `unavailable`.
  const cwdByPid = new Map<number, string>();
  const pids = relevant.map((block) => String(block.pid));
  const cwds = await deps.run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-F', 'pn']);
  if (cwds.failure === null && (cwds.code === 0 || cwds.code === 1)) {
    for (const block of parseLsofFields(cwds.stdout)) {
      const [path] = block.fields.get('n') ?? [];
      if (path) cwdByPid.set(block.pid, path);
    }
  }

  const pidOrder = [...new Set(relevant.map((block) => block.pid))];
  const markByPid = await readListenerMarks(deps, pidOrder, table, cwdByPid);

  // Every process on a key keeps its own mark (Issue #4433): `ok()` keeps the
  // first entry of a key, so the list is shared by all of that key's entries.
  const marksByKey = new Map<string, EnvListenerMark[]>();
  const entries: EnvEntry[] = [];
  for (const block of relevant) {
    const command = block.fields.get('c')?.[0] ?? 'unknown';
    for (const name of block.fields.get('n') ?? []) {
      const port = portOf(name);
      if (!port) continue;
      const key = `tcp/${port}`;
      let marks = marksByKey.get(key);
      if (!marks) {
        marks = [];
        marksByKey.set(key, marks);
      }
      const mark = markByPid.get(block.pid);
      if (mark && !marks.some((existing) => existing.pid === block.pid)) marks.push(mark);
      entries.push({
        key,
        detail: `${command} pid=${block.pid}`,
        anchor: cwdByPid.get(block.pid) ?? null,
        marks,
      });
    }
  }
  return ok(entries);
}

// =============================================================================
// Probe: tmux sessions
// =============================================================================

/**
 * Prefix every CommandMate session name carries (`mcbd-<cli>-<worktreeId>`).
 *
 * Duplicated from `lib/tmux/read-mode` rather than imported: that module is the
 * read-mode key bindings, and pulling it in would make a verification gate
 * depend on the terminal UI. The value is fixed by the session-name format in
 * `lib/cli-tools/base.ts` and asserted against it in the unit tests.
 */
export const MCBD_SESSION_PREFIX = 'mcbd-';

/**
 * `mcbd-*` sessions on the default tmux server.
 *
 * Only `mcbd-*` names are recorded: every other session belongs to the user and
 * is none of a delegation's business, so watching them would only manufacture
 * violations. Sessions of *other* worktrees stay in the set on purpose — killing
 * a sibling worker's session is the #1624 failure this probe is here to catch.
 * A sibling session stopped by someone else through `instances <wt> kill` is set
 * apart at diff time from the session-kill ledger (Issue #3993), not here.
 *
 * "No server running" is an answer (zero sessions), which is why it is not
 * treated as a probe failure. `tmux` being absent, or hanging, is not.
 */
export async function probeTmuxSessions(deps: EnvProbeDeps): Promise<EnvProbeResult> {
  const result = await deps.run('tmux', ['list-sessions', '-F', '#{session_name}']);
  if (result.failure !== null) return unavailable(result.failure);

  if (result.code !== 0) {
    if (/no server running|error connecting to|no sessions/i.test(result.stderr)) return ok([]);
    return unavailable(
      `tmux list-sessions exited ${result.code}: ${result.stderr.trim() || 'no diagnostic output'}`
    );
  }

  const entries = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name.startsWith(MCBD_SESSION_PREFIX))
    .map((name) => ({ key: name, detail: null, anchor: null }));
  return ok(entries);
}

// =============================================================================
// Probe: directory listings
// =============================================================================

/**
 * Names that appear and disappear on their own, excluded from both directory
 * probes.
 *
 * SQLite creates and removes `-wal` / `-shm` beside an open database, so a
 * server that started or stopped between the two snapshots would otherwise
 * report two violations for something nobody did. `.DS_Store` is written by the
 * Finder. Excluding them is not a hole: none of them is a thing a delegation can
 * leave behind that matters.
 */
export const VOLATILE_ENTRY_PATTERNS = [/-wal$/, /-shm$/, /-journal$/, /^\.DS_Store$/];

/** This module's own storage, which must not read as something a task created. */
export const ENV_SNAPSHOT_DIR_NAME = 'env-snapshots';

/**
 * Directory under `~/.commandmate` the flow record writes into (Issue #4367).
 *
 * The name is `scripts/flow/record.mjs`'s: `CM_FLOW_DIR`, or
 * `<home>/.commandmate/flow`, with one day file per repository below it. A
 * `.mjs` script cannot be imported from here, so this is a copy of that name
 * rather than the same constant.
 */
export const FLOW_DIR_NAME = 'flow';

/**
 * Coordination directories the verification runner itself creates under
 * `~/.commandmate` (Issue #1771): the gate mutex locks and the worktree index
 * registry. Neither is a side effect of the delegation — the first mutexed gate
 * on a machine creates them — so counting them would report the runner's own
 * bookkeeping as pollution the agent left behind. The session-kill ledger
 * (Issue #3993) is the same kind of bookkeeping: the first recorded
 * `instances <wt> kill` on a machine creates it. The flow record (Issue #4367)
 * belongs for the same reason, though the ticks of the measurement, not the
 * runner's own verify, are what create it.
 *
 * Scoped to the `~/.commandmate` probe rather than added to
 * {@link isIgnoredEntry}: a `~/locks` directory in `$HOME` is not ours, and
 * blanket-ignoring the name would put a hole in the probe that exists to catch
 * exactly that.
 */
const COMMANDMATE_RUNTIME_ENTRY_NAMES = [
  MACHINE_LOCK_DIR_NAME,
  WORKTREE_INDEX_DIR_NAME,
  SESSION_KILL_LEDGER_DIR_NAME,
  FLOW_DIR_NAME,
];

function isIgnoredEntry(name: string): boolean {
  if (name === ENV_SNAPSHOT_DIR_NAME) return true;
  return VOLATILE_ENTRY_PATTERNS.some((pattern) => pattern.test(name));
}

function probeDirectory(
  deps: EnvProbeDeps,
  path: string,
  { missingIsEmpty, alsoIgnored = [] }: { missingIsEmpty: boolean; alsoIgnored?: string[] }
): EnvProbeResult {
  let names: string[];
  try {
    names = deps.readDir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A directory that does not exist yet has zero entries — and if a task
    // creates it, that shows up as an addition, which is the point.
    if (missingIsEmpty && code === 'ENOENT') return ok([]);
    return unavailable(`could not list ${path}: ${(error as Error).message}`);
  }
  return ok(
    names
      .filter((name) => !isIgnoredEntry(name) && !alsoIgnored.includes(name))
      .map((name) => ({ key: name, detail: null, anchor: null }))
  );
}

/** Entries directly under `$HOME`. A worker leaving `~/.commandmate-uat-1726` shows up here. */
export function probeHomeEntries(deps: EnvProbeDeps): EnvProbeResult {
  return probeDirectory(deps, deps.homeDir(), { missingIsEmpty: false });
}

// =============================================================================
// The user's resource config (Issue #4406)
// =============================================================================

/**
 * `~/.commandmate/resource.yaml`, read by `scripts/orchestrate/resource-config.mjs`
 * (Issue #4370) every time it is called. A change to it takes effect on the
 * resource gate of every lane at once, so its appearance during a task stays a
 * violation: who placed it cannot be established here (the owner check is #4497).
 * What this module adds is the reading the adjudicator needs — shape and hash.
 */
export const RESOURCE_CONFIG_ENTRY_NAME = 'resource.yaml';

/** Far above a hand-written config; a larger file is not read. */
export const RESOURCE_CONFIG_MAX_BYTES = 64 * 1024;

/**
 * The reader's top-level keys (`TOP_KEYS` in resource-config.mjs). A copy, since a
 * `.mjs` script cannot be imported from here; the unit test compares it with the
 * script's source so the two cannot drift apart.
 */
export const RESOURCE_CONFIG_TOP_KEYS: readonly string[] = [
  'version',
  'ncpu',
  'commandmate_share',
  'load_ceiling',
  'load_resume',
  'weights',
  'ci_vm',
  'runners',
  'health',
  'idle',
];

/** Unknown keys named in a reason before the rest becomes a count. */
export const RESOURCE_CONFIG_REASON_MAX_KEYS = 5;

/** Longest reason carried into a snapshot and printed in a report. */
export const RESOURCE_CONFIG_REASON_MAX_CHARS = 200;

/**
 * Make a reason safe to print on one report line: control and line-separator
 * characters become `\uXXXX`, and the text is cut at
 * {@link RESOURCE_CONFIG_REASON_MAX_CHARS}. Applied where a reason is made and
 * again where a loaded one is printed (a baseline is a file, not a promise).
 */
export function limitConfigReason(reason: string): string {
  // eslint-disable-next-line no-control-regex
  const escaped = reason.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return escaped.length > RESOURCE_CONFIG_REASON_MAX_CHARS
    ? `${escaped.slice(0, RESOURCE_CONFIG_REASON_MAX_CHARS)}…`
    : escaped;
}

/**
 * A wrong `version` for the reason, without expanding a collection: YAML aliases
 * can make one refer to itself (`version: &v [*v]`), and stringifying that would
 * throw out of the probe (codex review 3, P2).
 */
function describeConfigVersion(value: unknown): string {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return JSON.stringify(value) ?? String(value);
  }
  return `(a ${Array.isArray(value) ? 'list' : typeof value})`;
}

/** Keys under which a later resource PR runs commands or keeps a controller (resource-4370.md §2.7). */
const RESOURCE_CONFIG_ACTING_KEYS = ['runners', 'health', 'idle'];

/**
 * Whether the text has the shape the reader accepts, judged strictly: an
 * unknown top-level key is `invalid` here although the reader only warns.
 * Values are not range-checked — that is the reader's job.
 */
export function checkResourceConfigText(text: string): { ok: boolean; reason: string | null } {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    return {
      ok: false,
      reason: limitConfigReason(`not YAML (${String((error as Error).message).split('\n')[0]})`),
    };
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'the top level is not a mapping' };
  }
  const doc = parsed as Record<string, unknown>;
  const unknown = Object.keys(doc).filter((key) => !RESOURCE_CONFIG_TOP_KEYS.includes(key));
  if (unknown.length > 0) {
    // Keys are the file's text: quoted (a newline becomes `\n`), and only the
    // first few, so a crafted key cannot forge a report line or bloat it.
    const shown = unknown.slice(0, RESOURCE_CONFIG_REASON_MAX_KEYS).map((key) => JSON.stringify(key));
    const more = unknown.length - shown.length;
    return {
      ok: false,
      reason: limitConfigReason(`unknown key ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`),
    };
  }
  if (doc.version !== undefined && doc.version !== 1) {
    return { ok: false, reason: limitConfigReason(`version ${describeConfigVersion(doc.version)} is not 1`) };
  }
  const acting = RESOURCE_CONFIG_ACTING_KEYS.filter((key) => key in doc);
  return { ok: true, reason: acting.length > 0 ? `has ${acting.join('/')}` : null };
}

/**
 * Read and check `path` for the report. Never throws: a file that cannot be
 * read is `invalid` with the reason, which changes nothing about the verdict.
 */
export function inspectResourceConfig(deps: EnvProbeDeps, path: string): EnvConfigCheck {
  const read = deps.readConfigFile ?? readRegularFileNoFollow;
  let bytes: Buffer;
  try {
    bytes = read(path, RESOURCE_CONFIG_MAX_BYTES);
  } catch (error) {
    return {
      shape: 'invalid',
      reason: limitConfigReason(error instanceof Error ? error.message : String(error)),
      sha256: null,
      size: null,
    };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { shape: 'invalid', reason: 'not UTF-8', sha256, size: bytes.length };
  }
  // The check must not cost the entry: whatever the text does to the parser,
  // the entry stays (as `invalid`) and is judged by its name like any other.
  let shape: { ok: boolean; reason: string | null };
  try {
    shape = checkResourceConfigText(text);
  } catch (error) {
    shape = {
      ok: false,
      reason: limitConfigReason(`check failed (${error instanceof Error ? error.message : String(error)})`),
    };
  }
  return { shape: shape.ok ? 'ok' : 'invalid', reason: shape.reason, sha256, size: bytes.length };
}

/** Entries directly under `~/.commandmate` — the state directory #1722 polluted. */
export function probeCommandmateEntries(deps: EnvProbeDeps): EnvProbeResult {
  const dir = join(deps.homeDir(), '.commandmate');
  const result = probeDirectory(deps, dir, {
    missingIsEmpty: true,
    alsoIgnored: COMMANDMATE_RUNTIME_ENTRY_NAMES,
  });
  if (result.status !== 'ok') return result;
  return {
    ...result,
    entries: result.entries.map((entry) =>
      entry.key === RESOURCE_CONFIG_ENTRY_NAME
        ? { ...entry, config: inspectResourceConfig(deps, join(dir, entry.key)) }
        : entry
    ),
  };
}

// =============================================================================
// Capture
// =============================================================================

export interface CaptureEnvSnapshotInput {
  worktreeId: string;
  /** Epoch ms; injected by tests so a stored snapshot is reproducible. */
  now?: number;
  deps?: EnvProbeDeps;
}

/**
 * Take one snapshot of all four probes.
 *
 * Never throws: a probe that could not answer is recorded as `unavailable` with
 * its reason, because the pair of snapshots has to be diffable even when half
 * the machine refused to answer. What that means for the verdict is
 * `diffEnvSnapshots`' decision, and it is `unknown`, never `clean`.
 */
export async function captureEnvSnapshot(input: CaptureEnvSnapshotInput): Promise<EnvSnapshot> {
  const deps = input.deps ?? DEFAULT_ENV_PROBE_DEPS;
  const [listeners, tmuxSessions] = await Promise.all([
    probeListeners(deps).catch((error: Error) => unavailable(`listeners probe threw: ${error.message}`)),
    probeTmuxSessions(deps).catch((error: Error) =>
      unavailable(`tmux probe threw: ${error.message}`)
    ),
  ]);

  return {
    version: ENV_SNAPSHOT_VERSION,
    capturedAt: input.now ?? Date.now(),
    worktreeId: input.worktreeId,
    probes: {
      listeners,
      'tmux-sessions': tmuxSessions,
      'home-entries': probeHomeEntries(deps),
      'commandmate-entries': probeCommandmateEntries(deps),
    },
  };
}

// =============================================================================
// Persistence
// =============================================================================

/**
 * Where baselines live: beside the database, never inside a repository.
 *
 * A snapshot describes the machine, not the worktree, and writing it into the
 * worktree would put it in front of the `scope` and `work-evidence` gates — a
 * file the orchestrator created reading as the agent's work is exactly the #1580
 * defect.
 */
export function resolveEnvSnapshotDir(): string {
  return join(dirname(getEnv().CM_DB_PATH), ENV_SNAPSHOT_DIR_NAME);
}

/** Baselines older than this are removed when a new one is written. */
export const ENV_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Task ids are UUIDs; anything else must never become a path segment. */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function snapshotPath(dir: string, taskId: string): string | null {
  if (!TASK_ID_PATTERN.test(taskId)) return null;
  return join(dir, `${taskId}.json`);
}

function pruneOldSnapshots(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > ENV_SNAPSHOT_RETENTION_MS) rmSync(path, { force: true });
    } catch {
      // A snapshot that cannot be stat'd or removed is not worth failing a send.
    }
  }
}

/**
 * Store the baseline for `taskId`.
 *
 * @returns true when the snapshot was written
 */
export function saveEnvSnapshot(
  taskId: string,
  snapshot: EnvSnapshot,
  dir: string = resolveEnvSnapshotDir()
): boolean {
  const path = snapshotPath(dir, taskId);
  if (!path) {
    logger.warn('env-snapshot-rejected-task-id', { taskId });
    return false;
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
    pruneOldSnapshots(dir, snapshot.capturedAt);
    return true;
  } catch (error) {
    logger.warn('env-snapshot-write-failed', {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Compare a stored baseline under today's roster, not the roster of its day.
 *
 * A name added to {@link COMMANDMATE_RUNTIME_ENTRY_NAMES} since the baseline was
 * written is absent from the final capture because the current probe ignores it,
 * so `before=['flow'] → after=[]` would read as a removal even though nothing on
 * the filesystem changed (Issue #4396). Dropping the roster from a loaded
 * `commandmate-entries` gives both sides the same rules. Only that probe: a
 * `~/flow` entry in `$HOME` is still the violation it always was.
 */
function applyRuntimeEntryRoster(snapshot: EnvSnapshot): EnvSnapshot {
  const probe = snapshot.probes['commandmate-entries'];
  const entries = probe.entries.filter(
    (entry) => !COMMANDMATE_RUNTIME_ENTRY_NAMES.includes(entry.key)
  );
  if (entries.length === probe.entries.length) return snapshot;
  return {
    ...snapshot,
    probes: {
      ...snapshot.probes,
      'commandmate-entries': { ...probe, entries },
    },
  };
}

/**
 * Read the baseline for `taskId`.
 *
 * @returns the snapshot, or null when there is none — which the gate reports as
 *          UNKNOWN, never as "nothing changed"
 */
export function loadEnvSnapshot(
  taskId: string,
  dir: string = resolveEnvSnapshotDir()
): EnvSnapshot | null {
  const path = snapshotPath(dir, taskId);
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isEnvSnapshot(parsed)) return null;
    return applyRuntimeEntryRoster(parsed);
  } catch {
    return null;
  }
}

function isEnvProbeResult(value: unknown): value is EnvProbeResult {
  if (typeof value !== 'object' || value === null) return false;
  const probe = value as Record<string, unknown>;
  if (probe.status !== 'ok' && probe.status !== 'unavailable') return false;
  return Array.isArray(probe.entries);
}

/**
 * Whether a parsed file is a snapshot this module can compare against.
 *
 * A truncated or older-format file is rejected rather than coerced: half a
 * snapshot would diff into violations nobody caused, and the alternative to
 * accepting it is UNKNOWN, which is the safe answer.
 */
export function isEnvSnapshot(value: unknown): value is EnvSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.version !== ENV_SNAPSHOT_VERSION) return false;
  if (typeof snapshot.capturedAt !== 'number') return false;
  const probes = snapshot.probes;
  if (typeof probes !== 'object' || probes === null) return false;
  return ENV_PROBE_IDS.every((id) => isEnvProbeResult((probes as Record<string, unknown>)[id]));
}
