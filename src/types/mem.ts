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
}
