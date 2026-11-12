/**
 * mem: typed items that carry the state of a piece of work across sessions (Issue #4221).
 *
 * Shared by the server, the screen and the CLI. Holds no runtime besides constants,
 * so the CLI build can import it. Design: `docs/design/mem-store-4221.md`.
 *
 * @module types/mem
 */

/** off: nothing is evaluated or written. derived: the brief shows derived state only. on: everything. */
export const MEM_MODES = ['off', 'derived', 'on'] as const;
export type MemMode = (typeof MEM_MODES)[number];

export const MEM_KINDS = ['now', 'waiting', 'decision', 'next', 'external', 'note'] as const;
export type MemKind = (typeof MEM_KINDS)[number];

export const MEM_STATES = ['open', 'recorded', 'promoted', 'closed'] as const;
export type MemState = (typeof MEM_STATES)[number];

export const MEM_CLOSE_REASONS = ['manual', 'condition', 'superseded', 'slot-removed', 'withdrawn'] as const;
export type MemCloseReason = (typeof MEM_CLOSE_REASONS)[number];

export function isMemMode(value: unknown): value is MemMode {
  return typeof value === 'string' && (MEM_MODES as readonly string[]).includes(value);
}

export function isMemKind(value: unknown): value is MemKind {
  return typeof value === 'string' && (MEM_KINDS as readonly string[]).includes(value);
}

/** Stored form of `close_when` (§2.2). `schema` is the version of this shape. */
export type MemCloseWhen =
  | { schema: 1; type: 'manual' }
  | { schema: 1; type: 'replaced' }
  | { schema: 1; type: 'issue'; host: string; owner: string; repo: string; number: number }
  | { schema: 1; type: 'pr'; host: string; owner: string; repo: string; number: number; state: 'merged' | 'closed' }
  | {
      schema: 1;
      type: 'branch';
      repositoryId: string;
      name: string;
      event: 'merged' | 'deleted';
      into: string | null;
      scope: 'local' | 'remote';
      tipAtCreate: string;
    }
  | { schema: 1; type: 'relay'; relayId: string }
  | { schema: 1; type: 'worktree'; worktreeId: string; worktreeIncarnation: string }
  | { schema: 1; type: 'session'; sessionId: string; sessionGeneration: string | null }
  | { schema: 1; type: 'at'; epochMs: number; offset: string };

export type MemCloseWhenType = MemCloseWhen['type'];

/**
 * Every type the grammar knows, in the order of the table (§2.3). This and the two tables below
 * are `lib/mem/close-when`'s (re-exported there), kept here so the CLI can read them (#4227 G-PR4).
 */
export const CLOSE_WHEN_TYPES: readonly MemCloseWhenType[] = [
  'replaced',
  'manual',
  'issue',
  'pr',
  'branch',
  'relay',
  'worktree',
  'session',
  'at',
];

/** §2.3: which kind takes which type. The fixture holds the same table. */
export const CLOSE_WHEN_ALLOWED: Readonly<Record<MemKind, ReadonlySet<MemCloseWhenType>>> = {
  now: new Set(['replaced', 'issue', 'pr', 'branch', 'relay', 'worktree', 'session', 'at']),
  waiting: new Set(['issue', 'pr', 'branch', 'relay', 'worktree', 'session', 'at']),
  decision: new Set(['issue', 'pr', 'branch', 'at']),
  next: new Set(['manual', 'issue', 'pr', 'branch', 'relay', 'worktree', 'session', 'at']),
  external: new Set(['manual', 'issue', 'pr', 'branch', 'at']),
  note: new Set(['manual', 'at']),
};

/**
 * What an omitted condition means per kind. `null`: required. `promoted`: the
 * decision default, stored as NULL and closed only by its transitions (§3.2).
 */
export const CLOSE_WHEN_DEFAULTS: Readonly<Record<MemKind, 'replaced' | 'manual' | 'promoted' | null>> = {
  now: 'replaced',
  waiting: null,
  decision: 'promoted',
  next: null,
  external: null,
  note: 'manual',
};

/** Who an item belongs to (§12.3). */
export interface MemItemOwner {
  repositoryId: string;
  /** null: detached HEAD. */
  branch: string | null;
  worktreeId: string;
  worktreeIncarnation: string;
  instanceId: string;
  cliToolId: string;
  incarnation: string;
  sessionGeneration: string | null;
}

/** Set instead of every free-text field when a current rule matches a stored value (§6.4). */
export interface MemWithheld {
  code: 'secret_like';
  field: string;
  rule: string;
}

/** One item as the API and `--json` carry it (§12.3). */
export interface MemItemView {
  id: string;
  kind: MemKind;
  state: MemState;
  text?: string;
  closeWhen?: MemCloseWhen | null;
  promoteTo?: string | null;
  quote?: string | null;
  quoteAt?: string | null;
  evidence?: string[];
  closeNote?: string | null;
  withheld?: MemWithheld;
  owner: MemItemOwner;
  createdBy: 'agent' | 'human';
  updatedBy: 'agent' | 'human' | 'server';
  version: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeReason: MemCloseReason | null;
  stale: boolean;
  frozen: boolean;
}

/** The fields an item may carry when it is withheld; nothing that a person or an agent typed. */
export const MEM_WITHHELD_KEPT_KEYS = [
  'id',
  'kind',
  'state',
  'owner',
  'createdBy',
  'updatedBy',
  'version',
  'createdAt',
  'updatedAt',
  'closedAt',
  'closeReason',
  'stale',
  'frozen',
] as const;

/** Per-feature switches kept with the mode (D: inject, F: prompt, G: popup). */
export interface MemFeatures {
  injectOnStart: boolean;
  promptOnEvents: boolean;
  popup: boolean;
}

export const MEM_FEATURE_KEYS = ['injectOnStart', 'promptOnEvents', 'popup'] as const;

/** A repository rule: the first that matches wins. */
export interface MemBranchRule {
  match: 'glob' | 'detached';
  /** Set exactly when `match` is `glob`. `*` stays within one path segment, `**` crosses `/`. */
  pattern: string | null;
  mode: MemMode;
}

/** A branch's own setting. A null field follows the rules / the repository. */
export interface MemBranchOverride {
  branch: string;
  mode: MemMode | null;
  injectOnStart: boolean | null;
  promptOnEvents: boolean | null;
  popup: boolean | null;
}

/** `GET /api/repositories/:id/mem-settings`. */
export interface MemRepositorySettings {
  repositoryId: string;
  /** 0 until the first write. A write names the version it read. */
  version: number;
  features: MemFeatures;
  rules: MemBranchRule[];
  overrides: MemBranchOverride[];
}

/** Which level decided the mode (§12.2 `mem mode`). */
export interface MemModeSource {
  level: 'override' | 'rule' | 'fallback';
  repositoryId: string | null;
  branch: string | null;
  rulePosition: number | null;
  pattern: string | null;
}

/** Every refusal code the mem routes answer with (§12.1). */
export type MemErrorCode =
  | 'invalid_request'
  | 'invalid_close_when'
  | 'control_char'
  | 'secret_like'
  | 'too_long'
  | 'absolute_path'
  | 'outside_repository'
  | 'symlink'
  | 'sensitive_path'
  | 'invalid_evidence'
  | 'invalid_promote_to'
  | 'invalid_quote_at'
  | 'invalid_key'
  | 'target_required'
  | 'disabled'
  | 'version_conflict'
  | 'version_required'
  | 'not_registered'
  | 'item_not_found'
  | 'instance_not_found'
  | 'branch_unresolved'
  | 'ambiguous'
  | 'duplicate_key'
  | 'not_owner'
  | 'state_forbids'
  | 'limit_exceeded'
  | 'screen_only'
  | 'not_found'
  | 'internal_error';

/** Exit code of the CLI per refusal code (§12.1). */
export const MEM_EXIT_BY_CODE: Readonly<Record<MemErrorCode, number>> = {
  invalid_request: 2,
  invalid_close_when: 2,
  control_char: 2,
  secret_like: 2,
  too_long: 2,
  absolute_path: 2,
  outside_repository: 2,
  symlink: 2,
  sensitive_path: 2,
  invalid_evidence: 2,
  invalid_promote_to: 2,
  invalid_quote_at: 2,
  invalid_key: 2,
  target_required: 2,
  disabled: 50,
  version_conflict: 51,
  version_required: 51,
  not_registered: 52,
  item_not_found: 52,
  instance_not_found: 52,
  branch_unresolved: 52,
  not_found: 52,
  ambiguous: 53,
  duplicate_key: 54,
  not_owner: 55,
  state_forbids: 55,
  limit_exceeded: 56,
  screen_only: 2,
  internal_error: 99,
};

/** A refusal as the mem routes send it. Never carries the refused input. */
export interface MemErrorBody {
  ok: false;
  code: MemErrorCode;
  message: string;
  field?: string;
  rule?: string;
  limit?: number;
  reason?: string;
  mode?: MemMode;
  source?: MemModeSource;
  currentVersion?: number;
  item?: MemItemView;
  itemId?: string;
  roots?: Array<{ repositoryId: string; name: string }>;
}

/** `GET …/mem/mode`. */
export interface MemModeResponse {
  ok: true;
  mode: MemMode;
  source: MemModeSource;
  target: { via: 'worktree' | 'repository'; worktreeId: string | null };
  branch: string | null;
  detached: boolean;
  features: MemFeatures;
  repositoryIds: string[];
}

export interface MemWarning {
  code: 'open_count' | 'closed_count';
  kind?: MemKind;
  count: number;
  threshold: number;
}

/** `GET …/mem` (list). */
export interface MemListResponse {
  ok: true;
  mode: MemMode;
  branch: string | null;
  items: MemItemView[];
  now: Array<{ instanceId: string; item: MemItemView }>;
  warnings: MemWarning[];
  /** Issue #4222: the evaluation of each listed item's condition, by item id (mode `on` only). */
  conditions?: Record<string, MemConditionView>;
}

/** A write that succeeded. */
export interface MemWriteResponse {
  ok: true;
  item: MemItemView;
  replayed: boolean;
  warnings: MemWarning[];
}

/** `POST …/mem/purge`. */
export interface MemPurgeResponse {
  ok: true;
  dryRun: boolean;
  counts: Partial<Record<MemKind, number>>;
  /** Notices of the items counted (deleted with them, Issue #4222). */
  notices?: number;
}

// ===========================================================================
// close_when evaluation and the end of an item (Issue #4222, design
// `docs/design/mem-close-when-4222.md`)
// ===========================================================================

/** The three answers of a condition (§1.1). `unknown` never closes anything. */
export const MEM_CONDITION_RESULTS = ['met', 'not-met', 'unknown'] as const;
export type MemConditionResult = (typeof MEM_CONDITION_RESULTS)[number];

/** Whether the end was what the item waited for (D8): apart from the condition being met. */
export const MEM_END_OUTCOMES = ['success', 'failure', 'unknown'] as const;
export type MemEndOutcome = (typeof MEM_END_OUTCOMES)[number];

/** Who asked for the evaluation (§1.1). */
export const MEM_EVAL_TRIGGERS = ['list', 'check', 'brief', 'preview'] as const;
export type MemEvalTrigger = (typeof MEM_EVAL_TRIGGERS)[number];

/** Why a condition is unknown (§1.9). Fixed words: callers branch on them, never on prose. */
export const MEM_UNKNOWN_REASONS = [
  'not_found',
  'unauthenticated',
  'forbidden',
  'rate_limited',
  'remote_error',
  'offline',
  'query_timeout',
  'gh_unavailable',
  'unexpected_response',
  'not_an_issue',
  'host_not_allowed',
  'repository_unavailable',
  'objects_missing',
  'branch-diverged',
  'branch-order-uncertain',
  'branch-gone-unmerged-unknown',
  'relay_not_found',
  'relay-delivery-uncertain',
  'session_not_found',
  'session_kind_unknown',
  'schema_unknown',
  'query_budget_exhausted',
  'deadline_exceeded',
] as const;
export type MemUnknownReason = (typeof MEM_UNKNOWN_REASONS)[number];

/** Why a condition is met or not met (§1.2〜§1.8・§2). */
export const MEM_DECIDED_REASONS = [
  'issue-closed',
  'issue-open',
  'pr-merged',
  'pr-closed',
  'pr-open',
  'pr-closed-unmerged',
  'branch-deleted',
  'branch-recreated',
  'branch-present',
  'branch-present-no-baseline',
  'branch-merged',
  'branch-merged-pr',
  'no-new-commits',
  'not-merged',
  'relay-open',
  'relay-prompt',
  'relay-delivered',
  'relay-delivery-attempting',
  'relay-payload-pending',
  'relay-expired',
  'relay-cancelled',
  'task-succeeded',
  'task-cancelled',
  'task-running',
  'task-reopenable',
  'verify-passed',
  'verify-failed',
  'verify-error',
  'verify-not_started',
  'verify-cancelled',
  'verify-running',
  'schedule-completed',
  'schedule-failed',
  'schedule-timeout',
  'schedule-cancelled',
  'schedule-running',
  'worktree-alive',
  'worktree-deleted',
  'time-passed',
  'time-not-yet',
] as const;
export type MemDecidedReason = (typeof MEM_DECIDED_REASONS)[number];

export type MemConditionReason = MemUnknownReason | MemDecidedReason;

/** The evaluation of one item's condition, as the list and `check` carry it. */
export interface MemConditionView {
  result: MemConditionResult;
  reason: MemConditionReason;
  /** Set when met: whether the end was what was waited for. */
  outcome?: MemEndOutcome;
  evaluatedAt: string;
  /** Closed by this evaluation. */
  closed: boolean;
  /** A decision met before it was promoted: kept open, not reflected yet (§5). */
  unreflected?: boolean;
}

/** `POST …/mem/check`. */
export interface MemCheckResponse {
  ok: true;
  mode: MemMode;
  branch: string | null;
  results: Array<{ itemId: string; kind: MemKind; type: MemCloseWhenType | null; condition: MemConditionView }>;
}

export const MEM_NOTICE_AUDIENCES = ['creator', 'successor'] as const;
export type MemNoticeAudience = (typeof MEM_NOTICE_AUDIENCES)[number];

/** The send result D hands to the settle (`SendAttemptState` of `lib/session/send-attempt-types.ts`). */
export type MemNoticeSendState = 'sent' | 'not-sent' | 'indeterminate';

/** One "it ended" notice as C, D and the screen read it (§3.3・§3.5). Free text never in it. */
export interface MemNoticeView {
  id: string;
  itemId: string;
  repositoryId: string;
  branch: string | null;
  origin: { worktreeId: string; instanceId: string; cliToolId: string; incarnation: string; itemCreatedAt: string };
  state: 'pending' | 'reserved' | 'acknowledged';
  /** Who may take it now; null in the screen's list when no session may. */
  audience: MemNoticeAudience | null;
  /** The delivery of an earlier brief could not be confirmed (stale attempts counted in, §3.5). */
  uncertain: boolean;
  uncertainCount: number;
  endReason: string;
  outcome: MemEndOutcome;
  closedAt: string;
  version: number;
  acknowledgedBy: 'creator' | 'successor' | 'human' | null;
}

/** `GET /api/repositories/:id/mem/notices`. */
export interface MemNoticeListResponse {
  ok: true;
  notices: MemNoticeView[];
}
