/**
 * Per-instance port assignment for OpenCode V2 servers (Issue #2934, D4).
 *
 * The same idea as v1's `../opencode/ports` — a deterministic starting point per
 * instance, the first free port from there, an in-memory map for the running
 * process and a file so a restarted CommandMate can find a server that outlived
 * it — but its own range and its own file, so v1 is not touched:
 *
 *  - range {@link OPENCODE_V2_PORT_RANGE} (4300–4399) does not overlap v1's
 *    `OPENCODE_PORT_RANGE` (4200–4299). A v1 and a v2 instance of the same
 *    worktree therefore can never be handed the same port, whatever their
 *    hashes say;
 *  - the file is `ports.json` inside the OpenCode V2 state directory
 *    (`~/.commandmate/opencode-v2/`), next to the password files.
 *
 * The bind probe is v1's {@link isPortFree}, imported rather than copied: it is
 * a pure question about the machine ("can something bind here on every
 * address?") and has nothing v1-specific in it.
 *
 * @module lib/hooks/sources/opencode-v2/ports
 */

import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@/lib/logger';
import { isPortFree } from '../opencode/ports';
import type { AgentInstanceRef } from '../types';
import {
  ensureOpencodeV2StateDir,
  getOpencodeV2StateDir,
  opencodeV2KeyOf,
} from './secrets';

const logger = createLogger('lib/hooks/sources/opencode-v2/ports');

/** Ports OpenCode V2 servers are started on. Disjoint from v1's 4200–4299. */
export const OPENCODE_V2_PORT_RANGE = { min: 4300, max: 4399 } as const;

const PORT_SPAN = OPENCODE_V2_PORT_RANGE.max - OPENCODE_V2_PORT_RANGE.min + 1;

/** File name of the persisted assignments inside the state directory. */
export const OPENCODE_V2_PORT_FILE_NAME = 'ports.json';

/** One instance's assignment. */
export interface OpencodeV2PortAssignment {
  port: number;
  worktreePath: string;
  updatedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __opencodeV2PortAssignments: Map<string, OpencodeV2PortAssignment> | undefined;
}

const assignments = (globalThis.__opencodeV2PortAssignments ??= new Map<
  string,
  OpencodeV2PortAssignment
>());

/** Absolute path of the persisted assignments. */
export function getOpencodeV2PortFilePath(): string {
  return join(getOpencodeV2StateDir(), OPENCODE_V2_PORT_FILE_NAME);
}

function isAssignment(value: unknown): value is OpencodeV2PortAssignment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.port === 'number' &&
    Number.isInteger(record.port) &&
    record.port >= OPENCODE_V2_PORT_RANGE.min &&
    record.port <= OPENCODE_V2_PORT_RANGE.max &&
    typeof record.worktreePath === 'string'
  );
}

/** Every persisted assignment, keyed by composite key. Unreadable → empty. */
export function readPersistedOpencodeV2Ports(): Record<string, OpencodeV2PortAssignment> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getOpencodeV2PortFilePath(), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, OpencodeV2PortAssignment> = {};
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
    return {};
  }
}

function writePersistedOpencodeV2Ports(all: Record<string, OpencodeV2PortAssignment>): void {
  const path = getOpencodeV2PortFilePath();
  try {
    if (Object.keys(all).length === 0) {
      rmSync(path, { force: true });
      return;
    }
    ensureOpencodeV2StateDir();
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    logger.warn('opencode-v2-port-file-write-failed', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The port this process assigned to the instance, or null. */
export function getAssignedOpencodeV2Port(target: AgentInstanceRef): number | null {
  return assignments.get(opencodeV2KeyOf(target))?.port ?? null;
}

/** Record an assignment in memory and on disk. */
export function rememberOpencodeV2Port(
  target: AgentInstanceRef,
  port: number,
  worktreePath: string,
  at: number = Date.now()
): void {
  const key = opencodeV2KeyOf(target);
  const assignment: OpencodeV2PortAssignment = { port, worktreePath, updatedAt: at };
  assignments.set(key, assignment);
  const all = readPersistedOpencodeV2Ports();
  all[key] = assignment;
  writePersistedOpencodeV2Ports(all);
}

/** Drop an assignment from memory and from disk. */
export function forgetOpencodeV2Port(target: AgentInstanceRef): void {
  forgetOpencodeV2PortByKey(opencodeV2KeyOf(target));
}

/** {@link forgetOpencodeV2Port} by composite key (the startup sweep's form). */
export function forgetOpencodeV2PortByKey(key: string): void {
  assignments.delete(key);
  const all = readPersistedOpencodeV2Ports();
  if (key in all) {
    delete all[key];
    writePersistedOpencodeV2Ports(all);
  }
}

/**
 * First port tried for a key: FNV-1a of the key, folded into the range.
 *
 * The same hash v1 uses, over a different range, so instances spread out
 * instead of all contending for the range's first port.
 */
export function deriveOpencodeV2PortStart(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return OPENCODE_V2_PORT_RANGE.min + (hash % PORT_SPAN);
}

/** Every port in the range, starting at the instance's own start and wrapping. */
export function opencodeV2PortCandidates(target: AgentInstanceRef): number[] {
  const start = deriveOpencodeV2PortStart(opencodeV2KeyOf(target));
  const candidates: number[] = [];
  for (let offset = 0; offset < PORT_SPAN; offset += 1) {
    candidates.push(
      OPENCODE_V2_PORT_RANGE.min + ((start - OPENCODE_V2_PORT_RANGE.min + offset) % PORT_SPAN)
    );
  }
  return candidates;
}

/**
 * Assign a free port to the instance.
 *
 * Unlike v1 this is not optional: an OpenCode V2 pane without its own server
 * would fall back to the user's shared background service, which CommandMate
 * must not drive. So hook injection being off does not skip the allocation.
 * An already-held assignment is reused; a persisted one is preferred when its
 * port is free again.
 *
 * @returns The port, or null when the whole range is taken
 */
export async function allocateOpencodeV2Port(
  target: AgentInstanceRef,
  worktreePath: string,
  probe: (port: number) => Promise<boolean> = isPortFree
): Promise<number | null> {
  const existing = getAssignedOpencodeV2Port(target);
  if (existing !== null && (await probe(existing))) return existing;

  const key = opencodeV2KeyOf(target);
  const preferred = readPersistedOpencodeV2Ports()[key]?.port;
  const candidates = opencodeV2PortCandidates(target);
  const ordered =
    preferred !== undefined ? [preferred, ...candidates.filter((p) => p !== preferred)] : candidates;

  for (const port of ordered) {
    if (await probe(port)) {
      rememberOpencodeV2Port(target, port, worktreePath);
      logger.info('opencode-v2-port-allocated', {
        worktreeId: target.worktreeId,
        instanceId: target.instanceId ?? target.cliToolId,
        port,
      });
      return port;
    }
  }

  logger.warn('opencode-v2-port-exhausted', {
    worktreeId: target.worktreeId,
    instanceId: target.instanceId ?? target.cliToolId,
    range: `${OPENCODE_V2_PORT_RANGE.min}-${OPENCODE_V2_PORT_RANGE.max}`,
  });
  return null;
}

/**
 * Re-adopt a persisted assignment after a CommandMate restart.
 *
 * Adopted only when it was recorded for the same worktree path and `verify`
 * says the server on it is this instance's (it accepts the instance's
 * password). A port someone else took since is not re-adopted.
 *
 * @returns The recovered port, or null
 */
export async function recoverOpencodeV2Port(
  target: AgentInstanceRef,
  worktreePath: string,
  verify: (port: number) => Promise<boolean>
): Promise<number | null> {
  const existing = getAssignedOpencodeV2Port(target);
  if (existing !== null) return existing;

  const key = opencodeV2KeyOf(target);
  const persisted = readPersistedOpencodeV2Ports()[key];
  if (!persisted) return null;
  if (persisted.worktreePath !== worktreePath) {
    logger.info('opencode-v2-port-recovery-path-mismatch', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
    });
    return null;
  }
  if (!(await verify(persisted.port))) {
    logger.info('opencode-v2-port-recovery-unverified', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      port: persisted.port,
    });
    return null;
  }
  assignments.set(key, persisted);
  logger.info('opencode-v2-port-recovered', {
    worktreeId: target.worktreeId,
    instanceId: target.instanceId ?? target.cliToolId,
    port: persisted.port,
  });
  return persisted.port;
}

/** Forget every in-memory assignment. For tests. */
export function resetOpencodeV2PortAssignments(): void {
  assignments.clear();
}
