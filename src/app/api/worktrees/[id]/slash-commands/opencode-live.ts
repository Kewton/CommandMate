/**
 * The opencode session's own command registry, cached off the hot path (Issue #2036)
 *
 * `GET /api/worktrees/[id]/slash-commands` must answer a palette keystroke, and
 * the bundled catalog cannot know about a project's `.opencode/commands/*.md` or
 * about the Skills opencode discovered. The live registry — `GET /command` on
 * the loopback server every opencode instance runs (#1758 §5.1.2) — does.
 *
 * ## Why this is a cache read plus a background refresh, never an await
 *
 * The #1913 follow-up (§4 D2, DR3-013) established the rule this file obeys: the
 * palette route reads a process cache and starts the probe *behind* the
 * response. Awaiting a request to a process CommandMate did not start puts that
 * process's latency — and its hangs — on a keystroke. It is the same shape as
 * `getCatalogStalenessSnapshot`, and for the same reason: an empty snapshot means
 * "not known yet", the catalog answers this open, and the live rows appear on the
 * next one.
 *
 * That staleness is not a compromise here, it is the truth of the source.
 * Measured on opencode 1.18.22: the server scans commands and Skills **once at
 * boot** and caches them. Planting `.opencode/commands/test.md` and re-reading
 * `GET /command` on the same process returns the old list; a restarted server
 * returns the new one. So there is no freshness to win by blocking.
 *
 * ## Which port
 *
 * The palette request carries a worktree and a `cliTool`, never an instance, so
 * every opencode instance recorded against this worktree's path is a candidate.
 * They are read out of the same assignments file `ports.ts` owns — in-memory
 * first (this process launched them), then the persisted map filtered by
 * `worktreePath`, which is how a CommandMate restart still finds a pane it did
 * not start. The first port that answers wins; the rest are not probed.
 *
 * Everything here is fail-soft. No port, a dead port, a squatter answering HTML,
 * a malformed body: all leave the cache empty and the palette on the catalog.
 */

import {
  fetchOpencodeLiveCommands,
  type OpencodeLiveCommand,
} from '@/lib/slash-command-reconcile/providers/opencode';
import {
  getAssignedOpencodePort,
  readPersistedOpencodePorts,
} from '@/lib/hooks/sources/opencode/ports';
import { OPENCODE_CLI_TOOL_ID } from '@/lib/hooks/sources/opencode/tool-id';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/slash-commands/opencode-live');

/**
 * How long a snapshot is served before a palette open starts a new probe.
 *
 * Sized against what actually changes it: the registry only moves when the
 * opencode process restarts, which is an operator action. A minute keeps a
 * relaunch visible within one or two palette opens without turning every open
 * into a loopback request.
 */
export const OPENCODE_LIVE_TTL_MS = 60_000;

/** Cap on ports probed in one refresh, so a stale assignments file cannot fan out. */
export const MAX_OPENCODE_LIVE_PORT_CANDIDATES = 8;

/** One worktree's cached registry. */
interface OpencodeLiveEntry {
  commands: OpencodeLiveCommand[];
  /** Epoch ms of the last completed refresh, successful or not. */
  refreshedAt: number;
  /** Whether a refresh is in flight, so palette opens do not stack probes. */
  refreshing: boolean;
}

/**
 * Cache reached through `globalThis`, for the reason `ports.ts` gives: under
 * `next dev` each route is bundled separately, so a module-scoped map would let
 * the refresh and the read hold different copies with no error anywhere.
 */
declare global {
  // eslint-disable-next-line no-var
  var __opencodeLiveCommandCache: Map<string, OpencodeLiveEntry> | undefined;
}

const cache = (globalThis.__opencodeLiveCommandCache ??= new Map<string, OpencodeLiveEntry>());

/** Clear the cache. Tests only. */
export function resetOpencodeLiveCommandCache(): void {
  cache.clear();
}

/**
 * The ports worth probing for this worktree, most likely first.
 *
 * In-memory assignments are tried before the persisted file because this
 * process allocated them and knows they are current; the file is the recovery
 * path for a pane that outlived a CommandMate restart. A persisted entry is only
 * taken when its recorded `worktreePath` matches — a port allocated for another
 * worktree belongs to another worktree's registry, and reading it would file one
 * project's commands under another's palette.
 */
export function opencodeLivePortCandidates(
  worktreeId: string,
  worktreePath: string
): number[] {
  const ports: number[] = [];
  const add = (port: number | null): void => {
    if (port === null || ports.includes(port)) return;
    if (ports.length >= MAX_OPENCODE_LIVE_PORT_CANDIDATES) return;
    ports.push(port);
  };

  add(getAssignedOpencodePort({ worktreeId, cliToolId: OPENCODE_CLI_TOOL_ID }));

  for (const assignment of Object.values(readPersistedOpencodePorts())) {
    if (assignment.worktreePath !== worktreePath) continue;
    add(assignment.port);
  }

  return ports;
}

/**
 * The rows last read for this worktree. Empty when nothing has been read yet.
 *
 * Synchronous and side-effect free: this is what the route calls on the hot
 * path.
 */
export function getOpencodeLiveCommands(worktreeId: string): OpencodeLiveCommand[] {
  return cache.get(worktreeId)?.commands ?? [];
}

/** Whether the snapshot is old enough to be worth re-probing. */
function isDue(entry: OpencodeLiveEntry | undefined, now: number): boolean {
  if (entry === undefined) return true;
  if (entry.refreshing) return false;
  return now - entry.refreshedAt >= OPENCODE_LIVE_TTL_MS;
}

/**
 * Probe the loopback registry and replace the snapshot. Never throws.
 *
 * Exported so a test can await the work the route deliberately does not.
 *
 * A failed probe still stamps `refreshedAt`: without that a worktree with no
 * opencode running would start a fresh probe on every single palette open. The
 * previous rows are kept on failure — a pane that is momentarily restarting
 * should not blank the palette.
 */
export async function refreshOpencodeLiveCommands(
  worktreeId: string,
  worktreePath: string,
  now: number = Date.now()
): Promise<OpencodeLiveCommand[]> {
  const previous = cache.get(worktreeId);
  cache.set(worktreeId, {
    commands: previous?.commands ?? [],
    refreshedAt: previous?.refreshedAt ?? 0,
    refreshing: true,
  });

  let commands = previous?.commands ?? [];
  try {
    for (const port of opencodeLivePortCandidates(worktreeId, worktreePath)) {
      const result = await fetchOpencodeLiveCommands({ port });
      if (result.ok) {
        commands = result.commands;
        break;
      }
      logger.debug('opencode-live-probe-failed', { port, warning: result.warning });
    }
  } catch (error) {
    // fetchOpencodeLiveCommands is already total; this is the belt for a caller
    // that hands in a hostile assignments file.
    logger.debug('opencode-live-refresh-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  cache.set(worktreeId, { commands, refreshedAt: now, refreshing: false });
  return commands;
}

/**
 * Start a refresh if one is due, and return immediately.
 *
 * The promise is deliberately dropped: nothing on the request path may wait for
 * it (see the module docblock). The `refreshing` flag is what keeps a burst of
 * palette opens from stacking probes on one port.
 */
export function scheduleOpencodeLiveRefresh(
  worktreeId: string,
  worktreePath: string,
  now: number = Date.now()
): void {
  if (!isDue(cache.get(worktreeId), now)) return;
  void refreshOpencodeLiveCommands(worktreeId, worktreePath, now).catch(() => {
    // refreshOpencodeLiveCommands never rejects; this only exists so an
    // unhandled rejection can never reach the process from a dropped promise.
  });
}
