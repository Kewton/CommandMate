/**
 * Whether the agent itself reported a sent prompt (Issue #4035).
 *
 * The submit-verified sender decides "the message left the composer" from the
 * screen. Two of its rules say only that the body is NOT in the composer — B
 * (no composer, or an empty one) and F (other text, such as claude's dim
 * `Try "…"` placeholder) — and right after a claude session starts that is not
 * the same thing: measured on Claude Code 2.1.314 (`tests/fixtures/claude-first-send-4035/`),
 * keys typed in the first second after the prompt appeared were drawn into the
 * composer ~1.7 s later, the Enter typed after them was lost, and the frame
 * read after the Enter still showed the idle placeholder, so F answered
 * `submitted` for a body that sat unsent until the next send threw it away.
 *
 * Claude reports every submitted prompt with its `UserPromptSubmit` hook. This
 * module keeps, per tmux session this server started, when that hook last
 * arrived, so the sender can ask for it before trusting B or F on the
 * session's first prompt ({@link readPromptSubmitReceipt}). It also keeps a
 * fingerprint (digests, never the text) of the last body the sender reported
 * submitted, so a later send that has to clear that very body out of the
 * composer can say so ({@link matchesSubmittedBody}).
 *
 * In memory on `globalThis`, like the other per-session state; a session this
 * server did not start (one adopted after a restart) has no entry, and every
 * question about it is answered "not required", i.e. exactly as before.
 *
 * @module lib/session/prompt-submit-receipt
 */

import { createHash } from 'crypto';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { getOrInitGlobal } from '@/lib/global-state';
import { sendMessageDigest } from '@/lib/session/send-attempt-state';

/** How many sessions are tracked at once; the least recently started is forgotten first. */
const MAX_TRACKED_SESSIONS = 1024;

/**
 * Compacted characters a body's prefix fingerprint covers. A composer read is
 * cut by the reader, so a long body is recognised by its beginning.
 */
const BODY_PREFIX_CHARS = 64;

/** The instance a tmux session runs. */
export interface PromptSubmitTarget {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Undefined for the primary instance. */
  instanceId?: string;
}

interface SessionEntry {
  target: PromptSubmitTarget;
  /** Epoch ms the session's generation began on this server. */
  startedAt: number;
  /** Epoch ms of the last hook of any kind for this instance, or null. */
  lastEventAt: number | null;
  /** Epoch ms of the last `user_prompt_submit` for this instance, or null. */
  lastPromptAt: number | null;
  /**
   * The last body the sender reported submitted from the screen alone, as
   * digests. `messageDigest` is the attempt's own digest of the body as sent
   * (`sendMessageDigest`, uncompacted), which ties a match to the one `lastSend`
   * record it may demote (Issue #4048). Cleared when the agent reports a prompt.
   */
  submittedBody: { full: string; prefix: string | null; messageDigest: string } | null;
}

/**
 * The instance a send says it is for (Issue #4048), given alongside the session
 * name. The tool is the send's own `cliToolId`.
 */
export interface PromptSubmitExpected {
  worktreeId: string;
  /** Undefined (or the tool id) for the primary instance. */
  instanceId?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __promptSubmitSessions: Map<string, SessionEntry> | undefined;
  // eslint-disable-next-line no-var
  var __promptSubmitSessionByInstance: Map<string, string> | undefined;
}

const sessions = getOrInitGlobal('__promptSubmitSessions', () => new Map<string, SessionEntry>());
const sessionByInstance = getOrInitGlobal('__promptSubmitSessionByInstance', () => new Map<string, string>());

function instanceKey(target: PromptSubmitTarget): string {
  return buildCompositeKey(target.worktreeId, target.cliToolId, target.instanceId);
}

/**
 * The tools whose prompt hook is trusted as proof of a submit — and, since
 * Issue #4048, the only ones whose `lastSend` a found body may demote.
 */
export function reportsPrompts(cliToolId: CLIToolType): boolean {
  // Claude only. codex's hooks run in a machine-wide daemon that can file a
  // turn under the wrong instance (#2874), and copilot's arrive out of order
  // (#1903); neither is evidence about one pane's composer.
  return cliToolId === 'claude';
}

/**
 * The entry a send looks at (Issue #4048). By name alone, the name's entry. With
 * an explicit target, the same entry only when the target's instance currently
 * maps to this very name and the entry is that instance's — a target and a name
 * that disagree are no entry at all, so nothing about another instance (or a
 * generation the instance no longer runs under this name) is taken as proof.
 * Looking never registers or resets anything.
 */
function entryFor(
  sessionName: string,
  cliToolId: CLIToolType,
  expected?: PromptSubmitExpected
): SessionEntry | undefined {
  const entry = sessions.get(sessionName);
  if (entry === undefined || expected === undefined) return entry;
  let key: string;
  try {
    key = instanceKey({ worktreeId: expected.worktreeId, cliToolId, instanceId: expected.instanceId });
  } catch {
    return undefined;
  }
  if (sessionByInstance.get(key) !== sessionName) return undefined;
  if (instanceKey(entry.target) !== key) return undefined;
  return entry;
}

/**
 * A session's generation began here (`beginAgentSession`). Forgets what was
 * known about the previous process in the same pane name.
 */
export function notePromptSubmitSession(sessionName: string, target: PromptSubmitTarget, at: number = Date.now()): void {
  sessions.delete(sessionName);
  sessions.set(sessionName, { target, startedAt: at, lastEventAt: null, lastPromptAt: null, submittedBody: null });
  sessionByInstance.set(instanceKey(target), sessionName);
  while (sessions.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    const entry = sessions.get(oldest);
    sessions.delete(oldest);
    if (entry !== undefined && sessionByInstance.get(instanceKey(entry.target)) === oldest) {
      sessionByInstance.delete(instanceKey(entry.target));
    }
  }
}

/** A hook was applied for this instance (`recordAgentEvent`). */
export function notePromptSubmitHook(target: PromptSubmitTarget, event: string, at: number): void {
  let sessionName: string | undefined;
  try {
    sessionName = sessionByInstance.get(instanceKey(target));
  } catch {
    return;
  }
  const entry = sessionName === undefined ? undefined : sessions.get(sessionName);
  if (entry === undefined) return;
  entry.lastEventAt = at;
  if (event === 'user_prompt_submit') {
    entry.lastPromptAt = at;
    // Issue #4048: the agent took a prompt, so a body the screen alone called
    // submitted is no longer one to look for — the late report was that body's,
    // or a later send went through after it. Either way no later send may find
    // it and demote a record (review: X restored after Y's success).
    entry.submittedBody = null;
  }
}

/**
 * The instance a session this server started runs, or null. With `expected`
 * (Issue #4048), null unless the explicit target names the same entry.
 */
export function getPromptSubmitTarget(
  sessionName: string,
  expected?: PromptSubmitExpected & { cliToolId: CLIToolType }
): PromptSubmitTarget | null {
  if (expected === undefined) return sessions.get(sessionName)?.target ?? null;
  return entryFor(sessionName, expected.cliToolId, expected)?.target ?? null;
}

/**
 * - `not-required`: the screen's verdict stands — the tool's prompt hook is not
 *   trusted, the session is not one this server started, no hook has arrived
 *   from its process yet (hooks off, or not up), or a prompt was already
 *   reported in this generation (not the first send).
 * - `received`: the agent reported a prompt at or after `enteredAt`.
 * - `awaited`: the first prompt of a session whose hooks are live has not been
 *   reported yet.
 */
export type PromptSubmitReceipt = 'not-required' | 'received' | 'awaited';

/**
 * Whether the screen's B/F verdict for a send whose first Enter went in at
 * `enteredAt` needs the agent's own report (Issue #4035).
 *
 * `expected` (Issue #4048) is the instance the send was made for; a name that
 * does not resolve to that instance's entry answers `not-required` (never
 * `received`), exactly as a session this server did not start.
 *
 * Known limit, kept as it is (Issue #4048 item 3): the question is asked on
 * every read, and a session whose first hook (`SessionStart`) has not arrived
 * by the read-back is answered `not-required` — the screen's B/F verdict then
 * stands and the send returns at once, before a hook that is only late could
 * turn it into `awaited`. Pinned by `prompt-submit-receipt-4048.test.ts`.
 */
export function readPromptSubmitReceipt(
  sessionName: string,
  cliToolId: CLIToolType,
  enteredAt: number,
  expected?: PromptSubmitExpected
): PromptSubmitReceipt {
  if (!reportsPrompts(cliToolId)) return 'not-required';
  const entry = entryFor(sessionName, cliToolId, expected);
  if (entry === undefined || entry.target.cliToolId !== cliToolId) return 'not-required';
  if (entry.lastPromptAt !== null && entry.lastPromptAt >= enteredAt) return 'received';
  // Issue #4048 item 3 (known limit): no hook yet from this process — the
  // screen decides, and a `SessionStart` that arrives after this read is not
  // waited for.
  if (entry.lastEventAt === null || entry.lastEventAt < entry.startedAt) return 'not-required';
  if (entry.lastPromptAt !== null && entry.lastPromptAt >= entry.startedAt) return 'not-required';
  return 'awaited';
}

function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * The sender reported this body submitted on this session from the screen
 * alone — not for one the agent's hook reported, which did leave.
 *
 * `expected` (Issue #4048): with an explicit target, nothing is noted unless it
 * names the same entry as the session name.
 */
export function noteSubmittedBody(
  sessionName: string,
  message: string,
  expected?: PromptSubmitExpected & { cliToolId: CLIToolType }
): void {
  const entry =
    expected === undefined ? sessions.get(sessionName) : entryFor(sessionName, expected.cliToolId, expected);
  if (entry === undefined) return;
  const body = compact(message);
  entry.submittedBody = {
    full: digest(body),
    prefix: body.length >= BODY_PREFIX_CHARS ? digest(body.slice(0, BODY_PREFIX_CHARS)) : null,
    messageDigest: sendMessageDigest(message),
  };
}

/**
 * The body last reported submitted on this session, when a composer read is it
 * — the whole of it, or (for a read long enough) its beginning — or null.
 * `messageDigest` is the attempt's digest, for demoting only that attempt's
 * record (Issue #4048).
 */
export function findSubmittedBody(
  sessionName: string,
  composerText: string,
  expected?: PromptSubmitExpected & { cliToolId: CLIToolType }
): { messageDigest: string } | null {
  const entry =
    expected === undefined ? sessions.get(sessionName) : entryFor(sessionName, expected.cliToolId, expected);
  const body = entry?.submittedBody;
  if (body === null || body === undefined) return null;
  const read = compact(composerText);
  if (read === '') return null;
  const matched =
    digest(read) === body.full ||
    (body.prefix !== null && read.length >= BODY_PREFIX_CHARS && digest(read.slice(0, BODY_PREFIX_CHARS)) === body.prefix);
  return matched ? { messageDigest: body.messageDigest } : null;
}

/**
 * Whether a composer read is the body last reported submitted on this session:
 * the whole of it, or — for a read long enough — its beginning.
 */
export function matchesSubmittedBody(sessionName: string, composerText: string): boolean {
  return findSubmittedBody(sessionName, composerText) !== null;
}

/** Forget every session (tests). */
export function clearPromptSubmitReceipts(): void {
  sessions.clear();
  sessionByInstance.clear();
}
