/**
 * The OpenCode V2 instance's commands and Skills, cached off the hot path
 * (Issue #2944)
 *
 * The v2 counterpart of `./opencode-live` (#2036), and it obeys the same rule
 * for the same reason: the palette route reads a process cache and starts the
 * probe *behind* the response (#1913 §4 D2). An empty snapshot means "not known
 * yet" — the catalog answers this open and the live rows appear on the next.
 *
 * What differs from v1:
 *
 *  - **where the server is.** Every v2 instance runs its own
 *    `opencode2 serve` on a port from `ports.ts` (4300–4399), with a password
 *    from `secrets.ts`. The palette request names a worktree, never an
 *    instance, so the candidates are this process's default-instance
 *    assignment first and then every persisted assignment recorded for this
 *    worktree's path, each with the password filed under the same composite
 *    key. Any live one will do: instances of one worktree are one project.
 *  - **a cold server answers an empty command list.** Measured on 2.0.18: the
 *    scan is lazy, and `/api/command` right after boot is `data: []`. Such a
 *    read is kept (its Skills are real) but not stamped as fresh, so the next
 *    palette open probes again instead of serving the cold list for a minute.
 *
 * Everything here is fail-soft: no port, no password file, a 401, a squatter —
 * all leave the palette on the catalog and the disk Skill scan.
 */

import {
  fetchOpencodeV2LiveCommands,
} from '@/lib/hooks/sources/opencode-v2/commands';
import {
  getAssignedOpencodeV2Port,
  readPersistedOpencodeV2Ports,
} from '@/lib/hooks/sources/opencode-v2/ports';
import {
  opencodeV2KeyOf,
  readOpencodeV2PasswordByKey,
} from '@/lib/hooks/sources/opencode-v2/secrets';
import { OPENCODE_V2_CLI_TOOL_ID } from '@/lib/hooks/sources/opencode-v2/tool-id';
import type { OpencodeLiveCommand } from '@/lib/slash-command-reconcile/providers/opencode';
import { createLogger } from '@/lib/logger';
import { MAX_OPENCODE_LIVE_PORT_CANDIDATES, OPENCODE_LIVE_TTL_MS } from './opencode-live';

const logger = createLogger('api/slash-commands/opencode-v2-live');

/** One server worth probing: its port and the composite key its password is filed under. */
export interface OpencodeV2LiveCandidate {
  port: number;
  key: string;
}

interface OpencodeV2LiveEntry {
  commands: OpencodeLiveCommand[];
  /** Epoch ms of the last completed refresh, successful or not. */
  refreshedAt: number;
  /** False after a cold read: the next palette open probes again, TTL or not. */
  complete: boolean;
  refreshing: boolean;
}

/** Reached through `globalThis` for the reason `./opencode-live` gives (`next dev` bundles routes separately). */
declare global {
  // eslint-disable-next-line no-var
  var __opencodeV2LiveCommandCache: Map<string, OpencodeV2LiveEntry> | undefined;
}

const cache = (globalThis.__opencodeV2LiveCommandCache ??= new Map<string, OpencodeV2LiveEntry>());

/** Clear the cache. Tests only. */
export function resetOpencodeV2LiveCommandCache(): void {
  cache.clear();
}

/**
 * The servers worth probing for this worktree, most likely first.
 *
 * A persisted entry is taken only when its `worktreePath` matches: another
 * worktree's server would file another project's commands under this palette.
 */
export function opencodeV2LiveCandidates(
  worktreeId: string,
  worktreePath: string
): OpencodeV2LiveCandidate[] {
  const candidates: OpencodeV2LiveCandidate[] = [];
  const add = (port: number | null, key: string): void => {
    if (port === null || candidates.some((c) => c.port === port)) return;
    if (candidates.length >= MAX_OPENCODE_LIVE_PORT_CANDIDATES) return;
    candidates.push({ port, key });
  };

  const target = { worktreeId, cliToolId: OPENCODE_V2_CLI_TOOL_ID };
  add(getAssignedOpencodeV2Port(target), opencodeV2KeyOf(target));

  for (const [key, assignment] of Object.entries(readPersistedOpencodeV2Ports())) {
    if (assignment.worktreePath !== worktreePath) continue;
    add(assignment.port, key);
  }
  return candidates;
}

/** The rows last read for this worktree. Synchronous; empty when nothing has been read. */
export function getOpencodeV2LiveCommands(worktreeId: string): OpencodeLiveCommand[] {
  return cache.get(worktreeId)?.commands ?? [];
}

function isDue(entry: OpencodeV2LiveEntry | undefined, now: number): boolean {
  if (entry === undefined) return true;
  if (entry.refreshing) return false;
  if (!entry.complete) return true;
  return now - entry.refreshedAt >= OPENCODE_LIVE_TTL_MS;
}

/**
 * Probe the candidates and replace the snapshot. Never throws.
 *
 * Exported so a test can await what the route does not. A failed probe keeps
 * the previous rows and still stamps `refreshedAt` (so a worktree with no v2
 * running is not dialled on every open); a cold read (`complete: false`) stores
 * its rows but is marked incomplete, so the next open probes again. So does a
 * worktree with no candidate at all — re-reading the assignments costs no
 * network, and it is what lets a just-launched instance show up at once.
 */
export async function refreshOpencodeV2LiveCommands(
  worktreeId: string,
  worktreePath: string,
  now: number = Date.now()
): Promise<OpencodeLiveCommand[]> {
  const previous = cache.get(worktreeId);
  cache.set(worktreeId, {
    commands: previous?.commands ?? [],
    refreshedAt: previous?.refreshedAt ?? 0,
    complete: previous?.complete ?? true,
    refreshing: true,
  });

  let commands = previous?.commands ?? [];
  let complete = true;
  try {
    const candidates = opencodeV2LiveCandidates(worktreeId, worktreePath);
    // Nothing to dial is a local fact (two file reads), not a network answer:
    // keep asking on every open, so the first palette opened after an instance
    // launches shows its commands instead of waiting out the TTL (measured in
    // the #2944 run: a palette opened before the launch hid them for a minute).
    if (candidates.length === 0) complete = false;
    for (const candidate of candidates) {
      const password = readOpencodeV2PasswordByKey(candidate.key);
      if (password === null) continue;
      const result = await fetchOpencodeV2LiveCommands({
        port: candidate.port,
        password,
        directory: worktreePath,
      });
      if (result.ok) {
        commands = result.commands;
        complete = result.complete;
        break;
      }
      logger.debug('opencode-v2-live-probe-failed', { port: candidate.port, warning: result.warning });
    }
  } catch (error) {
    logger.debug('opencode-v2-live-refresh-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  cache.set(worktreeId, { commands, refreshedAt: now, complete, refreshing: false });
  return commands;
}

/** Start a refresh if one is due, and return immediately (the promise is dropped on purpose). */
export function scheduleOpencodeV2LiveRefresh(
  worktreeId: string,
  worktreePath: string,
  now: number = Date.now()
): void {
  if (!isDue(cache.get(worktreeId), now)) return;
  void refreshOpencodeV2LiveCommands(worktreeId, worktreePath, now).catch(() => {
    // Never rejects; this only keeps a dropped promise from surfacing as unhandled.
  });
}
