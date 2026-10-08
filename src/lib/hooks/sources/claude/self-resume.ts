/**
 * Whether a Claude Code `Stop` leaves background work behind that will wake the
 * agent again (Issue #3430) — the Claude half of #2614.
 *
 * Claude Code ends a turn with work still running in two measured ways: a
 * `Bash` call that outlived its timeout (or was started with
 * `run_in_background`) and a `Monitor`. When that work finishes Claude queues a
 * `<task-notification>` and, if the session is idle, opens a new turn on it by
 * itself. Measured on 2026-10-08 (worktree commandmate-issue-3423): a worker
 * ended its turn at 23:37:53 "waiting for the related-tests run to finish",
 * `wait --verify` read that `Stop` as the end and verified an uncommitted
 * worktree, and the notification opened the turn that committed at 23:38:32.
 *
 * ## What is read, and why not the `Stop` payload
 *
 * The payload carries `background_tasks`, but only its empty form has ever been
 * captured (`tests/fixtures/hooks/claude/stop.json`), so its shape is a guess.
 * The transcript names the same work in structured fields, measured on the
 * transcripts under `~/.claude/projects` written in the four days to 2026-10-08:
 *
 *  - a background `Bash`: `toolUseResult.backgroundTaskId` (1,008 results);
 *  - a `Monitor`: `toolUseResult.taskId` beside a boolean `persistent`
 *    (115 results);
 *  - a background subagent: `toolUseResult.isAsync: true` and `agentId`
 *    (30 results);
 *  - a `TaskStop`: `toolUseResult.task_id` (39 results). A stopped task is never
 *    notified, so this is what retires it.
 *
 * and each finished task is retired by the notification Claude delivers for it:
 * a `type: "user"` prompt or a `queued_command` attachment whose text begins
 * with `<task-notification>` and carries `<task-id>…</task-id>` — the id above.
 * A notice that is only enqueued is not yet delivered, and the session will open
 * a turn on it, so its task still counts as pending.
 *
 * ## Erring towards "finished"
 *
 * Every doubt answers "nothing pending", which is what every Claude `Stop` meant
 * before this Issue: no transcript path, a path outside `~/.claude/projects`, a
 * file that cannot be read, a line that does not parse. A persistent `Monitor`
 * (a watch for the whole session, never notified on its own) is not counted
 * either. A task that really is never notified — a process that died with its
 * session — is bounded by `commandmate wait`'s `SELF_RESUME_HOLD_MS`.
 *
 * @module lib/hooks/sources/claude/self-resume
 */

import { closeSync, fstatSync, openSync, readSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { acceptPathUnderRoot } from '../transcript-history';
import { CLAUDE_TASK_NOTIFICATION_PREFIX } from './queued-notice';
import { CLAUDE_PROJECTS_DIR_SEGMENTS } from './transcript';

/** The `Stop` payload field naming the session's transcript. */
export const CLAUDE_TRANSCRIPT_PATH_FIELD = 'transcript_path';

/**
 * How much of the transcript's tail is read on a `Stop`.
 *
 * A task is started before it is notified, so a window that holds the start
 * holds the notification too; a start older than the window is simply not seen
 * (the "finished" direction). 4 MiB is `CLAUDE_TRANSCRIPT_TAIL_BYTES`, the first
 * read of `./history`, which holds 99% of turns whole (#2470).
 */
export const CLAUDE_SELF_RESUME_TAIL_BYTES = 4 * 1024 * 1024;

const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The background task a tool result started, or null. */
function startedTaskId(result: Record<string, unknown>): string | null {
  const bash = nonEmptyString(result.backgroundTaskId);
  if (bash) return bash;
  // Monitor. `persistent: true` watches for the life of the session and is not
  // work the turn is waiting on.
  const monitor = nonEmptyString(result.taskId);
  if (monitor && result.persistent === false) return monitor;
  const agent = nonEmptyString(result.agentId);
  if (agent && result.isAsync === true) return agent;
  return null;
}

/** The task a `<task-notification>` text retires, or null. */
function notifiedTaskId(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  if (!text.trimStart().startsWith(CLAUDE_TASK_NOTIFICATION_PREFIX)) return null;
  return TASK_ID_PATTERN.exec(text)?.[1] ?? null;
}

/** Every text a delivered `type: "user"` record carries. */
function userTexts(record: Record<string, unknown>): unknown[] {
  const message = record.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord).filter((b) => b.type === 'text').map((b) => b.text);
}

/**
 * The ids of background tasks started in `text` (transcript JSONL) and not yet
 * delivered a notification or stopped, in the order they were started.
 *
 * Pure. Lines that do not parse are skipped, as is everything a subagent wrote
 * into the parent's file (`isSidechain: true`).
 */
export function pendingClaudeBackgroundTasks(text: string): string[] {
  const started: string[] = [];
  const retired = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.isSidechain === true) continue;

    if (record.type === 'user') {
      const result = record.toolUseResult;
      if (isRecord(result)) {
        const id = startedTaskId(result);
        if (id) started.push(id);
        const stopped = nonEmptyString(result.task_id);
        if (stopped) retired.add(stopped);
      }
      for (const t of userTexts(record)) {
        const id = notifiedTaskId(t);
        if (id) retired.add(id);
      }
    } else if (record.type === 'attachment' && isRecord(record.attachment)) {
      if (record.attachment.type !== 'queued_command') continue;
      const id = notifiedTaskId(record.attachment.prompt);
      if (id) retired.add(id);
    }
  }
  return [...new Set(started)].filter((id) => !retired.has(id));
}

/**
 * The last `maxBytes` of a file, starting at a line boundary; null when it
 * cannot be read.
 */
function readTail(path: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const text = buffer.subarray(0, read).toString('utf8');
    // A window opened mid-file starts mid-line; that line is dropped.
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to do: the answer is already decided.
      }
    }
  }
}

/** What {@link claudeStopLeavesBackgroundWork} reads besides the payload. */
export interface ClaudeSelfResumeOptions {
  /** The home directory whose `.claude/projects` a transcript must be under. */
  homeDir?: string;
  tailBytes?: number;
}

/**
 * Whether this `Stop` payload's session still has background work that has not
 * been notified — i.e. whether Claude will open another turn by itself.
 *
 * Synchronous: it runs inside event normalization. `false` for every case it
 * cannot vouch for (see the module comment).
 */
export function claudeStopLeavesBackgroundWork(
  payload: Record<string, unknown>,
  options: ClaudeSelfResumeOptions = {}
): boolean {
  const hint = nonEmptyString(payload[CLAUDE_TRANSCRIPT_PATH_FIELD]);
  if (!hint) return false;
  const root = join(options.homeDir ?? homedir(), ...CLAUDE_PROJECTS_DIR_SEGMENTS);
  const path = acceptPathUnderRoot(root, '.jsonl', hint);
  if (!path) return false;
  const text = readTail(path, options.tailBytes ?? CLAUDE_SELF_RESUME_TAIL_BYTES);
  if (text === null) return false;
  return pendingClaudeBackgroundTasks(text).length > 0;
}
