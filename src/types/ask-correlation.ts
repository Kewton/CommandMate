/**
 * The ask correlation ledger's shapes (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3).
 *
 * One row per `askId`: a synchronous `commandmate ask` reserves it before the
 * send, the send stamps an envelope (`[cmate-ask v1 <askId>]`) on the text it
 * types, and the tool's transcript reader binds the native input that carried
 * the envelope to the completed turn that answered it. The reply is read by
 * `askId`, never by "the newest row".
 *
 * Shared by the server (`lib/ask`, `lib/db/ask-correlation-db`, `/api/asks/*`)
 * and mirrored for the CLI in `src/cli/types/api-responses.ts` when `ask` starts
 * using it (design §6 PR3).
 */

/** The envelope protocol version both sides speak. */
export const ASK_PROTOCOL_VERSION = 1;

/**
 * What the CLI prints in `attribution.state` (§3.3). `pending` is the API's
 * in-between state and never the CLI's final answer.
 */
export type AskAttributionState = 'pending' | 'matched' | 'ambiguous' | 'unmatched' | 'unavailable';

/** Why an ask ended where it did (§3.3). */
export type AskAttributionReason =
  | 'tool_unsupported'
  | 'server_unsupported'
  | 'slash_command'
  | 'shared_turn'
  | 'turn_open_at_send'
  | 'envelope_lost'
  | 'absorbed_mid_turn'
  | 'envelope_duplicated'
  | 'turn_incomplete'
  | 'generation_changed'
  | 'history_missing'
  | 'body_truncated'
  | 'send_unknown'
  | 'not_sent'
  | 'grace_expired'
  /** H5: the turn was superseded without its stop being observed. Stored. */
  | 'turn_interrupted'
  /** H4: the matched reply's History row is no longer the body it was settled with. Read-time only. */
  | 'history_changed';

/** How the send of a reserved ask ended (§3.2). */
export type AskSendState = 'reserved' | 'sent' | 'not_sent' | 'send_unknown';

/** One ledger row, as the server reads it. */
export interface AskCorrelation {
  askId: string;
  worktreeId: string;
  instanceId: string;
  cliToolId: string;
  bodyDigest: string;
  sendState: AskSendState;
  sentMessageId: string | null;
  /** The native session the envelope was seen in (claude's transcript session id). Written by the reader (§0.4). */
  nativeSessionId: string | null;
  /** The native input that carried the envelope (claude's prompt record uuid). */
  nativeInputId: string | null;
  /** The turn's key in History (`claude-turn:<uuid>`). */
  nativeTurnKey: string | null;
  /** The assistant rows the reply is, in order. */
  assistantMessageIds: string[];
  /** The send API's reading of "a turn was open at the input" (R3); null when not known. */
  turnOpenAtSend: boolean | null;
  /**
   * The answering turn also absorbed a background-task notice (design §7 (a) ②:
   * not another input, but the reply may react to it).
   */
  notified: boolean;
  /** I8: a second native input of this envelope was seen before the send's outcome was saved. */
  duplicateSeen: boolean;
  /** I8: this ask was seen absorbed into another turn before the send's outcome was saved. */
  absorbedSeen: boolean;
  /** H4: sha256 and length of the reply as it was settled `matched`; null otherwise. */
  replyDigest: string | null;
  replyLength: number | null;
  attributionState: AskAttributionState;
  reason: AskAttributionReason | null;
  createdAt: number;
  updatedAt: number;
}

/** `GET /api/asks/capabilities`. */
export interface AskCapabilitiesResponse {
  protocol: number;
  /** Per tool: whether the server attributes an ask's reply by the ledger. */
  tools: Record<string, boolean>;
}

/** `GET /api/asks/:askId`. */
export interface AskAttributionResponse {
  askId: string;
  state: AskAttributionState;
  reason: AskAttributionReason | null;
  /** The reply, only when `state === 'matched'`. */
  reply: string | null;
  sendState: AskSendState;
  /** Whether the reader has seen the native input that carried the envelope. */
  nativeInputSeen: boolean;
  /** The answering turn also absorbed a background-task notice (§7 (a) ②). */
  notified: boolean;
}

/** The `ask` field of a send's answer (`POST /api/worktrees/:id/send`). */
export interface AskSendAnswer {
  id: string | null;
  state: AskAttributionState;
  reason: AskAttributionReason | null;
  sendState?: AskSendState;
}
