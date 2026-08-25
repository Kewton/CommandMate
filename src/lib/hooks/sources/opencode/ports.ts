/**
 * Which port each opencode instance's server listens on (Issue #1763).
 *
 * ## Why CommandMate assigns the port instead of reading it
 *
 * `opencode --help` calls `--port` "default: 0" and 0 looks like "ask the OS
 * for a free port". It is not. #1758 §5.9.1 measured it: the first server took
 * **4096**, and only the second — finding 4096 taken — fell through to an
 * ephemeral port (58153). So under `--port 0`, several instances land on
 * unpredictable numbers.
 *
 * And the port cannot be read back. §5.9.2 searched an isolated `HOME` after a
 * launch and found no port file, no lock file and no pid file; the only two
 * ways to learn it are the one stdout line (behind a stderr warning, from a
 * process running inside a tmux pane) and `lsof`. Both are worse than deciding
 * the number in the first place, so CommandMate does — which also removes the
 * "two owners of one port" problem the Issue worried about, because there is
 * only ever one owner.
 *
 * ## Why the assignment is written to disk
 *
 * A CommandMate restart loses in-memory state while the pane keeps running, so
 * without a record the still-live server on port N is unreachable — the
 * subscription would never come back and the session would silently drop to the
 * scraper for the rest of its life. Re-deriving the port from a hash is not
 * enough: two instances whose hashes collide are allocated *different* ports
 * (the second scans forward), and after a restart both would re-derive the same
 * first candidate and one would attach to the other's server. Events would then
 * be filed against the wrong worktree, silently. The file records what was
 * actually allocated, so recovery reads rather than guesses.
 *
 * Entries are verified before use: a port is only recovered when something
 * answers `/global/health` as opencode, and when the recorded worktree still
 * matches. A stale entry costs one failed health check.
 *
 * ## Range
 *
 * Deliberately not 3000-3100 (CommandMate's own servers, `--auto-port`) and
 * deliberately not 4096 (opencode's own first choice, which a hand-started
 * `opencode serve` will take).
 *
 * @module lib/hooks/sources/opencode/ports
 */

import { createServer } from 'net';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { resolveSafeDirectory } from '@/config/safe-directory';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { isHookInjectionEnabled } from '@/lib/hooks/hook-settings-generator';
import { createLogger } from '@/lib/logger';
import type { AgentInstanceRef } from '../types';
import { fetchOpencodeHealth, OPENCODE_SERVER_HOST } from './client';

const logger = createLogger('lib/hooks/sources/opencode/ports');

/** The window opencode instances are placed in. 100 ports, one per instance. */
export const OPENCODE_PORT_RANGE = { min: 4200, max: 4299 } as const;

/** How many candidates a scan will try before giving up. */
const PORT_SPAN = OPENCODE_PORT_RANGE.max - OPENCODE_PORT_RANGE.min + 1;

/** One instance's assignment. */
export interface OpencodePortAssignment {
  port: number;
  /** The worktree it was allocated for, so a recovered entry can be checked. */
  worktreePath: string;
  /** Epoch ms, for diagnosing a file nobody cleaned up. */
  updatedAt: number;
}

/**
 * Assignments for this process, reached through `globalThis`.
 *
 * The reason every shared map in this codebase is (Issue #1736): under
 * `next dev` each route is bundled separately, so a module-scoped map would let
 * the launcher and the subscription hold different copies and the port would
 * read back as "unassigned" in the half that needs it — with no error anywhere.
 */
declare global {
  // eslint-disable-next-line no-var
  var __opencodePortAssignments: Map<string, OpencodePortAssignment> | undefined;
}

const assignments = (globalThis.__opencodePortAssignments ??= new Map<
  string,
  OpencodePortAssignment
>());

function keyOf(target: AgentInstanceRef): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

/**
 * Where the assignments are persisted. `CM_OPENCODE_PORT_FILE` overrides.
 *
 * Issue #1774: `writePersistedOpencodePorts` creates this file's directory with
 * a recursive mkdir. For a path inside `/proc`, `/sys` or `/dev` that call does
 * not throw — it spins the event loop forever, so the `try/catch` around it
 * never runs. A file path is checked the same way a directory is (the match is
 * on the prefix), so the override is refused here and the default is used.
 */
export function getOpencodePortFilePath(): string {
  const fallback = join(homedir(), '.commandmate', 'opencode-ports.json');
  return resolveSafeDirectory(
    process.env.CM_OPENCODE_PORT_FILE,
    fallback,
    'CM_OPENCODE_PORT_FILE'
  );
}

function isAssignment(value: unknown): value is OpencodePortAssignment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.port === 'number' &&
    Number.isInteger(record.port) &&
    record.port > 0 &&
    record.port < 65536 &&
    typeof record.worktreePath === 'string'
  );
}

/** Read the persisted assignments. Never throws — a bad file means "none". */
export function readPersistedOpencodePorts(): Record<string, OpencodePortAssignment> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getOpencodePortFilePath(), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, OpencodePortAssignment> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isAssignment(value)) {
        result[key] = {
          port: value.port,
          worktreePath: value.worktreePath,
          updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
        };
      }
    }
    return result;
  } catch {
    // Absent on a first run, unreadable if somebody edited it. Both mean the
    // same thing to a caller: nothing to recover.
    return {};
  }
}

/** Write the assignments back. Never throws — losing the file costs recovery. */
function writePersistedOpencodePorts(all: Record<string, OpencodePortAssignment>): void {
  const path = getOpencodePortFilePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    logger.warn('opencode-port-file-write-failed', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The port assigned to this instance in this process, or null. */
export function getAssignedOpencodePort(target: AgentInstanceRef): number | null {
  return assignments.get(keyOf(target))?.port ?? null;
}

/**
 * The worktree an assignment was made for, in this process. Null when there is
 * none (Issue #2038).
 *
 * Exists because `killSession` is handed `(worktreeId, instanceId)` and no
 * path, and Issue #2038 has to answer "is the session opencode is about to
 * forget rooted in THIS worktree?" at exactly that moment. The assignment is
 * already the record of "this instance is running there" — `recoverOpencodePort`
 * trusts the same field — so reading it is cheaper and more honest than
 * re-deriving the path from the database inside a launcher that is deliberately
 * kept out of the database's import graph.
 */
export function getAssignedOpencodeWorktreePath(target: AgentInstanceRef): string | null {
  return assignments.get(keyOf(target))?.worktreePath ?? null;
}

/** Record an assignment in memory and on disk. */
export function rememberOpencodePort(
  target: AgentInstanceRef,
  port: number,
  worktreePath: string,
  at: number = Date.now()
): void {
  const key = keyOf(target);
  const assignment: OpencodePortAssignment = { port, worktreePath, updatedAt: at };
  assignments.set(key, assignment);
  const all = readPersistedOpencodePorts();
  all[key] = assignment;
  writePersistedOpencodePorts(all);
}

/** Drop an assignment from memory and disk. Called when the pane is killed. */
export function forgetOpencodePort(target: AgentInstanceRef): void {
  const key = keyOf(target);
  assignments.delete(key);
  const all = readPersistedOpencodePorts();
  if (key in all) {
    delete all[key];
    writePersistedOpencodePorts(all);
  }
}

/**
 * The addresses a candidate port is probed on, loopback first (Issue #1900).
 *
 * Loopback alone is not an answer on this platform. Node sets `SO_REUSEADDR` on
 * every listener, and on macOS/BSD that flag lets a bind to a *specific*
 * address succeed while another process holds the same port on a *wildcard*
 * one. Measured on Darwin 25.6.0 with an occupant on `0.0.0.0:45217`:
 *
 * ```
 * bind 127.0.0.1:45217 -> SUCCESS   <- the old probe: "free"
 * bind 0.0.0.0:45217   -> EADDRINUSE
 * bind :::45217        -> SUCCESS
 * ```
 *
 * and with an occupant on `[::]:45218`, `0.0.0.0` and `::` both answered
 * `EADDRINUSE` while loopback again said free. So the old probe called a port
 * free that an Angular dev server (4200 is its default, and 4200-4299 is this
 * range) was already serving on — and opencode, binding loopback with the same
 * flag, would then win `http://localhost:4200` for the rest of the session.
 * That is not a failed allocation, it is a hijacked one, which is why the
 * wildcard addresses are probed even though opencode never binds them.
 *
 * `::` earns its place beyond `0.0.0.0` for a listener that set `IPV6_V6ONLY`;
 * a probe on an address family this host does not have is inconclusive rather
 * than occupied — see {@link probeBind}.
 */
export const OPENCODE_PORT_PROBE_HOSTS: readonly string[] = [
  OPENCODE_SERVER_HOST,
  '0.0.0.0',
  '::',
];

/** What one bind attempt established about a port. */
type BindProbe =
  /** Bound and released: nothing holds this address. */
  | 'free'
  /** Somebody holds it, or this process may not have it. */
  | 'in-use'
  /** The address itself is not usable here, so the probe said nothing. */
  | 'unavailable';

/** Error codes that mean the port is spoken for, rather than unreachable. */
const OCCUPIED_BIND_CODES: readonly string[] = ['EADDRINUSE', 'EACCES'];

/**
 * Bind one address for as long as it takes to learn whether it was free.
 *
 * The wildcard probes do expose the port to the network for the microseconds
 * the socket is open. It carries no `connection` handler and is closed in the
 * same tick, and there is no way to ask the kernel this question without
 * asking it — the alternative is the mis-allocation documented above.
 */
function probeBind(port: number, host: string): Promise<BindProbe> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(OCCUPIED_BIND_CODES.includes(error.code ?? '') ? 'in-use' : 'unavailable');
    });
    server.listen(port, host, () => {
      server.close(() => resolve('free'));
    });
  });
}

/**
 * Whether nothing is listening on a port.
 *
 * Binds and immediately closes, which is the only answer that is true at the
 * moment it is given — on every address in {@link OPENCODE_PORT_PROBE_HOSTS},
 * because loopback alone answers the wrong question here (Issue #1900).
 *
 * The loopback probe is the strict one: anything other than a clean bind reads
 * as "not free", which is the pre-#1900 behaviour and the conservative answer
 * for the address opencode will actually take. The wildcard probes only ever
 * *veto*, and only on a code that names an occupant — a host without IPv6 must
 * not make every port in the range look taken.
 */
export async function isPortFree(port: number): Promise<boolean> {
  for (const [index, host] of OPENCODE_PORT_PROBE_HOSTS.entries()) {
    const probe = await probeBind(port, host);
    if (probe === 'free') continue;
    if (index === 0 || probe === 'in-use') {
      logger.debug('opencode-port-probe-occupied', { port, host, probe });
      return false;
    }
  }
  return true;
}

/**
 * Where a given instance starts scanning.
 *
 * FNV-1a over the composite key, so the same instance prefers the same port
 * across restarts and two instances rarely start at the same number. It is a
 * preference, not an identity: {@link allocateOpencodePort} scans forward and
 * the result is recorded, precisely because a hash can collide.
 */
export function derivePortStart(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return OPENCODE_PORT_RANGE.min + (hash % PORT_SPAN);
}

/** The candidate ports for one instance, in the order they are tried. */
export function opencodePortCandidates(target: AgentInstanceRef): number[] {
  const start = derivePortStart(keyOf(target));
  const candidates: number[] = [];
  for (let offset = 0; offset < PORT_SPAN; offset += 1) {
    candidates.push(
      OPENCODE_PORT_RANGE.min + ((start - OPENCODE_PORT_RANGE.min + offset) % PORT_SPAN)
    );
  }
  return candidates;
}

/**
 * Pick the port this instance's TUI will be launched on.
 *
 * Must be called *before* the launch command is built, because
 * `prepareLaunch` is synchronous and reads the result.
 *
 * @param target - The instance about to start
 * @param worktreePath - Recorded so a recovered entry can be checked
 * @returns The port, or null when structured events are switched off
 *   (`CM_AGENT_HOOKS_INJECT=0`) or every candidate is occupied — both of which
 *   mean "launch bare and let the scraper do it", never "fail to launch"
 */
export async function allocateOpencodePort(
  target: AgentInstanceRef,
  worktreePath: string
): Promise<number | null> {
  if (!isHookInjectionEnabled()) return null;

  const existing = getAssignedOpencodePort(target);
  if (existing !== null) return existing;

  const key = keyOf(target);
  const persisted = readPersistedOpencodePorts()[key];
  // A previous run's number first, so a pane restarted in place keeps its port
  // and anybody watching `lsof` sees a stable mapping.
  const preferred = persisted?.port;
  const candidates = opencodePortCandidates(target);
  const ordered =
    preferred !== undefined ? [preferred, ...candidates.filter((p) => p !== preferred)] : candidates;

  for (const port of ordered) {
    if (await isPortFree(port)) {
      rememberOpencodePort(target, port, worktreePath);
      logger.info('opencode-port-allocated', {
        worktreeId: target.worktreeId,
        instanceId: target.instanceId ?? target.cliToolId,
        port,
      });
      return port;
    }
  }

  logger.warn('opencode-port-exhausted', {
    worktreeId: target.worktreeId,
    instanceId: target.instanceId ?? target.cliToolId,
    range: `${OPENCODE_PORT_RANGE.min}-${OPENCODE_PORT_RANGE.max}`,
  });
  return null;
}

/**
 * Find the port of an instance that is already running.
 *
 * The CommandMate-restart path: the pane and its server survived, this process
 * did not. Recovery is a lookup plus a health check rather than a scan, so a
 * hash collision cannot make one instance adopt another's server.
 *
 * @param target - The instance whose pane is already alive
 * @param worktreePath - Rejects an entry recorded for a different worktree
 * @returns The port, or null when nothing verifiable is there
 */
export async function recoverOpencodePort(
  target: AgentInstanceRef,
  worktreePath: string
): Promise<number | null> {
  if (!isHookInjectionEnabled()) return null;

  const existing = getAssignedOpencodePort(target);
  if (existing !== null) return existing;

  const persisted = readPersistedOpencodePorts()[keyOf(target)];
  if (!persisted) return null;
  if (persisted.worktreePath !== worktreePath) {
    // The worktree was recreated under the same id at a different path, or the
    // file is from another machine's home directory. Either way the recorded
    // number says nothing about this instance.
    logger.info('opencode-port-recovery-path-mismatch', {
      worktreeId: target.worktreeId,
      recorded: persisted.worktreePath,
    });
    return null;
  }

  const health = await fetchOpencodeHealth(persisted.port);
  if (!health) {
    logger.info('opencode-port-recovery-unhealthy', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      port: persisted.port,
    });
    return null;
  }

  assignments.set(keyOf(target), persisted);
  logger.info('opencode-port-recovered', {
    worktreeId: target.worktreeId,
    instanceId: target.instanceId ?? target.cliToolId,
    port: persisted.port,
    version: health.version,
  });
  return persisted.port;
}

/** Drop every in-memory assignment. Test seam; production only ever forgets one. */
export function resetOpencodePortAssignments(): void {
  assignments.clear();
}
