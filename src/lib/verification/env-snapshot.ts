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
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';

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
   * The only input to ownership attribution, which is what stops a parallel
   * worker's server from being reported as this task's leak. Null means
   * unattributable, which is deliberately the strict answer (see
   * `attributeAnchor` in env-clean-gate).
   */
  anchor: string | null;
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
  run(command: string, args: string[]): Promise<CommandResult>;
  /** Throws the way `fs.readdirSync` does; the caller turns that into `unavailable`. */
  readDir(path: string): string[];
  homeDir(): string;
}

/** Probes are bounded: a hung `lsof` must not hold a verification run open. */
const PROBE_TIMEOUT_MS = 5000;

/** Output kept per probe command; far above any real listing. */
const PROBE_MAX_BUFFER = 4 * 1024 * 1024;

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    execFile(
      command,
      args,
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER, encoding: 'utf8' },
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

export const DEFAULT_ENV_PROBE_DEPS: EnvProbeDeps = {
  run: runCommand,
  readDir: (path: string) => readdirSync(path),
  homeDir: () => homedir(),
};

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
 */
export const COMMANDMATE_PROCESS_PATTERN =
  /commandmate|dist\/server\/server\.js|next-server|next (dev|start)|server\.ts/i;

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
    return commandLine !== undefined && COMMANDMATE_PROCESS_PATTERN.test(commandLine);
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

  const entries: EnvEntry[] = [];
  for (const block of relevant) {
    const command = block.fields.get('c')?.[0] ?? 'unknown';
    for (const name of block.fields.get('n') ?? []) {
      const port = portOf(name);
      if (!port) continue;
      entries.push({
        key: `tcp/${port}`,
        detail: `${command} pid=${block.pid}`,
        anchor: cwdByPid.get(block.pid) ?? null,
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

function isIgnoredEntry(name: string): boolean {
  if (name === ENV_SNAPSHOT_DIR_NAME) return true;
  return VOLATILE_ENTRY_PATTERNS.some((pattern) => pattern.test(name));
}

function probeDirectory(
  deps: EnvProbeDeps,
  path: string,
  { missingIsEmpty }: { missingIsEmpty: boolean }
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
      .filter((name) => !isIgnoredEntry(name))
      .map((name) => ({ key: name, detail: null, anchor: null }))
  );
}

/** Entries directly under `$HOME`. A worker leaving `~/.commandmate-uat-1726` shows up here. */
export function probeHomeEntries(deps: EnvProbeDeps): EnvProbeResult {
  return probeDirectory(deps, deps.homeDir(), { missingIsEmpty: false });
}

/** Entries directly under `~/.commandmate` — the state directory #1722 polluted. */
export function probeCommandmateEntries(deps: EnvProbeDeps): EnvProbeResult {
  return probeDirectory(deps, join(deps.homeDir(), '.commandmate'), { missingIsEmpty: true });
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
    return parsed;
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
