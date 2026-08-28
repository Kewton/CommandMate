/**
 * The last opencode session an instance was in, so a relaunch can resume it
 * (Issue #2038).
 *
 * opencode is the one supported agent whose conversation is addressable from
 * the command line: `opencode -s <id>` continues a session, `-c` continues the
 * last one and `--fork` branches it (measured on 1.18.22 — the three flags are
 * in `--help`). CommandMate has always known the id — the turn gate reads
 * `properties.sessionID` off every frame — and has always thrown it away, so a
 * `kill-session` followed by a `send` came back on opencode's home screen with
 * the previous conversation unreachable from CommandMate.
 *
 * ## Why a JSON file rather than the database
 *
 * The Issue left the choice open ("`~/.commandmate/opencode-ports.json` と同様の
 * store か DB"). Three properties of the read decide it, and all three are the
 * same ones `../hooks/sources/opencode/ports.ts` records for the *port*:
 *
 *  1. **The reader is the launcher.** `src/lib/cli-tools/opencode.ts` composes
 *     the launch command line, and that module is deliberately outside the
 *     database's import graph — `./ingest` goes as far as `await import`-ing
 *     `@/lib/db` at event time precisely so `better-sqlite3` does not become a
 *     dependency of every import of `@/lib/hooks/sources`. Putting the id in
 *     the DB would either pull that graph into the launcher or force the launch
 *     path to become asynchronous around a dynamic import, for one string.
 *  2. **It is machine-local runtime state about a process, not project data.**
 *     A session id means nothing on another machine or under another `HOME`,
 *     which is exactly the argument `ports.ts` makes for its own file. The
 *     database holds what a worktree *is*; this holds what a pane *was doing*.
 *  3. **It has to outlive the port assignment.** `releaseOpencodeEventStream`
 *     calls `forgetOpencodePort` when the pane is killed, so the entry in
 *     `opencode-ports.json` is deleted at the exact moment this value becomes
 *     interesting. Storing the id as a field on that entry would delete it
 *     together with the port; a separate file is what lets the memory survive
 *     the kill it exists to survive.
 *
 * So: same shape as `ports.ts`, same `~/.commandmate` directory, same
 * "never throws, a bad file means none" contract, separate lifetime.
 *
 * ## The worktree guard
 *
 * An entry is only usable when the worktree it was recorded for is the worktree
 * being launched, which is `recoverOpencodePort`'s rule applied to a different
 * value. It is not paranoia: sessions belong to opencode's own database rather
 * than to a server, so one `HOME` holds every worktree's sessions at once —
 * measured on 1.18.22, `GET /session` on a server started in directory A
 * returned directory B's sessions too, both under `projectID: "global"`. A
 * mismatched entry (a worktree id reused at a new path, a home directory copied
 * between machines) would therefore resume a *different repository's*
 * conversation into this pane, and opencode would accept it.
 *
 * The recorded path is opencode's own `Session.directory`, read back from the
 * server before the entry is written (see `./opencode-session-recall`), so the
 * two sides of the comparison are the agent's answer and CommandMate's, not two
 * copies of CommandMate's.
 *
 * @module lib/session/opencode-session-store
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { resolveSafeDirectory } from '@/config/safe-directory';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { createLogger } from '@/lib/logger';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const logger = createLogger('lib/session/opencode-session-store');

/**
 * What an opencode session id looks like.
 *
 * `^ses` is the server's own declared pattern (`GET /doc`, 1.18.22, every
 * `sessionID` path parameter). The rest of the class is tightened to
 * alphanumerics because this string is interpolated into a **shell command
 * line** by {@link withOpencodeResumedSession}: a value that reached the pane
 * with a space or a quote in it would be a command injection into the operator's
 * own terminal, and the persisted file is writable by anything running as the
 * user. Anything that does not match is refused rather than escaped, because
 * there is no legitimate id this rejects.
 */
export const OPENCODE_SESSION_ID_PATTERN = /^ses[A-Za-z0-9_-]{1,128}$/;

/** Whether a string is usable as an opencode session id. */
export function isOpencodeSessionId(value: unknown): value is string {
  return typeof value === 'string' && OPENCODE_SESSION_ID_PATTERN.test(value);
}

/** Longest title kept. Display only; opencode's own titles are one line. */
export const MAX_OPENCODE_SESSION_TITLE_LENGTH = 200;

/** One instance's last known session. */
export interface OpencodeSessionMemory {
  /** opencode's `Session.id`. */
  sessionId: string;
  /** opencode's `Session.title`, or null when the server did not say. */
  title: string | null;
  /**
   * opencode's `Session.directory` for that session.
   *
   * The Issue's "sessionID が worktree の `directory` と一致しない場合は使わない",
   * stored so the comparison can still be made when the server that could
   * answer it is gone — which is every relaunch.
   */
  worktreePath: string;
  /** Epoch ms, for diagnosing a file nobody cleaned up. */
  updatedAt: number;
}

/**
 * Memories for this process, reached through `globalThis`.
 *
 * The same reason every shared map in this codebase is (Issue #1736): under
 * `next dev` each route is bundled separately, so a module-scoped map would let
 * the launcher and the API route hold different copies.
 */
declare global {
  // eslint-disable-next-line no-var
  var __opencodeSessionMemories: Map<string, OpencodeSessionMemory> | undefined;
}

const memories = (globalThis.__opencodeSessionMemories ??= new Map<
  string,
  OpencodeSessionMemory
>());

function keyOf(target: AgentInstanceRef): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

/**
 * Where the memories are persisted. `CM_OPENCODE_SESSION_FILE` overrides.
 *
 * Guarded exactly as `getOpencodePortFilePath` is (Issue #1774): the write below
 * creates this file's directory with a recursive mkdir, and for a path inside
 * `/proc`, `/sys` or `/dev` that call does not throw — it spins the event loop
 * forever, so the `try/catch` around it never runs. `resolveSafeDirectory`
 * refuses such an override and hands back the default.
 */
export function getOpencodeSessionFilePath(): string {
  const fallback = join(homedir(), '.commandmate', 'opencode-sessions.json');
  return resolveSafeDirectory(
    process.env.CM_OPENCODE_SESSION_FILE,
    fallback,
    'CM_OPENCODE_SESSION_FILE'
  );
}

function isMemory(value: unknown): value is OpencodeSessionMemory {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isOpencodeSessionId(record.sessionId) &&
    typeof record.worktreePath === 'string' &&
    record.worktreePath.length > 0
  );
}

/** Read the persisted memories. Never throws — a bad file means "none". */
export function readPersistedOpencodeSessions(): Record<string, OpencodeSessionMemory> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getOpencodeSessionFilePath(), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, OpencodeSessionMemory> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isMemory(value)) continue;
      result[key] = {
        sessionId: value.sessionId,
        title: typeof value.title === 'string' ? value.title : null,
        worktreePath: value.worktreePath,
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
      };
    }
    return result;
  } catch {
    // Absent on a first run, unreadable if somebody edited it. Both mean the
    // same thing to a caller: nothing to resume.
    return {};
  }
}

/** Write the memories back. Never throws — losing the file costs one resume. */
function writePersistedOpencodeSessions(all: Record<string, OpencodeSessionMemory>): void {
  const path = getOpencodeSessionFilePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    logger.warn('opencode-session-file-write-failed', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Record what this instance was last talking to.
 *
 * @param target - The instance
 * @param memory - Session id, title and the directory opencode reported for it
 * @returns Whether anything was written — false for an id this module refuses
 */
export function rememberOpencodeSession(
  target: AgentInstanceRef,
  memory: { sessionId: string; title?: string | null; worktreePath: string },
  at: number = Date.now()
): boolean {
  if (!isOpencodeSessionId(memory.sessionId)) {
    logger.warn('opencode-session-id-rejected', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
    });
    return false;
  }
  if (memory.worktreePath.length === 0) return false;

  const entry: OpencodeSessionMemory = {
    sessionId: memory.sessionId,
    title:
      typeof memory.title === 'string'
        ? memory.title.slice(0, MAX_OPENCODE_SESSION_TITLE_LENGTH)
        : null,
    worktreePath: memory.worktreePath,
    updatedAt: at,
  };
  const key = keyOf(target);
  memories.set(key, entry);
  const all = readPersistedOpencodeSessions();
  all[key] = entry;
  writePersistedOpencodeSessions(all);
  return true;
}

/** What is remembered for this instance, from memory or from disk. */
export function getRememberedOpencodeSession(
  target: AgentInstanceRef
): OpencodeSessionMemory | null {
  const key = keyOf(target);
  const live = memories.get(key);
  if (live) return live;
  const persisted = readPersistedOpencodeSessions()[key];
  if (!persisted) return null;
  memories.set(key, persisted);
  return persisted;
}

/**
 * Forget this instance's session.
 *
 * Called when the operator deliberately starts a new one: resuming the session
 * they just walked away from on the next launch would undo the thing they asked
 * for.
 */
export function forgetOpencodeSession(target: AgentInstanceRef): void {
  const key = keyOf(target);
  memories.delete(key);
  const all = readPersistedOpencodeSessions();
  if (key in all) {
    delete all[key];
    writePersistedOpencodeSessions(all);
  }
}

/**
 * The session id this instance may resume in this worktree, or null.
 *
 * The whole of the acceptance condition "別 worktree に紐づく sessionID は復元に
 * 使われない". A mismatch is logged rather than repaired: the recorded path is
 * what opencode itself said the session lived in, so a difference is a fact
 * about the session, not a normalisation problem.
 *
 * @param target - The instance about to be launched
 * @param worktreePath - The directory the pane will be created in
 */
export function recoverOpencodeSessionId(
  target: AgentInstanceRef,
  worktreePath: string
): string | null {
  const memory = getRememberedOpencodeSession(target);
  if (!memory) return null;
  if (memory.worktreePath !== worktreePath) {
    logger.info('opencode-session-recovery-path-mismatch', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      recorded: memory.worktreePath,
    });
    return null;
  }
  if (!isOpencodeSessionId(memory.sessionId)) return null;
  return memory.sessionId;
}

/**
 * Add opencode's resume flag to a launch command line.
 *
 * `-s <id>` rather than `-c`: `--continue` means "the last session in this
 * directory", which on a worktree running two opencode instances is whichever
 * of them spoke most recently — the two panes would fight over one conversation.
 * The id is the only spelling that names the instance's own session.
 *
 * Deliberately a string append rather than a change to `prepareOpencodeLaunch`:
 * the resume flag depends on state (what this instance was doing last time)
 * that the launch *plan* has no business knowing, and every other tool's plan
 * must come out byte-for-byte unchanged (#2038's third acceptance condition).
 *
 * @param commandLine - The rendered launch line, environment prefix included
 * @param sessionId - The session to continue
 * @returns The line with `-s <id>` appended, or the line untouched when the id
 *   is not one this module will put in front of a shell
 */
export function withOpencodeResumedSession(commandLine: string, sessionId: string): string {
  if (!isOpencodeSessionId(sessionId)) return commandLine;
  return `${commandLine} -s ${sessionId}`;
}

/** Drop every in-memory entry. Test seam; production only ever forgets one. */
export function resetOpencodeSessionMemories(): void {
  memories.clear();
}
