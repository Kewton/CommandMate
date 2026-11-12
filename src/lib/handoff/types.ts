/**
 * The shapes of the hand-off API as the screen and the CLI read them (Issue #4227,
 * design `mem-ui-4227.md` §4.3). Types and constants only: the client imports this.
 *
 * @module lib/handoff/types
 */

import type { MemItemView } from '@/types/mem';

export type HandoffRequestStateView = 'awaiting_agent' | 'reviewing' | 'applying' | 'ending' | 'ended' | 'cancelled' | 'expired';
export type HandoffProposalStateView = 'proposed' | 'approved' | 'applied' | 'conflict' | 'discarded' | 'failed' | 'expired';

/** The agent's window (5 min), the extensions (2 × 5 min) and the request's life (60 min), design §4.3・§9 U1. */
export const HANDOFF_AGENT_WINDOW_MS = 5 * 60 * 1000;
export const HANDOFF_MAX_EXTENSIONS = 2;
export const HANDOFF_REQUEST_TTL_MS = 60 * 60 * 1000;
/** Ended, cancelled and expired requests are kept 14 days (§4.3). */
export const HANDOFF_RETAIN_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The codes the hand-off answers with besides mem's own (`MemErrorCode`). All 409 but
 * `not_found` (404) and `screen_only` (403).
 */
export const HANDOFF_ERROR_CODES = [
  'screen_only',
  'not_found',
  'unattended',
  'session_unknown',
  'request_open',
  'session_changed',
  'request_closed',
  'version_conflict',
  'not_requested',
  'proposal_changed',
  'state_forbids',
  'extend_limit',
  'not_stopped',
  'end_token_changed',
  'already_recorded',
] as const;
export type HandoffErrorCode = (typeof HANDOFF_ERROR_CODES)[number];

export interface HandoffRequestView {
  id: string;
  worktreeId: string;
  instanceId: string;
  cliToolId: string;
  branch: string | null;
  detached: boolean;
  state: HandoffRequestStateView;
  sendState: 'unsent' | 'sent' | 'failed';
  endForced: boolean;
  /** Set while the stop is declared (`ending`) and kept after it is recorded: `end/observe` sends it back. */
  endToken: string | null;
  outcome: 'confirmed' | 'unconfirmed' | null;
  outcomeReason: string | null;
  agentDeadlineAt: string;
  extensions: number;
  expiresAt: string;
  agentDoneAt: string | null;
  endedAt: string | null;
  /** The agent's window passed with no `done` (decided when read, §4.4). */
  agentTimedOut: boolean;
  version: number;
}

export interface HandoffProposalView {
  id: string;
  op: 'add' | 'update' | 'close';
  itemId: string | null;
  kind: string;
  baseVersion: number | null;
  revision: number;
  fingerprint: string;
  state: HandoffProposalStateView;
  stateReason: string | null;
  /** What it proposes; absent when withheld (a field matched a rule the proposal was not checked against, H12). */
  payload?: { text?: string; closeWhen?: string; evidence?: string[]; promoteTo?: string; reason?: string; kind?: string };
  withheld?: { field: string; rule: string };
  /** The item as stored now (update / close), through mem's exit check; null when gone. */
  current: MemItemView | null;
  appliedItemId: string | null;
  appliedVersion: number | null;
}

/** An item of the branch an agent changed after the request without a proposal (G2, read only). */
export interface HandoffDirectChangeView {
  id: string;
  kind: string;
  state: string;
  version: number;
  updatedByInstance: string | null;
  updatedAt: string;
}

export interface HandoffReadResponse {
  ok: true;
  request: HandoffRequestView;
  proposals: HandoffProposalView[];
  direct: HandoffDirectChangeView[];
}

export interface HandoffCreateResponse extends HandoffReadResponse {
  /** The fixed text the screen sends the agent (§4.2). */
  text: string;
}

export type HandoffDecideResult =
  | 'applied'
  | 'conflict'
  | 'failed'
  | 'discarded'
  | 'proposal_changed'
  | 'expired';

export interface HandoffDecideResponse extends HandoffReadResponse {
  results: Array<{ proposalId: string; result: HandoffDecideResult; code?: string }>;
}

export interface HandoffEndResponse extends HandoffReadResponse {
  endToken: string;
}

export interface HandoffErrorBody {
  ok: false;
  code: string;
  message: string;
  [key: string]: unknown;
}
