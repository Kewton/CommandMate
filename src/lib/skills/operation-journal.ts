/**
 * Operation journal and idempotency for Skill operations (Issue #1234)
 *
 * The journal is the crash-recovery record that lets install/uninstall converge
 * on one answer after a restart. Its central rule is that the **filesystem
 * atomic rename is the commit point**: once an operation reaches FS_COMMITTED,
 * the payload exists and a later DB or index failure must not be reported as a
 * rollback. Such an operation moves to FAILED_RECONCILABLE and is driven
 * forward from the receipt, never backwards.
 *
 * ```text
 * PREPARING ──▶ FS_COMMITTED ──▶ INDEXED ──▶ SUCCEEDED
 *     │              │              │
 *     └──────────────┴──────────────┴──▶ FAILED_RECONCILABLE ──▶ INDEXED/SUCCEEDED
 * ```
 *
 * The reverse edge out of FAILED_RECONCILABLE is guarded: it is only legal when
 * the entry recorded a filesystem commit. A failure before the commit point is
 * genuinely rolled back and stays terminal.
 *
 * Idempotency keys are bound to actor, operation, target and plan. Replaying a
 * request returns the recorded entry instead of writing the payload twice; the
 * *same* key with a *different* binding is a conflict rather than a silent
 * substitution of someone else's plan.
 *
 * @module lib/skills/operation-journal
 */

import { readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import {
  SKILL_JOURNAL_DIRNAME,
  ensureSkillStateDir,
  readSkillStateFile,
  redactSkillOperationText,
  writeSkillStateFile,
  type SkillOperationStoreOptions,
} from '@/lib/skills/operation-store';

/**
 * Journal states.
 *
 * Local to this module rather than added to the #1228 contract: these describe
 * CommandMate's internal execution, not the published distribution documents.
 */
export const SKILL_OPERATION_STATES = [
  'PREPARING',
  'FS_COMMITTED',
  'INDEXED',
  'SUCCEEDED',
  'FAILED_RECONCILABLE',
] as const;

export type SkillOperationState = (typeof SKILL_OPERATION_STATES)[number];

/** Operations that share the lock/journal machinery. */
export type SkillOperationKind = 'install' | 'uninstall' | 'update';

/** Who requested the operation. Carries no credential material. */
export interface SkillOperationActor {
  type: 'user' | 'cli' | 'system';
  /** Stable identifier from the auth context, or null for an unauthenticated local run. */
  id: string | null;
}

/** What the operation acts on. */
export interface SkillOperationTarget {
  worktreeId: string;
  skillId: string;
  /** Target version; null for uninstall. */
  version: string | null;
}

/** Immutable provenance of the artifact, recorded for audit. */
export interface SkillOperationSource {
  /** Distribution origin, e.g. `github-release`. */
  origin: string;
  repository: string;
  ref: string;
  /** Resolved 40-hex commit SHA. */
  commit: string;
  /** Lowercase hex SHA-256 of the artifact. */
  artifactSha256: string;
}

/** Typed failure recorded on the journal. Message is redacted before storage. */
export interface SkillOperationError {
  code: string;
  message: string;
}

/** Inputs an idempotency key is bound to. */
export interface SkillOperationBinding {
  actor: SkillOperationActor;
  operation: SkillOperationKind;
  target: SkillOperationTarget;
  /** Digest of the resolved plan, so a drifting plan cannot reuse a key. */
  planHash: string;
}

/** One journal entry. */
export interface SkillOperationJournalEntry {
  schemaVersion: 1;
  operationId: string;
  idempotencyKey: string;
  bindingHash: string;
  operation: SkillOperationKind;
  state: SkillOperationState;
  actor: SkillOperationActor;
  target: SkillOperationTarget;
  source: SkillOperationSource | null;
  lockKey: string;
  createdAt: number;
  updatedAt: number;
  /** When the atomic rename landed. Non-null means the payload exists. */
  fsCommittedAt: number | null;
  /** Digest of the canonical install receipt written at commit time. */
  receiptDigest: string | null;
  error: SkillOperationError | null;
  history: Array<{ state: SkillOperationState; at: number }>;
}

export interface SkillJournalOptions extends SkillOperationStoreOptions {
  now?: number;
}

/** Legal forward edges. Anything else is a programming error. */
const ALLOWED_TRANSITIONS: Record<SkillOperationState, readonly SkillOperationState[]> = {
  PREPARING: ['FS_COMMITTED', 'FAILED_RECONCILABLE'],
  FS_COMMITTED: ['INDEXED', 'FAILED_RECONCILABLE'],
  INDEXED: ['SUCCEEDED', 'FAILED_RECONCILABLE'],
  FAILED_RECONCILABLE: ['INDEXED', 'SUCCEEDED', 'FAILED_RECONCILABLE'],
  SUCCEEDED: [],
};

/** Raised on an illegal state transition. */
export class SkillOperationTransitionError extends Error {
  constructor(
    readonly from: SkillOperationState,
    readonly to: SkillOperationState,
    reason: string
  ) {
    super(`Illegal Skill operation transition ${from} -> ${to}: ${reason}`);
    this.name = 'SkillOperationTransitionError';
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Digest of everything an idempotency key is bound to.
 *
 * Two requests may only share a key when they mean the same thing: same actor,
 * same operation, same target and same resolved plan.
 */
export function computeSkillOperationBindingHash(binding: SkillOperationBinding): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        actor: binding.actor,
        operation: binding.operation,
        target: binding.target,
        planHash: binding.planHash,
      })
    )
    .digest('hex');
}

/**
 * Derive an idempotency key when the client did not supply one.
 * Identical requests then collapse onto one operation by construction.
 */
export function deriveSkillOperationIdempotencyKey(binding: SkillOperationBinding): string {
  return computeSkillOperationBindingHash(binding);
}

function getJournalDir(options: SkillJournalOptions): string {
  return ensureSkillStateDir(SKILL_JOURNAL_DIRNAME, options);
}

/** Journal filename. The key is hashed so a client-supplied string never names a file. */
function getJournalPath(idempotencyKey: string, options: SkillJournalOptions): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return join(getJournalDir(options), `${digest}.json`);
}

function isJournalEntry(value: unknown): value is SkillOperationJournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<SkillOperationJournalEntry>;
  return (
    typeof entry.operationId === 'string' &&
    typeof entry.idempotencyKey === 'string' &&
    typeof entry.bindingHash === 'string' &&
    typeof entry.state === 'string' &&
    (SKILL_OPERATION_STATES as readonly string[]).includes(entry.state)
  );
}

/** Read the entry recorded for an idempotency key. */
export function readSkillOperationJournal(
  idempotencyKey: string,
  options: SkillJournalOptions = {}
): SkillOperationJournalEntry | null {
  const entry = readSkillStateFile<unknown>(getJournalPath(idempotencyKey, options));
  return isJournalEntry(entry) ? entry : null;
}

/** Every entry currently on disk, oldest first. */
export function listSkillOperationJournal(
  options: SkillJournalOptions = {}
): SkillOperationJournalEntry[] {
  const dir = getJournalDir(options);
  const entries: SkillOperationJournalEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const parsed = readSkillStateFile<unknown>(join(dir, name));
    if (isJournalEntry(parsed)) entries.push(parsed);
  }
  return entries.sort((a, b) => a.createdAt - b.createdAt);
}

/** Persist an entry. */
export function writeSkillOperationJournal(
  entry: SkillOperationJournalEntry,
  options: SkillJournalOptions = {}
): void {
  writeSkillStateFile(getJournalPath(entry.idempotencyKey, options), entry);
}

/** Drop an entry once it is past its retention window. */
export function deleteSkillOperationJournal(
  idempotencyKey: string,
  options: SkillJournalOptions = {}
): void {
  try {
    unlinkSync(getJournalPath(idempotencyKey, options));
  } catch {
    // Already collected.
  }
}

/**
 * How long a terminal journal entry is kept before it becomes collectable.
 *
 * The journal is the crash-recovery and idempotency record, not the audit trail
 * (that lives in the append-only `skill_operations` table). A terminal entry is
 * only still useful for the window during which a client might retry the same
 * idempotency key; past it, the entry is pure growth. Seven days comfortably
 * covers realistic retry and support windows while bounding the directory to the
 * operations of one window rather than of all time (Issue #1428).
 */
export const SKILL_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Collect terminal journal entries whose retention window has elapsed.
 *
 * Only {@link isSkillOperationTerminal} entries are eligible: SUCCEEDED, and a
 * pre-commit FAILED_RECONCILABLE that rolled back cleanly. A FAILED_RECONCILABLE
 * that *did* commit to the filesystem is non-terminal — it still owes the
 * reconciler an index write — and is never pruned, so a genuine
 * payload-on-disk/no-index inconsistency is not silently discarded. Retention is
 * measured from `updatedAt`, which for a terminal entry is the moment it reached
 * its terminal state and never moves again.
 *
 * Uniform retention across both terminal outcomes is deliberate (Issue #1428):
 * a SUCCEEDED entry that were deleted immediately would let a delayed retry of
 * the *same* idempotency key re-run the install and hit a spurious
 * DESTINATION_EXISTS, so success and failure expire on the same clock and a key
 * becomes reusable at a single, predictable time regardless of outcome.
 *
 * @returns the idempotency keys of the entries that were pruned.
 */
export function pruneExpiredSkillOperationJournal(
  options: SkillJournalOptions & { retentionMs?: number } = {}
): string[] {
  const now = options.now ?? Date.now();
  const retentionMs = options.retentionMs ?? SKILL_JOURNAL_RETENTION_MS;
  const pruned: string[] = [];
  for (const entry of listSkillOperationJournal(options)) {
    if (!isSkillOperationTerminal(entry)) continue;
    if (now - entry.updatedAt <= retentionMs) continue;
    deleteSkillOperationJournal(entry.idempotencyKey, options);
    pruned.push(entry.idempotencyKey);
  }
  return pruned;
}

export type SkillOperationBeginResult =
  | { ok: true; entry: SkillOperationJournalEntry; replayed: boolean }
  | { ok: false; reason: 'IDEMPOTENCY_KEY_CONFLICT'; entry: SkillOperationJournalEntry };

/**
 * Open an operation, or return the one this request already started.
 *
 * A replay hands back the recorded entry so the caller can answer with the
 * original outcome instead of writing the payload a second time.
 */
export function beginSkillOperation(
  input: {
    idempotencyKey?: string;
    binding: SkillOperationBinding;
    lockKey: string;
    source?: SkillOperationSource | null;
  },
  options: SkillJournalOptions = {}
): SkillOperationBeginResult {
  const bindingHash = computeSkillOperationBindingHash(input.binding);
  const idempotencyKey =
    input.idempotencyKey ?? deriveSkillOperationIdempotencyKey(input.binding);

  const existing = readSkillOperationJournal(idempotencyKey, options);
  if (existing !== null) {
    if (existing.bindingHash !== bindingHash) {
      return { ok: false, reason: 'IDEMPOTENCY_KEY_CONFLICT', entry: existing };
    }
    return { ok: true, entry: existing, replayed: true };
  }

  const now = options.now ?? Date.now();
  const entry: SkillOperationJournalEntry = {
    schemaVersion: 1,
    operationId: randomUUID(),
    idempotencyKey,
    bindingHash,
    operation: input.binding.operation,
    state: 'PREPARING',
    actor: input.binding.actor,
    target: input.binding.target,
    source: input.source ?? null,
    lockKey: input.lockKey,
    createdAt: now,
    updatedAt: now,
    fsCommittedAt: null,
    receiptDigest: null,
    error: null,
    history: [{ state: 'PREPARING', at: now }],
  };
  writeSkillOperationJournal(entry, options);
  return { ok: true, entry, replayed: false };
}

/** Fields a transition may attach to the entry. */
export interface SkillOperationTransitionPatch {
  source?: SkillOperationSource | null;
  receiptDigest?: string | null;
  error?: SkillOperationError | null;
}

/**
 * Advance an operation to its next state and persist it.
 *
 * @throws SkillOperationTransitionError when the edge is not legal, or when a
 *   recovery edge is attempted on an operation that never reached the commit
 *   point (there is no receipt to converge from).
 */
export function transitionSkillOperation(
  entry: SkillOperationJournalEntry,
  next: SkillOperationState,
  patch: SkillOperationTransitionPatch = {},
  options: SkillJournalOptions = {}
): SkillOperationJournalEntry {
  if (!ALLOWED_TRANSITIONS[entry.state].includes(next)) {
    throw new SkillOperationTransitionError(entry.state, next, 'edge is not defined');
  }

  const now = options.now ?? Date.now();
  const fsCommittedAt =
    next === 'FS_COMMITTED' ? (entry.fsCommittedAt ?? now) : entry.fsCommittedAt;

  if ((next === 'INDEXED' || next === 'SUCCEEDED') && fsCommittedAt === null) {
    throw new SkillOperationTransitionError(
      entry.state,
      next,
      'no filesystem commit point was recorded'
    );
  }

  const updated: SkillOperationJournalEntry = {
    ...entry,
    state: next,
    updatedAt: now,
    fsCommittedAt,
    source: patch.source !== undefined ? patch.source : entry.source,
    receiptDigest: patch.receiptDigest !== undefined ? patch.receiptDigest : entry.receiptDigest,
    error:
      patch.error !== undefined
        ? patch.error === null
          ? null
          : { code: patch.error.code, message: redactSkillOperationText(patch.error.message) }
        : entry.error,
    history: [...entry.history, { state: next, at: now }],
  };
  writeSkillOperationJournal(updated, options);
  return updated;
}

/** Whether the payload is known to exist, regardless of how the DB side ended. */
export function hasSkillFilesystemCommit(entry: SkillOperationJournalEntry): boolean {
  return entry.fsCommittedAt !== null;
}

/** Whether an entry still needs work from the reconciler. */
export function isSkillOperationTerminal(entry: SkillOperationJournalEntry): boolean {
  if (entry.state === 'SUCCEEDED') return true;
  // A failure before the commit point rolled back cleanly; nothing to converge.
  return entry.state === 'FAILED_RECONCILABLE' && !hasSkillFilesystemCommit(entry);
}
