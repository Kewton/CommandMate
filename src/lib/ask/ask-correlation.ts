/**
 * Binding an ask to the turn that answered it (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3・§4).
 *
 * The chain is `askId` → the input that carried the envelope → the native
 * prompt record → the COMPLETED turn it opened → that turn's assistant row
 * (invariant 1). Nothing here compares bodies, positions on a screen or "the
 * newest row": the ledger row is found by the envelope's askId and settled by
 * what the transcript reader saw.
 *
 * The capability table is here and only here (§3.2): `GET /api/asks/capabilities`
 * publishes it, the send route consults it, and the CLI asks the server rather
 * than keeping a copy.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { isSlashCommandBody } from '@/lib/session/session-boundary';
import {
  getAskCorrelation,
  recordAskNativeInput,
  settleAskAttribution,
} from '@/lib/db/ask-correlation-db';
import { getMessageById } from '@/lib/db/chat-db';
import { createLogger } from '@/lib/logger';
import {
  ASK_PROTOCOL_VERSION,
  type AskAttributionResponse,
  type AskCapabilitiesResponse,
  type AskCorrelation,
} from '@/types/ask-correlation';

const logger = createLogger('lib/ask/ask-correlation');

/**
 * Per tool: whether its transcript reader binds an ask's envelope to the
 * completed turn (§0.1). True only for a tool whose adapter passes the §6
 * controls — the guard test `tests/unit/guards/ask-capability-controls-4344.test.ts`
 * holds every `true` here to its control file. PR1: claude.
 */
export const ASK_ATTRIBUTION_TOOLS: Readonly<Record<CLIToolType, boolean>> = {
  claude: true,
  codex: false,
  gemini: false,
  'vibe-local': false,
  opencode: false,
  copilot: false,
  antigravity: false,
  'command-code': false,
  'opencode-v2': false,
};

/** Whether `cliToolId` attributes an ask's reply by the ledger. */
export function supportsAskAttribution(cliToolId: string): boolean {
  return (ASK_ATTRIBUTION_TOOLS as Record<string, boolean>)[cliToolId] === true;
}

/** `GET /api/asks/capabilities`. */
export function getAskCapabilities(): AskCapabilitiesResponse {
  const tools: Record<string, boolean> = {};
  for (const id of CLI_TOOL_IDS) tools[id] = ASK_ATTRIBUTION_TOOLS[id];
  return { protocol: ASK_PROTOCOL_VERSION, tools };
}

/**
 * A body the envelope is not put on (M4): what the brief also leaves alone
 * (`isSlashCommandBody`: `/command`, `!shell`), and a `#` body, whose handling by
 * claude is not measured (safe side).
 */
export function isAskCommandBody(content: string): boolean {
  return isSlashCommandBody(content) || content.trimStart().startsWith('#');
}

/** The ledger's digest of a body: same askId + same digest is a re-POST, not a new send. */
export function askBodyDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** The destination an envelope was read under. */
export interface AskSightingTarget {
  worktreeId: string;
  cliToolId: string;
  instanceId: string;
}

/** What a transcript reader saw of one input that carried an envelope. */
export interface AskTurnSighting {
  askId: string;
  target: AskSightingTarget;
  /** The native input (claude: the prompt record's uuid). */
  nativeInputId: string;
  /** The session the record was in. */
  nativeSessionId: string | null;
  /** The session the instance follows now (claude: `resolveClaudeSessionId`). */
  currentSessionId: string | null;
  /** The turn's History key (`claude-turn:<uuid>`). */
  nativeTurnKey: string;
  /** Whether the turn is over (claude: `isClaudeTurnWritable`). */
  turnComplete: boolean;
  /** Inputs the turn took besides this one (M1: absorbed prompts and asks). */
  otherInputs: number;
  /** Background-task notices the turn absorbed: not inputs (§7 (a) ②), reported as `notified`. */
  notices: number;
  /** The turn's assistant row in History, once written. */
  assistantMessage: { id: string; content: string } | null;
  /** Whether that row's body was cut. */
  truncated: boolean;
}

/** What {@link bindAskSighting} did (§4 reader `recordNativeAskInput` / `bindCompletedTurn`). */
export type AskSightingOutcome =
  | 'unknown'
  | 'rejected'
  | 'duplicate'
  | 'pending'
  | 'matched'
  | 'ambiguous'
  | 'unmatched';

function isTerminal(row: AskCorrelation): boolean {
  return row.attributionState !== 'pending';
}

/**
 * Record one sighting of an envelope and settle the ask when the turn is
 * complete. Never throws; a failure is logged and answered `unknown`, so the
 * reader's other work (History) is never stopped by the ledger.
 */
export function bindAskSighting(db: Database.Database, sighting: AskTurnSighting): AskSightingOutcome {
  try {
    return bind(db, sighting);
  } catch (error) {
    logger.warn('ask-correlation-bind-failed', {
      askId: sighting.askId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unknown';
  }
}

function bind(db: Database.Database, sighting: AskTurnSighting): AskSightingOutcome {
  const row = getAskCorrelation(db, sighting.askId);
  if (!row) {
    // No reservation: an envelope this server did not stamp (a pasted one).
    logger.info('ask-correlation-unknown-envelope', { askId: sighting.askId, worktreeId: sighting.target.worktreeId });
    return 'unknown';
  }
  const { target } = sighting;
  // M5 / invariant 2: the destination fixed at the send.
  if (row.worktreeId !== target.worktreeId || row.cliToolId !== target.cliToolId || row.instanceId !== target.instanceId) {
    logger.warn('ask-correlation-rejected', { askId: row.askId, reason: 'destination' });
    return 'rejected';
  }
  // M5: the record must be in the session the instance follows now.
  if (sighting.currentSessionId && sighting.nativeSessionId && sighting.currentSessionId !== sighting.nativeSessionId) {
    logger.warn('ask-correlation-rejected', { askId: row.askId, reason: 'session' });
    return 'rejected';
  }
  const sameInput =
    row.nativeInputId === null
    || (row.nativeInputId === sighting.nativeInputId && (row.nativeSessionId ?? null) === (sighting.nativeSessionId ?? null));
  if (!sameInput) {
    // M6: a terminal row is never rewritten; a second input before it settled is not guessed at.
    if (isTerminal(row)) {
      logger.info('ask-correlation-duplicate-sighting', {
        askId: row.askId,
        nativeInputId: sighting.nativeInputId,
        nativeSessionId: sighting.nativeSessionId,
      });
      return 'duplicate';
    }
    settleAskAttribution(db, row.askId, { state: 'unmatched', reason: 'envelope_duplicated' });
    return 'unmatched';
  }
  if (isTerminal(row)) return 'duplicate';
  if (row.nativeInputId === null) {
    recordAskNativeInput(db, row.askId, { nativeInputId: sighting.nativeInputId, nativeSessionId: sighting.nativeSessionId });
  }
  if (!sighting.turnComplete) return 'pending';
  const notified = sighting.notices > 0;
  if (sighting.otherInputs > 0) {
    settleAskAttribution(db, row.askId, { state: 'ambiguous', reason: 'shared_turn', nativeTurnKey: sighting.nativeTurnKey, notified });
    return 'ambiguous';
  }
  // R3: a turn already open at the send is never `matched`, whatever the reader saw.
  if (row.turnOpenAtSend === true) {
    settleAskAttribution(db, row.askId, { state: 'ambiguous', reason: 'turn_open_at_send', nativeTurnKey: sighting.nativeTurnKey, notified });
    return 'ambiguous';
  }
  if (!sighting.assistantMessage) return 'pending';
  if (sighting.truncated) {
    settleAskAttribution(db, row.askId, { state: 'unmatched', reason: 'body_truncated', nativeTurnKey: sighting.nativeTurnKey, notified });
    return 'unmatched';
  }
  settleAskAttribution(db, row.askId, {
    state: 'matched',
    reason: null,
    nativeTurnKey: sighting.nativeTurnKey,
    assistantMessageIds: [sighting.assistantMessage.id],
    notified,
  });
  return 'matched';
}

/**
 * An ask whose input was absorbed into another input's turn (M1): it has no
 * prompt record of its own, so no turn answers it alone. Settles a pending row
 * of the same destination `unmatched/absorbed_mid_turn`.
 */
export function markAskAbsorbed(db: Database.Database, askId: string, target: AskSightingTarget): boolean {
  try {
    const row = getAskCorrelation(db, askId);
    if (!row || isTerminal(row)) return false;
    if (row.worktreeId !== target.worktreeId || row.cliToolId !== target.cliToolId || row.instanceId !== target.instanceId) {
      return false;
    }
    return settleAskAttribution(db, askId, { state: 'unmatched', reason: 'absorbed_mid_turn' });
  } catch (error) {
    logger.warn('ask-correlation-absorb-failed', { askId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * `GET /api/asks/:askId` (§4): the row, with the reply only when `matched` and
 * every assistant row it names is still in History (`history_missing` is read
 * here, never stored — R1). A `pending` row is refreshed once through `refresh`
 * (the tool's reader, §3.5) before it is answered.
 *
 * @returns null for an askId the ledger does not have (404)
 */
export async function readAskAttribution(
  db: Database.Database,
  askId: string,
  refresh?: (row: AskCorrelation) => Promise<void>,
): Promise<AskAttributionResponse | null> {
  let row = getAskCorrelation(db, askId);
  if (!row) return null;
  if (row.attributionState === 'pending' && row.sendState !== 'not_sent' && refresh) {
    try {
      await refresh(row);
    } catch (error) {
      logger.warn('ask-correlation-refresh-failed', { askId, error: error instanceof Error ? error.message : String(error) });
    }
    row = getAskCorrelation(db, askId) ?? row;
  }
  const base = {
    askId: row.askId,
    sendState: row.sendState,
    nativeInputSeen: row.nativeInputId !== null,
    notified: row.notified,
  };
  if (row.attributionState === 'pending' && row.sendState === 'not_sent') {
    return { ...base, state: 'unmatched', reason: 'not_sent', reply: null };
  }
  if (row.attributionState !== 'matched') {
    return { ...base, state: row.attributionState, reason: row.reason, reply: null };
  }
  const bodies: string[] = [];
  for (const id of row.assistantMessageIds) {
    const message = getMessageById(db, id);
    if (!message) return { ...base, state: 'unmatched', reason: 'history_missing', reply: null };
    bodies.push(message.content);
  }
  if (bodies.length === 0) return { ...base, state: 'unmatched', reason: 'history_missing', reply: null };
  return { ...base, state: 'matched', reason: null, reply: bodies.join('\n\n') };
}
