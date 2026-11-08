/**
 * Conversation boundaries: where they are observed and how a row of the ledger opens
 * or binds (Issue #4274, design `docs/design/session-boundary-brief-4274.md` §2・§3.3).
 *
 * A process generation (`beginAgentSession`, in memory) and a conversation are kept
 * apart. Three sources of evidence, one ledger:
 *
 *  - (a) the launch: `beginAgentSession` on a creation path ({@link openLaunchBoundary});
 *    a reconnect never calls it, so a reconnect opens nothing;
 *  - (b) the agent's `SessionStart` (`startup` / `clear` / `resume`), and a turn event
 *    naming another conversation (a reset missed while the server was down) —
 *    identified events only, those naming both the worktree and the instance
 *    ({@link observeHookBoundary}); a headless run's hook carries no instance and
 *    opens nothing;
 *  - (c) a reset command this server typed ({@link openResetBoundaryFromSend}),
 *    under the input lock of the send that typed it (2nd review A).
 *
 * The screen is not evidence. Tools other than claude, codex and command-code are
 * not covered: nothing is opened for them and their sends are unchanged.
 *
 * Every function here fails open: a ledger that cannot be written costs a log line,
 * never a launch, an event or a send.
 *
 * @module lib/session/session-boundary
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  adoptBoundaryAsSendReset,
  bindBoundaryConversation,
  isSameInstanceLifetime,
  listRetainedBoundaries,
  openBoundary,
  readInstanceLifetime,
  type BoundaryRow,
  type InstanceLifetime,
} from '@/lib/db/session-brief-db';
import { isUnderTest } from '@/lib/test-run-detection';
import { createLogger } from '@/lib/logger';

const logger = createLogger('session/session-boundary');

/** The tools whose boundaries are detected (design §2.2). */
export const BOUNDARY_TOOLS: ReadonlySet<string> = new Set(['claude', 'codex', 'command-code']);

/** The commands each tool starts a new conversation with (design §2.3). */
export const RESET_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  claude: ['/clear'],
  // `/new` is measured (codex/history.ts); `/clear` is in the slash-command catalog for codex.
  codex: ['/new', '/clear'],
  'command-code': ['/clear'],
};

/** The first word of a body: up to the first whitespace, after trimming. */
function firstWord(content: string): string {
  return content.trim().split(/\s/, 1)[0] ?? '';
}

/** Whether the body is a slash command (design §4.1): nothing is put in front of one. */
export function isSlashCommandBody(content: string): boolean {
  return /^\/[a-z][a-z0-9-]*$/.test(firstWord(content));
}

/** Whether the body is one of the tool's reset commands (design §2.3). */
export function isResetCommandBody(cliToolId: string, content: string): boolean {
  const word = firstWord(content);
  return (RESET_COMMANDS[cliToolId] ?? []).includes(word);
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

let databaseOverride: Database.Database | null | undefined;

/**
 * The ledger's database for the paths that have none in hand (the launch, the hook
 * intake). Null in a test run unless one was handed in — the same rule as
 * `resolveSessionArchiveDatabase`: opening one here would fabricate a file or reach
 * the developer's real one.
 */
export function resolveBoundaryDatabase(): Database.Database | null {
  if (databaseOverride !== undefined) return databaseOverride;
  if (isUnderTest()) return null;
  return getDbInstance();
}

/**
 * The database a send writes the ledger through: the test's when one was handed in,
 * else the send's own when it is a real connection (a suite that mocks the database
 * with `{}` writes nothing).
 */
export function boundaryDatabaseFor(db: unknown): Database.Database | null {
  if (databaseOverride !== undefined) return databaseOverride;
  const candidate = db as { prepare?: unknown } | null;
  return candidate !== null && typeof candidate === 'object' && typeof candidate.prepare === 'function'
    ? (db as Database.Database)
    : null;
}

/** Hand the ledger a database in a test (null: none; undefined: the default rule). */
export function setBoundaryDatabaseForTest(db: Database.Database | null | undefined): void {
  databaseOverride = db;
}

function warn(event: string, fields: Record<string, unknown>, error: unknown): void {
  logger.warn(event, { ...fields, error: error instanceof Error ? error.message : String(error) });
}

// ---------------------------------------------------------------------------
// (a) The launch
// ---------------------------------------------------------------------------

/** What a running send tells a relaunch inside it (design §3.5). */
interface SendScope {
  claimToken: string | null;
}

const sendScope = new AsyncLocalStorage<SendScope>();

/** Run `fn` as the delivery of one send, so a relaunch inside it knows whose it is. */
export function runInSendScope<T>(claimToken: string | null, fn: () => Promise<T>): Promise<T> {
  return sendScope.run({ claimToken }, fn);
}

/**
 * A new agent process (`beginAgentSession`, creation path only): open a launch row,
 * superseding what was still pending. Inside a send (its relaunch of an exited tool)
 * it is an `auto_restart`, and the row carries the send's claim token.
 */
export function openLaunchBoundary(
  target: { worktreeId: string; cliToolId: string; instanceId?: string },
  at: number = Date.now()
): void {
  if (!BOUNDARY_TOOLS.has(target.cliToolId)) return;
  const instanceId = target.instanceId ?? target.cliToolId;
  try {
    const db = resolveBoundaryDatabase();
    if (!db) return;
    const scope = sendScope.getStore();
    openBoundary(db, {
      worktreeId: target.worktreeId,
      instanceId,
      cliToolId: target.cliToolId,
      lifetime: readInstanceLifetime(db, target.worktreeId, instanceId),
      kind: scope ? 'auto_restart' : 'launch',
      evidence: 'launch',
      openedAt: at,
      openedBySend: scope?.claimToken ?? null,
    });
  } catch (error) {
    warn('session-boundary-launch-open-failed', { worktreeId: target.worktreeId, instanceId }, error);
  }
}

// ---------------------------------------------------------------------------
// (b) Hooks
// ---------------------------------------------------------------------------

export interface HookBoundaryObservation {
  worktreeId: string;
  cliToolId: string;
  /** The instance the event named, or undefined. */
  instanceId: string | undefined;
  /** The event named both the worktree and the instance (not resolved from `cwd`). */
  identified: boolean;
  event: string;
  /** `SessionStart`'s `source` for a `session_start`. */
  detail: string | null;
  sessionId: string | null;
  at: number;
}

const LATE_EVIDENCE_EVENTS: ReadonlySet<string> = new Set(['user_prompt_submit', 'stop']);

/** Epoch ms the reset send's input started, carried in its token (`<token>@<ms>`). */
function resetInputStartedAt(row: BoundaryRow): number | null {
  if (row.resetSendToken === null) return null;
  const at = Number(row.resetSendToken.slice(row.resetSendToken.lastIndexOf('@') + 1));
  return Number.isFinite(at) ? at : null;
}

/**
 * Apply one recorded hook event to the ledger (design §3.3, the hook table). Only
 * identified events; a delivery the ledger already holds changes nothing, whatever
 * the order and across a restart (the check is the DB, not a memory window).
 */
export function observeHookBoundary(observation: HookBoundaryObservation): void {
  if (!observation.identified || observation.instanceId === undefined) return;
  if (!BOUNDARY_TOOLS.has(observation.cliToolId)) return;
  const sessionId = observation.sessionId;
  if (sessionId === null || sessionId === '') return;
  const { worktreeId, cliToolId, at } = observation;
  const instanceId = observation.instanceId;
  try {
    const db = resolveBoundaryDatabase();
    if (!db) return;
    const rows = listRetainedBoundaries(db, worktreeId, instanceId);
    const current = rows[0] ?? null;
    const open = (input: { kind: 'launch' | 'reset' | 'resume'; key: string; late?: boolean }) =>
      openBoundary(db, {
        worktreeId,
        instanceId,
        cliToolId,
        lifetime: readInstanceLifetime(db, worktreeId, instanceId),
        kind: input.kind,
        evidence: 'hook',
        conversationId: sessionId,
        late: input.late,
        openedAt: at,
        observationKey: input.key,
      });

    if (observation.event === 'session_start') {
      const source = observation.detail ?? '';
      const key = `${source}:${sessionId}`;
      if (source === 'startup') {
        if (rows.some((row) => row.observationKey === key)) return;
        if (current && current.conversationId === null) {
          bindBoundaryConversation(db, current.id, sessionId, key);
          return;
        }
        if (current && current.conversationId === sessionId) return;
        open({ kind: 'launch', key });
        return;
      }
      if (source === 'clear') {
        // `/clear` makes a new id every time: the same key is always a redelivery.
        if (rows.some((row) => row.observationKey === key)) return;
        const startedAt = current ? resetInputStartedAt(current) : null;
        if (current && current.evidence === 'send_command' && current.conversationId === null && startedAt !== null && at >= startedAt) {
          bindBoundaryConversation(db, current.id, sessionId, key);
          return;
        }
        open({ kind: 'reset', key });
        return;
      }
      if (source === 'resume') {
        // Compared with the current row only (2nd review E): A → B → A is three
        // boundaries; a redelivery of the current one finds the same conversation.
        if (current && current.conversationId === sessionId) return;
        if (current && current.conversationId === null && current.evidence === 'launch') {
          // The launch resumed a conversation: the same boundary, now with its id.
          bindBoundaryConversation(db, current.id, sessionId, key);
          return;
        }
        open({ kind: 'resume', key });
      }
      // `compact` and anything else: the conversation goes on.
      return;
    }

    if (!LATE_EVIDENCE_EVENTS.has(observation.event)) return;
    if (!current || current.conversationId === null || current.conversationId === sessionId) return;
    // Seen before (an earlier row's conversation, or a late row of it): a late event
    // of a previous conversation, not a reset nobody saw.
    const lateKey = `late:${sessionId}`;
    if (rows.some((row) => row.conversationId === sessionId || row.observationKey === lateKey)) return;
    open({ kind: 'reset', key: lateKey, late: true });
  } catch (error) {
    warn('session-boundary-hook-observe-failed', { worktreeId, instanceId, event: observation.event }, error);
  }
}

// ---------------------------------------------------------------------------
// (c) A reset this server typed
// ---------------------------------------------------------------------------

export interface SendResetObservation {
  worktreeId: string;
  cliToolId: string;
  instanceId: string;
  /** This send's id. */
  sendId: string;
  /** When its input started (epoch ms). */
  inputStartedAt: number;
  /** The instance's lifetime as the send read it on entry; a re-created instance's ledger is not touched. */
  lifetime: InstanceLifetime;
}

/**
 * The send typed a reset command and it was submitted (design §3.3, "送った reset とフックの順序").
 * Called under the send's input lock, before it is released (2nd review A): a send
 * queued behind finds the new row already open. Opens one row whichever of the send
 * and the hook comes first.
 */
export function openResetBoundaryFromSend(db: Database.Database, observation: SendResetObservation): void {
  const { worktreeId, cliToolId, instanceId } = observation;
  if (!BOUNDARY_TOOLS.has(cliToolId)) return;
  try {
    const now = readInstanceLifetime(db, worktreeId, instanceId);
    if (!isSameInstanceLifetime(observation.lifetime, now, cliToolId)) return;
    const token = `${observation.sendId}@${observation.inputStartedAt}`;
    const current = listRetainedBoundaries(db, worktreeId, instanceId)[0] ?? null;
    if (
      current &&
      current.evidence === 'hook' &&
      current.kind === 'reset' &&
      !current.late &&
      current.resetSendToken === null &&
      current.openedAt >= observation.inputStartedAt
    ) {
      adoptBoundaryAsSendReset(db, current.id, token);
      return;
    }
    openBoundary(db, {
      worktreeId,
      instanceId,
      cliToolId,
      lifetime: now,
      kind: 'reset',
      evidence: 'send_command',
      openedAt: Date.now(),
      resetSendToken: token,
    });
  } catch (error) {
    warn('session-boundary-send-reset-failed', { worktreeId, instanceId }, error);
  }
}
