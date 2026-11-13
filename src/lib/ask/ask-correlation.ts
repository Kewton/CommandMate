/**
 * Binding an ask to the turn that answered it (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3・§3.6・§4).
 *
 * The chain is `askId` → the input that carried the envelope → the native
 * prompt record → the COMPLETED turn it opened → that turn's assistant row
 * (invariant 1). Nothing here compares bodies, positions on a screen or "the
 * newest row": the ledger row is found by the envelope's askId and settled by
 * what the transcript reader saw, cell by cell of the state table (§3.6.3) and
 * its invariants I1〜I14 (§3.6.4).
 *
 * The capability table is here and only here (§3.2): `GET /api/asks/capabilities`
 * publishes it, the send route consults it, and the CLI (from PR3) asks the server rather
 * than keeping a copy.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { isSlashCommandBody } from '@/lib/session/session-boundary';
import {
  getAskCorrelation,
  noteAskEvidence,
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
 * holds every `true` here to its control file. PR1: claude. PR2: codex (its
 * control fixture is the real Q3 record of a 9,428-byte enveloped paste,
 * `tests/fixtures/codex-ask-attribution-4344/`).
 */
export const ASK_ATTRIBUTION_TOOLS: Readonly<Record<CLIToolType, boolean>> = {
  claude: true,
  codex: true,
  gemini: false,
  'vibe-local': false,
  opencode: false,
  copilot: false,
  antigravity: false,
  'command-code': false,
  'opencode-v2': false,
};

/**
 * H5 (§0.1・§3.6.3a): the oldest version of each attributed tool whose turns end
 * with an observable stop (and, for codex, whose rollout is shown to keep the
 * envelope — Q3). claude: `2.1.239`, the oldest version with a real
 * record carrying `stop_reason` in the repository
 * (`tests/fixtures/turn-separation-2234/claude-tool-first-turn.jsonl`). Older,
 * or a version that cannot be read: the capability is false.
 */
export const ASK_ATTRIBUTION_MIN_VERSIONS: Readonly<Partial<Record<CLIToolType, string>>> = {
  claude: '2.1.239',
  // codex: `0.167.2`, the version of the only real record showing that an
  // enveloped input keeps the envelope and its whole text in the rollout's
  // `UserMessage` (Q3, 2026-11-14) and closes with a `task_complete` of the same
  // `turn_id` (`tests/fixtures/codex-ask-attribution-4344/`). Older: false.
  codex: '0.167.2',
};

/**
 * H3 (§3.6.3a): a reservation with no saved send outcome after this long is read
 * as `send_unknown` (the server went down mid-send). Far longer than the send
 * path's own bounds (the input lock, a session start).
 */
export const ASK_RESERVED_STALE_MS = 10 * 60 * 1000;

/** The installed version of a tool, or null when it cannot be read. */
export type AskVersionProbe = (cliToolId: string) => Promise<string | null>;

const defaultVersionProbe: AskVersionProbe = async (cliToolId) => {
  const { getAgentVersions } = await import('@/lib/updates/agent-versions');
  const rows = await getAgentVersions();
  return rows.find((row) => row.tool === cliToolId)?.installed ?? null;
};

let versionProbe: AskVersionProbe = defaultVersionProbe;

/** Test seam: replace (or with null, restore) the installed-version probe. */
export function setAskVersionProbeForTest(probe: AskVersionProbe | null): void {
  versionProbe = probe ?? defaultVersionProbe;
}

/** `a >= b` for dotted numeric versions; the first `x.y.z` in `a` is read. Null when `a` has none. */
export function versionAtLeast(a: string, b: string): boolean | null {
  const read = (v: string) => /(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
  const x = read(a);
  const y = read(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return true;
}

/** Whether `cliToolId` is in the capability table at all (no version consulted). */
export function supportsAskAttribution(cliToolId: string): boolean {
  return (ASK_ATTRIBUTION_TOOLS as Record<string, boolean>)[cliToolId] === true;
}

/**
 * Whether the server attributes `cliToolId`'s asks now: in the table, and (H5)
 * its installed version is at least the minimum. A version that cannot be read
 * is false. Never throws.
 */
export async function askAttributionCapable(cliToolId: string): Promise<boolean> {
  if (!supportsAskAttribution(cliToolId)) return false;
  const minimum = (ASK_ATTRIBUTION_MIN_VERSIONS as Record<string, string | undefined>)[cliToolId];
  if (!minimum) return false;
  try {
    const installed = await versionProbe(cliToolId);
    return installed !== null && versionAtLeast(installed, minimum) === true;
  } catch (error) {
    logger.warn('ask-version-probe-failed', { cliToolId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** `GET /api/asks/capabilities`. */
export async function getAskCapabilities(): Promise<AskCapabilitiesResponse> {
  const tools: Record<string, boolean> = {};
  for (const id of CLI_TOOL_IDS) tools[id] = await askAttributionCapable(id);
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

/**
 * Where the turn an input opened stands (§3.6 I5): `closed` — its stop was
 * observed (claude: the last assistant record is `end_turn` with prose);
 * `interrupted` — a later prompt superseded it with no stop observed (H5);
 * `open` — neither (in flight, or a version that writes no stop_reason).
 */
export type AskTurnState = 'closed' | 'interrupted' | 'open';

/** What a transcript reader saw of one input that carried an envelope. */
export interface AskTurnSighting {
  askId: string;
  target: AskSightingTarget;
  /** The native input (claude: the prompt record's uuid; codex: the `UserMessage` item id). */
  nativeInputId: string;
  /** The session the record was in; null when it cannot be read. */
  nativeSessionId: string | null;
  /** The session the instance follows now (`resolveClaudeSessionId` / `resolveCodexSessionId`); null when it cannot be read. */
  currentSessionId: string | null;
  /** The turn's History key (`claude-turn:<uuid>` / `codex-turn:<turn_id>`). */
  nativeTurnKey: string;
  turnState: AskTurnState;
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

/** I1: matched, ambiguous and unmatched (not_sent included, H2) are never rewritten. */
function isTerminal(row: AskCorrelation): boolean {
  return row.attributionState !== 'pending';
}

/** Whether the row is old enough to read a missing send outcome as `send_unknown` (H3). */
function isStaleReservation(row: AskCorrelation, now: number): boolean {
  return row.sendState === 'reserved' && now - row.createdAt >= ASK_RESERVED_STALE_MS;
}

/**
 * I4: whether the send's observations are in — the outcome was saved, or (H3)
 * the reservation is stale and is read as `send_unknown`.
 */
function sendSettled(row: AskCorrelation, now: number): boolean {
  return row.sendState !== 'reserved' || isStaleReservation(row, now);
}

function sameDestination(row: AskCorrelation, target: AskSightingTarget): boolean {
  return row.worktreeId === target.worktreeId && row.cliToolId === target.cliToolId && row.instanceId === target.instanceId;
}

/** sha256 of a reply, for H4. */
export function askReplyDigest(reply: string): string {
  return createHash('sha256').update(reply, 'utf8').digest('hex');
}

/**
 * I8: the evidence carried through the reservation, judged before any
 * completion once the send's observations are in. Duplicate first (I9), then
 * absorption (I10). Answers the outcome, or null when there is none to apply.
 */
function applyCarried(db: Database.Database, row: AskCorrelation, now: number): AskSightingOutcome | null {
  if (isTerminal(row) || !sendSettled(row, now)) return null;
  if (row.duplicateSeen) {
    settleAskAttribution(db, row.askId, { state: 'unmatched', reason: 'envelope_duplicated' }, now);
    return 'unmatched';
  }
  if (row.absorbedSeen) {
    settleAskAttribution(db, row.askId, { state: 'unmatched', reason: 'absorbed_mid_turn' }, now);
    return 'unmatched';
  }
  return null;
}

/**
 * Apply the evidence carried through the reservation, after the send's outcome
 * was saved (cells 4・5). Never throws.
 */
export function applyCarriedAskEvidence(db: Database.Database, askId: string, now = Date.now()): void {
  try {
    const row = getAskCorrelation(db, askId);
    if (row) applyCarried(db, row, now);
  } catch (error) {
    logger.warn('ask-correlation-carry-failed', { askId, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Record one sighting of an envelope and settle the ask when the table says so.
 * Never throws; a failure is logged and answered `unknown`, so the reader's other
 * work (History) is never stopped by the ledger.
 */
export function bindAskSighting(db: Database.Database, sighting: AskTurnSighting, now = Date.now()): AskSightingOutcome {
  try {
    return bind(db, sighting, now);
  } catch (error) {
    logger.warn('ask-correlation-bind-failed', {
      askId: sighting.askId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unknown';
  }
}

/** Cells 4・15・16 (I9): a second native input of one envelope. */
function secondInput(db: Database.Database, row: AskCorrelation, sighting: AskTurnSighting, now: number): AskSightingOutcome {
  if (isTerminal(row)) {
    // Cell 18: after the end, a log line and nothing else (I1).
    logger.info('ask-correlation-duplicate-sighting', {
      askId: row.askId,
      nativeInputId: sighting.nativeInputId,
      nativeSessionId: sighting.nativeSessionId,
    });
    return 'duplicate';
  }
  if (!sendSettled(row, now)) {
    // Cell 4 (I8): carried until the send's observations are in.
    noteAskEvidence(db, row.askId, 'duplicate', now);
    return 'pending';
  }
  settleAskAttribution(db, row.askId, { state: 'unmatched', reason: 'envelope_duplicated' }, now);
  return 'unmatched';
}

function bind(db: Database.Database, sighting: AskTurnSighting, now: number): AskSightingOutcome {
  let row = getAskCorrelation(db, sighting.askId);
  if (!row) {
    // Cell 26: no reservation — an envelope this server did not stamp (a pasted one).
    logger.info('ask-correlation-unknown-envelope', { askId: sighting.askId, worktreeId: sighting.target.worktreeId });
    return 'unknown';
  }
  // Cell 7 (I7): the destination fixed at the send.
  if (!sameDestination(row, sighting.target)) {
    logger.warn('ask-correlation-rejected', { askId: row.askId, reason: 'destination' });
    return 'rejected';
  }
  // Cell 8b (I6): a session that cannot be read confirms nothing — nothing recorded, nothing settled.
  if (!sighting.currentSessionId || !sighting.nativeSessionId) {
    logger.info('ask-correlation-session-unknown', { askId: row.askId });
    return isTerminal(row) ? 'duplicate' : 'pending';
  }
  // Cell 8 (I6): the record must be in the session the instance follows now.
  if (sighting.currentSessionId !== sighting.nativeSessionId) {
    logger.warn('ask-correlation-rejected', { askId: row.askId, reason: 'session' });
    return 'rejected';
  }
  const isSameInput = (candidate: AskCorrelation): boolean =>
    candidate.nativeInputId === sighting.nativeInputId && candidate.nativeSessionId === sighting.nativeSessionId;
  if (row.nativeInputId !== null && !isSameInput(row)) return secondInput(db, row, sighting, now);
  // Cell 14 / 18 / 21 / 22: a terminal row does not move (I1).
  if (isTerminal(row)) return 'duplicate';
  if (row.nativeInputId === null) {
    recordAskNativeInput(db, row.askId, { nativeInputId: sighting.nativeInputId, nativeSessionId: sighting.nativeSessionId }, now);
    // Another process may have recorded another input first (§3.6.5): read back.
    row = getAskCorrelation(db, row.askId) ?? row;
    if (!isSameInput(row)) return secondInput(db, row, sighting, now);
  }
  // Cell 3 (I4): never terminal before the send's observations are saved.
  if (!sendSettled(row, now)) return 'pending';
  // Cells 4・5 (I8): carried evidence before any completion.
  const carried = applyCarried(db, row, now);
  if (carried) return carried;
  // Cells 6・11b・11c (I5): only an observed stop completes a turn.
  if (sighting.turnState === 'open') return 'pending';
  const expectedInputId = sighting.nativeInputId;
  if (sighting.turnState === 'interrupted') {
    settleAskAttribution(db, row.askId, { state: 'unmatched', reason: 'turn_interrupted', nativeTurnKey: sighting.nativeTurnKey, expectedInputId }, now);
    return 'unmatched';
  }
  const notified = sighting.notices > 0;
  // Cell 9 (I10).
  if (sighting.otherInputs > 0) {
    settleAskAttribution(db, row.askId, { state: 'ambiguous', reason: 'shared_turn', nativeTurnKey: sighting.nativeTurnKey, notified, expectedInputId }, now);
    return 'ambiguous';
  }
  // Cells 10・10b (I11, H1): open at the send, or not known — never matched.
  if (row.turnOpenAtSend !== false) {
    settleAskAttribution(db, row.askId, { state: 'ambiguous', reason: 'turn_open_at_send', nativeTurnKey: sighting.nativeTurnKey, notified, expectedInputId }, now);
    return 'ambiguous';
  }
  // Cell 13: the row is not written yet.
  if (!sighting.assistantMessage) return 'pending';
  // Cell 12.
  if (sighting.truncated) {
    settleAskAttribution(db, row.askId, { state: 'unmatched', reason: 'body_truncated', nativeTurnKey: sighting.nativeTurnKey, notified, expectedInputId }, now);
    return 'unmatched';
  }
  // Cell 11 (I2, H4): matched, with the body's digest and length fixed.
  const settled = settleAskAttribution(db, row.askId, {
    state: 'matched',
    reason: null,
    nativeTurnKey: sighting.nativeTurnKey,
    assistantMessageIds: [sighting.assistantMessage.id],
    notified,
    replyDigest: askReplyDigest(sighting.assistantMessage.content),
    replyLength: sighting.assistantMessage.content.length,
    expectedInputId,
  }, now);
  return settled ? 'matched' : 'pending';
}

/**
 * Cell 5 (M1, I6・I7・I8): an ask whose input was absorbed into another input's
 * turn has no prompt record of its own, so no turn answers it alone. Same
 * destination and same, readable session only. While the send's outcome is not
 * saved the evidence is carried; after it, `unmatched/absorbed_mid_turn`.
 */
export function markAskAbsorbed(
  db: Database.Database,
  askId: string,
  target: AskSightingTarget,
  sessions: { nativeSessionId: string | null; currentSessionId: string | null },
  now = Date.now(),
): boolean {
  try {
    const row = getAskCorrelation(db, askId);
    if (!row || isTerminal(row) || !sameDestination(row, target)) return false;
    if (!sessions.nativeSessionId || !sessions.currentSessionId || sessions.nativeSessionId !== sessions.currentSessionId) {
      return false;
    }
    if (!sendSettled(row, now)) return noteAskEvidence(db, askId, 'absorbed', now);
    return settleAskAttribution(db, askId, { state: 'unmatched', reason: 'absorbed_mid_turn' }, now);
  } catch (error) {
    logger.warn('ask-correlation-absorb-failed', { askId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * `GET /api/asks/:askId` (§4): the row, with the reply only when `matched`, every
 * assistant row it names is still in History (`history_missing`) and the body is
 * the one it was settled with (H4: `history_changed`). Both are read here, never
 * stored (I12). A `pending` row is refreshed once through `refresh` (the tool's
 * reader, §3.5) before it is answered. A stale reservation (H3) is answered as
 * `send_unknown`.
 *
 * @returns null for an askId the ledger does not have (404)
 */
export async function readAskAttribution(
  db: Database.Database,
  askId: string,
  refresh?: (row: AskCorrelation) => Promise<void>,
  now = Date.now(),
): Promise<AskAttributionResponse | null> {
  let row = getAskCorrelation(db, askId);
  if (!row) return null;
  if (row.attributionState === 'pending' && refresh) {
    try {
      await refresh(row);
    } catch (error) {
      logger.warn('ask-correlation-refresh-failed', { askId, error: error instanceof Error ? error.message : String(error) });
    }
    row = getAskCorrelation(db, askId) ?? row;
  }
  if (applyCarried(db, row, now)) row = getAskCorrelation(db, askId) ?? row;
  const base = {
    askId: row.askId,
    sendState: isStaleReservation(row, now) ? ('send_unknown' as const) : row.sendState,
    nativeInputSeen: row.nativeInputId !== null,
    notified: row.notified,
  };
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
  const reply = bodies.join('\n\n');
  if (row.replyDigest === null || row.replyLength !== reply.length || askReplyDigest(reply) !== row.replyDigest) {
    return { ...base, state: 'unmatched', reason: 'history_changed', reply: null };
  }
  return { ...base, state: 'matched', reason: null, reply };
}
