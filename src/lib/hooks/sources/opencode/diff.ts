/**
 * What one opencode turn changed on disk, and what a revert is holding back
 * (Issue #2043).
 *
 * ## The Issue's premise did not survive measurement
 *
 * Issue #2043 says to "hold `session.diff`" and show it as *this turn's changed
 * files*. Measured on opencode **1.18.22** in an isolated `HOME`
 * (`docs/design/opencode-server-live-verification.md` §16), that is not what the
 * frame carries. Two turns that between them created one file and modified
 * another produced **eight `session.diff` frames, every one with `diff: []`** —
 * including the frame emitted in the same millisecond as `session.idle`, after
 * both of the turn's `file.edited` frames. The frame only ever went non-empty
 * **after a `POST /session/:id/revert`**, and then it named exactly the files
 * that revert was holding back.
 *
 * So this module reads two different things from two different places:
 *
 *  - **the turn's files** — `GET /session/:id/diff?messageID=<user msg>`, which
 *    is the only call measured to answer them (the same route *without*
 *    `messageID` answered `[]` before and after the turn alike);
 *  - **what a revert holds back** — the `session.diff` frame, plus
 *    `session.updated`'s `Session.revert`, because a successful **unrevert emits
 *    no `session.diff` at all** and clearing the state on the frame alone would
 *    leave a pane reporting held-back work forever.
 *
 * ## Why this is not in `lib/hooks/agent-session-telemetry`
 *
 * #2040's and #2042's records live there and this one is their obvious
 * neighbour. It is here instead because Issue #2043's change scope does not
 * include that module, and because the split is defensible on its own terms:
 * everything there is a number read off a frame, and half of what is here is
 * the answer to a request this server chose to make.
 *
 * @module lib/hooks/sources/opencode/diff
 */

import { createLogger } from '@/lib/logger';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
import { OPENCODE_CLI_TOOL_ID } from './tool-id';
import { getAssignedOpencodePort } from './ports';
import {
  fetchOpencodeMessageDiff,
  readOpencodeFileDiffs,
  type OpencodeFileDiff,
} from './client';

const logger = createLogger('lib/hooks/sources/opencode/diff');

/** Cap on a stored session or message id, so a hostile frame cannot grow the map. */
const MAX_OPENCODE_DIFF_ID_LENGTH = 128;

/**
 * One instance's diff state.
 *
 * The two halves have deliberately separate timestamps. `at` moves whenever a
 * *frame* changed something, which is cheap and frequent; `filesAt` moves only
 * when a `GET /diff` actually answered, which is a request. A single timestamp
 * would make a stale file list look as fresh as the frame that arrived beside it.
 */
export interface OpencodeSessionDiffRecord {
  /** The session these facts belong to, or null. */
  sessionId: string | null;
  /** The user message whose turn {@link files} describes, or null. */
  turnMessageId: string | null;
  /** What that turn changed. Empty until a refresh has answered. */
  files: OpencodeFileDiff[];
  /** Epoch ms {@link files} was read at, or null when it never was. */
  filesAt: number | null;
  /** What a revert is currently holding back. Empty when nothing is. */
  revertedFiles: OpencodeFileDiff[];
  /** `Session.revert.messageID`, or null when nothing is held back. */
  revertedMessageId: string | null;
  /** Epoch ms the newest frame that touched this record arrived. */
  at: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __opencodeSessionDiff: Map<string, OpencodeSessionDiffRecord> | undefined;
  // eslint-disable-next-line no-var
  var __opencodeSessionDiffRefreshes: Set<string> | undefined;
}

/** compositeKey -> that instance's diff state. */
const records = globalThis.__opencodeSessionDiff ??
  (globalThis.__opencodeSessionDiff = new Map<string, OpencodeSessionDiffRecord>());

/** Keys with a `GET /diff` in flight, so a poll storm makes one request. */
const refreshing = globalThis.__opencodeSessionDiffRefreshes ??
  (globalThis.__opencodeSessionDiffRefreshes = new Set<string>());

function keyOf(target: AgentInstanceRef): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

function blankRecord(at: number): OpencodeSessionDiffRecord {
  return {
    sessionId: null,
    turnMessageId: null,
    files: [],
    filesAt: null,
    revertedFiles: [],
    revertedMessageId: null,
    at,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A bounded non-empty string, or null. */
function readId(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, MAX_OPENCODE_DIFF_ID_LENGTH);
}

/**
 * What a frame said about the revert state, or null when it said nothing.
 *
 * Split out because two frame types answer it and they answer different halves:
 * `session.diff` carries the files and no message id, `session.updated` carries
 * the message id and no files. Neither alone is the whole state, and the
 * unrevert case is only visible on the second — measured: a successful unrevert
 * emitted **one `session.updated` with `revert: null` and no `session.diff`**.
 */
export function readOpencodeRevertState(
  frame: Record<string, unknown>
):
  | { kind: 'files'; sessionId: string | null; files: OpencodeFileDiff[] }
  | { kind: 'held'; sessionId: string | null; messageId: string | null }
  | null {
  const type = frame.type;
  const properties = isPlainObject(frame.properties) ? frame.properties : null;
  if (!properties) return null;

  if (type === 'session.diff') {
    return {
      kind: 'files',
      sessionId: readId(properties, 'sessionID'),
      files: readOpencodeFileDiffs(properties.diff),
    };
  }

  if (type === 'session.updated') {
    const info = isPlainObject(properties.info) ? properties.info : null;
    if (!info) return null;
    // The same sub-agent rule #2040 applies, and for the same reason: a `task`
    // tool's child session has its own revert state, and adopting it would make
    // the panel offer to undo a background job the operator never started.
    if (typeof info.parentID === 'string' && info.parentID.length > 0) return null;
    const revert = isPlainObject(info.revert) ? info.revert : null;
    return {
      kind: 'held',
      sessionId: readId(info, 'id'),
      messageId: revert ? readId(revert, 'messageID') : null,
    };
  }

  return null;
}

/**
 * The user message that opened a turn, or null.
 *
 * `message.updated` with `info.role === 'user'`. This is the only free source of
 * the id `GET /session/:id/diff` needs: a prompt CommandMate sent has an id it
 * generated (#2035), but one the operator typed into the TUI does not, and the
 * panel has to work for both.
 *
 * opencode re-sends the boundary `message.updated` for the *same* user message
 * several times per turn (measured: five times across one turn), so this is
 * expected to be idempotent rather than deduplicated.
 */
export function readOpencodeUserMessageFrame(
  frame: Record<string, unknown>
): { sessionId: string | null; messageId: string } | null {
  if (frame.type !== 'message.updated') return null;
  const properties = isPlainObject(frame.properties) ? frame.properties : null;
  const info = properties && isPlainObject(properties.info) ? properties.info : null;
  if (!info || info.role !== 'user') return null;
  const messageId = readId(info, 'id');
  if (!messageId) return null;
  return { sessionId: readId(info, 'sessionID'), messageId };
}

/**
 * Fold one frame into this instance's diff state (Issue #2043).
 *
 * Called from `./subscription`'s `deliver` as one independent block, before the
 * mapping — `session.diff` maps to none of the seven event words, so a fact only
 * it carries would be lost between `normalize` and the `return` below it.
 *
 * @param target - The instance the frame belongs to
 * @param frame - The raw `{ id, type, properties }` frame
 * @param receivedAt - Epoch ms
 */
export function recordOpencodeDiffFrame(
  target: AgentInstanceRef,
  frame: Record<string, unknown>,
  receivedAt: number
): void {
  const key = keyOf(target);
  const current = records.get(key) ?? blankRecord(receivedAt);

  const user = readOpencodeUserMessageFrame(frame);
  if (user) {
    if (user.messageId === current.turnMessageId) return;
    records.set(key, {
      ...current,
      sessionId: user.sessionId ?? current.sessionId,
      turnMessageId: user.messageId,
      // The previous turn's files describe the previous turn. Dropped rather
      // than kept until the refresh answers, so the panel is never a new turn's
      // heading over an old turn's file list.
      files: [],
      filesAt: null,
      at: receivedAt,
    });
    return;
  }

  const revert = readOpencodeRevertState(frame);
  if (!revert) return;

  if (revert.kind === 'files') {
    records.set(key, {
      ...current,
      sessionId: revert.sessionId ?? current.sessionId,
      revertedFiles: revert.files,
      at: receivedAt,
    });
    return;
  }

  records.set(key, {
    ...current,
    sessionId: revert.sessionId ?? current.sessionId,
    revertedMessageId: revert.messageId,
    // An unrevert clears the held-back files and emits no `session.diff` to say
    // so. Clearing them here is the only thing that ever does.
    revertedFiles: revert.messageId === null ? [] : current.revertedFiles,
    at: receivedAt,
  });
}

/** @returns This instance's diff state, or null when no frame has produced one. */
export function getOpencodeSessionDiff(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): OpencodeSessionDiffRecord | null {
  if (cliToolId !== OPENCODE_CLI_TOOL_ID) return null;
  return records.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/** Drop one instance's record. Called when its subscription closes. */
export function forgetOpencodeSessionDiff(target: AgentInstanceRef): void {
  const key = keyOf(target);
  records.delete(key);
  refreshing.delete(key);
}

/** Drop every record. Test seam. */
export function resetOpencodeSessionDiff(): void {
  records.clear();
  refreshing.clear();
}

/**
 * Answer from the cache, and start a refresh only when the turn moved.
 *
 * The same trade #2042's `ensureAgentSessionContextUsage` makes, for the same
 * reason: this is called from the status poll, which runs every couple of
 * seconds for every visible pane, and the fact it needs costs an HTTP round
 * trip. Awaiting it would put that request in front of every poll; instead the
 * poll answers with what is known and the request lands in a later one.
 *
 * The refresh fires when {@link OpencodeSessionDiffRecord.turnMessageId} has
 * moved since the last answer — i.e. once per **turn** — and never while one is
 * already in flight.
 *
 * @param target - The instance being polled
 * @returns The record as it stands right now, or null
 */
export function ensureOpencodeSessionDiff(
  target: AgentInstanceRef
): OpencodeSessionDiffRecord | null {
  if (target.cliToolId !== OPENCODE_CLI_TOOL_ID) return null;
  const key = keyOf(target);
  const record = records.get(key);
  if (!record) return null;
  if (record.filesAt !== null) return record;
  if (record.sessionId === null || record.turnMessageId === null) return record;
  if (refreshing.has(key)) return record;

  const port = getAssignedOpencodePort(target);
  if (port === null) return record;

  refreshing.add(key);
  void refreshOpencodeTurnDiff(target, port, record.sessionId, record.turnMessageId).finally(
    () => {
      refreshing.delete(key);
    }
  );
  return record;
}

/**
 * Re-read one turn's files from the agent and store them.
 *
 * Exported because the revert route calls it directly: a revert changes what
 * the working tree holds, and waiting for the next poll's `ensure…` would show
 * the operator a panel that still describes the state they just undid.
 *
 * The write is guarded on the turn not having moved underneath it. A turn that
 * started while the request was in flight has already reset `files` to empty,
 * and storing the old answer over it would attribute the previous turn's files
 * to the new one.
 *
 * @returns The files stored, or null when the server could not be asked
 */
export async function refreshOpencodeTurnDiff(
  target: AgentInstanceRef,
  port: number,
  sessionId: string,
  messageId: string
): Promise<OpencodeFileDiff[] | null> {
  const files = await fetchOpencodeMessageDiff(port, sessionId, messageId);
  if (files === null) {
    logger.debug('opencode-turn-diff-unavailable', {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      sessionId,
    });
    return null;
  }

  const key = keyOf(target);
  const current = records.get(key);
  if (!current || current.turnMessageId !== messageId) return files;
  records.set(key, { ...current, files, filesAt: Date.now() });
  return files;
}

/**
 * Re-read the *reverted* diff from the agent (Issue #2043).
 *
 * `session.diff` is the ordinary carrier of this and it arrives on its own. This
 * exists for the one measured case where it does not: a successful **unrevert
 * emits no `session.diff`**, so the route that performs one updates the record
 * itself rather than leaving the panel to wait for a frame that never comes.
 */
export function recordOpencodeRevertResult(
  target: AgentInstanceRef,
  revertedMessageId: string | null,
  revertedFiles: OpencodeFileDiff[]
): void {
  const key = keyOf(target);
  const now = Date.now();
  const current = records.get(key) ?? blankRecord(now);
  records.set(key, { ...current, revertedMessageId, revertedFiles, at: now });
}

/**
 * How many files opencode says this instance touched, for `work-evidence`.
 *
 * The count is the turn's files plus whatever a revert is holding back, and the
 * second half is the reason this exists at all: **the revert button #2043 adds
 * is itself able to make a worktree look untouched to git.** A turn that changed
 * three files and was then reverted leaves a tree git may call clean while
 * opencode still names all three.
 *
 * Measured limits, so nobody reads more into this than it can carry: opencode's
 * ledger is git snapshots, so it shares git's blind spots. A file matched by
 * `.gitignore` that the agent created was invisible to `git status` **and**
 * answered `[]` from `GET /session/:id/diff` (§16.6). This corroborates git; it
 * does not see past it.
 *
 * @returns The file count, or null when opencode has said nothing about this
 *   instance — which is every non-opencode instance and every opencode pane
 *   whose stream never reported a session.
 */
export function opencodeWorkEvidenceFileCount(
  worktreeId: string,
  instanceId?: string
): number | null {
  const record = getOpencodeSessionDiff(worktreeId, OPENCODE_CLI_TOOL_ID, instanceId);
  if (!record) return null;
  const names = new Set<string>();
  for (const entry of [...record.files, ...record.revertedFiles]) {
    if (entry.file !== null) names.add(entry.file);
  }
  // A diff entry with no `file` is still a change opencode is reporting; it just
  // cannot be de-duplicated by name. Counted separately so an unnamed entry is
  // never silently dropped from the evidence.
  const unnamed = [...record.files, ...record.revertedFiles].filter((e) => e.file === null).length;
  return names.size + unnamed;
}
