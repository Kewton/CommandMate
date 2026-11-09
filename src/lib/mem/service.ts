/**
 * What the mem routes do, apart from Next (Issue #4221). Each function answers
 * `{ status, body }`; a route only parses the body and sends the answer. The CLI
 * maps `body.code` to its exit code (`MEM_EXIT_BY_CODE`).
 *
 * The order of one write (§5.3・§9.3・§10.4):
 * 1. Synchronously, before any await: the worktree, the instance and its
 *    incarnation (fixed here, 2nd review 3), and every check of the input.
 * 2. Await git: what the condition needs (the origin, a tip), then the target.
 * 3. In the target's synchronous stretch: the mode, the condition's final form and
 *    the store's transaction.
 *
 * Nothing refused is repeated in an answer or a log (§7): errors carry the code,
 * the field, the rule and the limit.
 *
 * @module lib/mem/service
 */

import type Database from 'better-sqlite3';
import { getAllRepositories } from '@/lib/db/db-repository';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { MAX_SESSION_NOTE_LENGTH, normalizeSessionNoteText, sessionNoteLength } from '@/lib/db/agent-instances-db';
import {
  closeMemItem,
  closeMemItemVersioned,
  countClosedItems,
  countOpenItems,
  createMemItem,
  getMemRecord,
  isMemSlot,
  listMem,
  MEM_CLOSED_WARN,
  MEM_OPEN_LIMITS,
  purgeMem,
  readSessionSlot,
  replaceNowSlot,
  transitionDecision,
  updateMemItem,
  writeScreenNote,
  type MemActor,
  type MemDecisionTransition,
  type MemScope,
  type MemStoreFailure,
  type MemVersionedCloseTransition,
  type SessionSlotView,
} from '@/lib/db/mem-db';
import { isSameInstanceLifetime, readInstanceLifetime, type InstanceLifetime } from '@/lib/db/session-brief-db';
import { isScreenRequest } from '@/lib/security/screen-request';
import { createLogger } from '@/lib/logger';
import { getMemNotice as getMemNoticeRow, memModeOnFor } from '@/lib/db/mem-close-db';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import {
  isMemKind,
  type MemCheckResponse,
  type MemConditionView,
  type MemErrorBody,
  type MemNoticeListResponse,
  type MemErrorCode,
  type MemKind,
  type MemListResponse,
  type MemModeResponse,
  type MemPurgeResponse,
  type MemWarning,
  type MemWriteResponse,
} from '@/types/mem';
import type { Worktree } from '@/types/models';
import {
  closeWhenGitNeeds,
  finalizeCloseWhen,
  parseCloseWhen,
  parseOriginUrl,
  type CloseWhenDraft,
  type CloseWhenTarget,
} from './close-when';
import { getInstanceIncarnation, getOrCreateWorktreeIncarnation, getWorktreeIncarnation } from './incarnation';
import { evaluateMemConditions, fixMemEvalLifetime, type MemEvalContext, type MemEvalLifetime, type MemEvalDeps, type MemEvalReport } from './evaluate';
import { acknowledgeMemNoticeByHuman, listUndeliveredMemNotices } from './notices';
import type { QueryLimits } from './query-plan';
import { presentMemItem, type MemRecord } from './present';
import { withMemTarget, type MemTarget, type MemTargetDeps, type MemTargetResolved, type MemTargetSpec } from './target';
import {
  parseIsoWithOffset,
  validateEvidence,
  validateItemText,
  validateKey,
  validateMemFields,
  validateNowText,
  validateReason,
  type MemFieldError,
} from './validate';

const logger = createLogger('mem');

export interface MemOutcome {
  status: number;
  body: unknown;
}

const STATUS_BY_CODE: Partial<Record<MemErrorCode, number>> = {
  disabled: 409,
  version_conflict: 409,
  version_required: 409,
  ambiguous: 409,
  duplicate_key: 409,
  not_owner: 409,
  state_forbids: 409,
  limit_exceeded: 409,
  not_registered: 404,
  item_not_found: 404,
  instance_not_found: 404,
  branch_unresolved: 404,
  not_found: 404,
  screen_only: 403,
  internal_error: 500,
};

/** Fixed wording per code: no part of the input reaches a message. */
const MESSAGES: Record<MemErrorCode, string> = {
  invalid_request: 'The request is not valid',
  invalid_close_when: 'The close condition is not valid for this kind',
  control_char: 'A field contains a control character',
  secret_like: 'A field looks like it contains a secret',
  too_long: 'A field is over its limit',
  absolute_path: 'A path must be relative to the repository',
  outside_repository: 'A path leaves the repository',
  symlink: 'A path goes through a symbolic link',
  sensitive_path: 'A path names a sensitive file',
  invalid_evidence: 'An evidence entry is not valid',
  invalid_promote_to: 'The promote destination is not valid',
  invalid_quote_at: 'The quote time must be ISO 8601 with an offset, not in the future',
  invalid_key: 'The key must be 1-128 of [A-Za-z0-9._:-]',
  target_required: 'Name the target',
  disabled: 'mem is not enabled for this branch',
  version_conflict: 'The item changed since that version',
  version_required: 'This note is a mem item; send the version that was read',
  not_registered: 'The worktree belongs to no registered repository',
  item_not_found: 'No such item',
  instance_not_found: 'No such instance in this worktree',
  branch_unresolved: 'The branch of the worktree could not be read',
  ambiguous: 'The repository is ambiguous',
  duplicate_key: 'The key was used for another request',
  not_owner: 'Only the author or a person may change this item',
  state_forbids: 'The item is in a state that does not allow this',
  limit_exceeded: 'Too many open items of this kind on the branch',
  screen_only: 'This change is made from the screen only',
  not_found: 'Not found',
  internal_error: 'Unexpected error',
};

export function memError(code: MemErrorCode, extra: Partial<MemErrorBody> = {}): MemOutcome {
  const body: MemErrorBody = { ok: false, code, message: MESSAGES[code], ...extra };
  return { status: STATUS_BY_CODE[code] ?? 400, body };
}

const fieldError = (error: MemFieldError): MemOutcome =>
  memError(error.code, { field: error.field, ...(error.rule ? { rule: error.rule } : {}), ...(error.limit ? { limit: error.limit } : {}) });

function logRefusal(event: string, error: MemFieldError | { code: string }, context: Record<string, unknown>): void {
  logger.info(event, { ...context, code: error.code, ...('field' in error ? { field: error.field, rule: error.rule } : {}) });
}

function targetFailure(target: Exclude<MemTarget, MemTargetResolved>): MemOutcome {
  return memError(target.code, {
    ...(target.reason ? { reason: target.reason } : {}),
    ...(target.roots ? { roots: target.roots } : {}),
  });
}

function scopeOf(target: MemTargetResolved): MemScope {
  return {
    storageRepositoryId: target.storageRepositoryId,
    readRepositoryIds: target.readRepositoryIds,
    branch: target.detached ? null : target.branch,
    worktreeId: target.worktree?.id ?? null,
  };
}

function storeFailure(failure: MemStoreFailure, frozen = false): MemOutcome {
  switch (failure.code) {
    case 'instance_not_found':
      return memError('instance_not_found', { reason: failure.reason });
    case 'item_not_found':
      return memError('item_not_found');
    case 'version_conflict':
      return memError('version_conflict', {
        currentVersion: failure.current.version,
        item: presentMemItem(failure.current, { frozen }),
      });
    case 'not_owner':
    case 'state_forbids':
      return memError(failure.code, { itemId: failure.current.id });
    case 'duplicate_key':
      return memError('duplicate_key', { itemId: failure.itemId, currentVersion: failure.version });
    case 'limit_exceeded':
      return memError('limit_exceeded', { limit: failure.limit });
  }
}

/** Skip git altogether when nothing is registered: the answer is "not registered" whatever git says. */
async function resolveTarget<R>(
  db: Database.Database,
  spec: MemTargetSpec,
  deps: MemTargetDeps,
  build: (target: MemTarget) => R
): Promise<R> {
  if (getAllRepositories(db).length === 0) return build({ ok: false, code: 'not_registered' });
  return withMemTarget(db, spec, deps, build);
}

// ---------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------

type ActorLookup = { ok: true; worktree: Worktree; actor: MemActor } | { ok: false; outcome: MemOutcome };

/** Read synchronously, before any await: this fixes the incarnation the write is for. */
function lookupActor(db: Database.Database, worktreeId: string, instanceId: unknown, by: 'agent' | 'human'): ActorLookup {
  const worktree = getWorktreeById(db, worktreeId);
  if (!worktree) return { ok: false, outcome: memError('not_found') };
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    return { ok: false, outcome: memError('target_required', { field: 'instanceId' }) };
  }
  const instance = resolveAgentInstances(db, worktreeId, worktree.selectedAgents).find((entry) => entry.id === instanceId);
  if (!instance) return { ok: false, outcome: memError('instance_not_found') };
  const captured = getInstanceIncarnation(db, worktreeId, instanceId);
  // Integration review 2 P1: the worktree's lifetime is fixed here too. Made now when
  // it has none, so a delete and a re-creation under the same id and path during
  // the awaits (which ends it, and may derive the same primary again) is told apart.
  const worktreeIncarnation = getOrCreateWorktreeIncarnation(db, worktreeId);
  return {
    ok: true,
    worktree,
    actor: {
      worktreeId,
      instanceId,
      cliToolId: instance.cliTool,
      capturedIncarnation: captured && captured.cliToolId === instance.cliTool ? captured.incarnation : null,
      sessionGeneration: null,
      by,
      // Asked again in the write's transaction, after the awaits (review P1).
      stillOnRoster: () => {
        if (getWorktreeIncarnation(db, worktreeId) !== worktreeIncarnation) return false;
        const now = getWorktreeById(db, worktreeId);
        return Boolean(
          now &&
            resolveAgentInstances(db, worktreeId, now.selectedAgents).some(
              (entry) => entry.id === instanceId && entry.cliTool === instance.cliTool
            )
        );
      },
    },
  };
}

// ---------------------------------------------------------------------------
// close_when, with what git has to answer
// ---------------------------------------------------------------------------

export interface MemGit {
  originUrl: (worktreePath: string) => Promise<string | null>;
  refTip: (worktreePath: string, ref: string) => Promise<string | null>;
}

async function defaultGit(): Promise<MemGit> {
  const git = await import('./git-observe');
  return { originUrl: git.readOriginUrl, refTip: git.readRefTip };
}

export interface MemServiceDeps extends MemTargetDeps {
  git?: MemGit;
  now?: () => number;
  /** Issue #4222: this server's boot id (stale reservations, §3.5), for tests. */
  bootId?: () => string;
  /** Issue #4222: what the evaluation of the conditions asks (gh, git, the clock), for tests. */
  evaluation?: MemEvalDeps & { limits?: Partial<QueryLimits>; deadlineMs?: number };
}

async function firstTip(git: MemGit, worktreePath: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    const tip = await git.refTip(worktreePath, ref);
    if (tip) return tip;
  }
  return null;
}

async function askConditionGit(
  draft: CloseWhenDraft,
  worktreePath: string,
  deps: MemServiceDeps
): Promise<{ origin: CloseWhenTarget | null; tip: string | null }> {
  const needs = closeWhenGitNeeds(draft);
  if (!needs.origin && needs.tipOf === null) return { origin: null, tip: null };
  const git = deps.git ?? (await defaultGit());
  return {
    origin: needs.origin ? parseOriginUrl(await git.originUrl(worktreePath)) : null,
    tip: needs.tipOf !== null ? await firstTip(git, worktreePath, needs.tipOf) : null,
  };
}

function bindCondition(
  db: Database.Database,
  draft: CloseWhenDraft,
  answers: { origin: CloseWhenTarget | null; tip: string | null },
  repositoryId: string,
  now: number
): { ok: true; json: string | null } | { ok: false } {
  const bound = finalizeCloseWhen(draft, {
    ...answers,
    repositoryId,
    worktreeIncarnation: (worktreeId) => (getWorktreeById(db, worktreeId) ? getOrCreateWorktreeIncarnation(db, worktreeId, now) : null),
    sessionGeneration: null,
  });
  if (!bound.ok) return { ok: false };
  return { ok: true, json: bound.value === null ? null : JSON.stringify(bound.value) };
}

function openWarnings(db: Database.Database, scope: MemScope, kinds: readonly MemKind[]): MemWarning[] {
  const warnings: MemWarning[] = [];
  for (const kind of kinds) {
    if (kind === 'now') continue;
    const count = countOpenItems(db, scope, kind);
    const threshold = MEM_OPEN_LIMITS[kind].warn;
    if (count >= threshold) warnings.push({ code: 'open_count', kind, count, threshold });
  }
  return warnings;
}

const writeOk = (record: MemRecord, replayed: boolean, warnings: MemWarning[]): MemOutcome => {
  const body: MemWriteResponse = { ok: true, item: presentMemItem(record), replayed, warnings };
  return { status: replayed ? 200 : 201, body };
};

// ---------------------------------------------------------------------------
// Writes through the CLI's routes (mode `on` only)
// ---------------------------------------------------------------------------

export async function memWriteNow(
  db: Database.Database,
  worktreeId: string,
  body: Record<string, unknown>,
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  const lookup = lookupActor(db, worktreeId, body.instanceId, 'agent');
  if (!lookup.ok) return lookup.outcome;
  const { worktree, actor } = lookup;
  const text = validateNowText(body.text);
  if (!text.ok) return fieldError(text.error);
  if (text.value.length === 0) return memError('invalid_request', { field: 'text' });
  const evidence = validateEvidence(body.evidence, worktree.path);
  if (!evidence.ok) return fieldError(evidence.error);
  const draft = parseCloseWhen('now', body.closeWhen);
  if (!draft.ok) return memError('invalid_close_when', { field: 'closeWhen', reason: draft.reason });
  const answers = await askConditionGit(draft.draft, worktree.path, deps);

  return resolveTarget(db, { via: 'worktree', worktreeId }, deps, (target) => {
    if (!target.ok) return targetFailure(target);
    if (target.mode !== 'on') return memError('disabled', { mode: target.mode, source: target.source });
    const now = deps.now?.() ?? Date.now();
    const condition = bindCondition(db, draft.draft, answers, target.storageRepositoryId, now);
    if (!condition.ok) return memError('invalid_close_when', { field: 'closeWhen' });
    const result = replaceNowSlot(db, actor, scopeOf(target), { text: text.value, closeWhen: condition.json, evidence: evidence.value }, now);
    if (!result.ok) return storeFailure(result);
    logger.info('mem-now-written', { worktreeId, instanceId: actor.instanceId, itemId: result.record.id, length: text.value.length });
    return writeOk(result.record, false, []);
  });
}

export async function memAddItem(
  db: Database.Database,
  worktreeId: string,
  body: Record<string, unknown>,
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  const lookup = lookupActor(db, worktreeId, body.instanceId, 'agent');
  if (!lookup.ok) return lookup.outcome;
  const { worktree, actor } = lookup;
  if (!isMemKind(body.kind) || body.kind === 'now') return memError('invalid_request', { field: 'kind' });
  const kind = body.kind;
  const now0 = deps.now?.() ?? Date.now();
  const fields = validateMemFields(kind, body, worktree.path, now0);
  if (!fields.ok) {
    logRefusal('mem-item-refused', fields.error, { worktreeId, instanceId: actor.instanceId, kind });
    return fieldError(fields.error);
  }
  let key: string | null = null;
  if (body.key !== undefined && body.key !== null) {
    const checked = validateKey(body.key);
    if (!checked.ok) return fieldError(checked.error);
    key = checked.value;
  }
  const draft = parseCloseWhen(kind, body.closeWhen);
  if (!draft.ok) return memError('invalid_close_when', { field: 'closeWhen', reason: draft.reason });
  const answers = await askConditionGit(draft.draft, worktree.path, deps);

  return resolveTarget(db, { via: 'worktree', worktreeId }, deps, (target) => {
    if (!target.ok) return targetFailure(target);
    if (target.mode !== 'on') return memError('disabled', { mode: target.mode, source: target.source });
    const now = deps.now?.() ?? Date.now();
    const condition = bindCondition(db, draft.draft, answers, target.storageRepositoryId, now);
    if (!condition.ok) return memError('invalid_close_when', { field: 'closeWhen' });
    const scope = scopeOf(target);
    const result = createMemItem(
      db,
      actor,
      scope,
      {
        kind,
        text: fields.value.text,
        closeWhen: condition.json,
        closeWhenInput: typeof body.closeWhen === 'string' ? body.closeWhen : null,
        promoteTo: fields.value.promoteTo,
        quote: fields.value.quote,
        quoteAt: fields.value.quoteAt,
        evidence: fields.value.evidence,
        key,
      },
      now
    );
    if (!result.ok) return storeFailure(result);
    logger.info('mem-item-written', {
      worktreeId,
      instanceId: actor.instanceId,
      itemId: result.record.id,
      kind,
      repositoryId: result.record.owner.repositoryId,
      textLength: fields.value.text.length,
      replayed: result.replayed,
    });
    return writeOk(result.record, result.replayed, openWarnings(db, scope, [kind]));
  });
}

export async function memUpdateItem(
  db: Database.Database,
  worktreeId: string,
  itemId: string,
  body: Record<string, unknown>,
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  const lookup = lookupActor(db, worktreeId, body.instanceId, 'agent');
  if (!lookup.ok) return lookup.outcome;
  const { worktree, actor } = lookup;
  if (typeof body.ifVersion !== 'number' || !Number.isInteger(body.ifVersion) || body.ifVersion < 0) {
    return memError('invalid_request', { field: 'ifVersion' });
  }
  const ifVersion = body.ifVersion;
  const record = getMemRecord(db, itemId);
  if (!record) return memError('item_not_found');
  const patch: { text?: string; closeWhen?: string | null; evidence?: string[] } = {};
  if (body.text !== undefined) {
    const text = record.kind === 'now' ? validateNowText(body.text) : validateItemText(body.text);
    if (!text.ok) return fieldError(text.error);
    if (text.value.length === 0) return memError('invalid_request', { field: 'text' });
    patch.text = text.value;
  }
  if (body.evidence !== undefined) {
    const evidence = validateEvidence(body.evidence, worktree.path);
    if (!evidence.ok) return fieldError(evidence.error);
    patch.evidence = evidence.value;
  }
  let draft: CloseWhenDraft | null = null;
  if (body.closeWhen !== undefined) {
    const parsed = parseCloseWhen(record.kind, body.closeWhen);
    if (!parsed.ok) return memError('invalid_close_when', { field: 'closeWhen', reason: parsed.reason });
    draft = parsed.draft;
  }
  const answers = draft ? await askConditionGit(draft, worktree.path, deps) : { origin: null, tip: null };

  return resolveTarget(db, { via: 'worktree', worktreeId }, deps, (target) => {
    if (!target.ok) return targetFailure(target);
    if (target.mode !== 'on') return memError('disabled', { mode: target.mode, source: target.source });
    const now = deps.now?.() ?? Date.now();
    if (draft) {
      const condition = bindCondition(db, draft, answers, record.owner.repositoryId, now);
      if (!condition.ok) return memError('invalid_close_when', { field: 'closeWhen' });
      patch.closeWhen = condition.json;
    }
    const result = updateMemItem(db, actor, itemId, ifVersion, patch, now);
    if (!result.ok) return storeFailure(result);
    logger.info('mem-item-updated', { worktreeId, instanceId: actor.instanceId, itemId, version: result.record.version });
    return writeOk(result.record, false, []);
  });
}

export async function memCloseItem(
  db: Database.Database,
  worktreeId: string,
  itemId: string,
  body: Record<string, unknown>,
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  const lookup = lookupActor(db, worktreeId, body.instanceId, 'agent');
  if (!lookup.ok) return lookup.outcome;
  const { actor } = lookup;
  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    const checked = validateReason(body.reason);
    if (!checked.ok) return fieldError(checked.error);
    reason = checked.value.length > 0 ? checked.value : null;
  }
  return resolveTarget(db, { via: 'worktree', worktreeId }, deps, (target) => {
    if (!target.ok) return targetFailure(target);
    if (target.mode !== 'on') return memError('disabled', { mode: target.mode, source: target.source });
    const result = closeMemItem(db, actor, itemId, reason, deps.now?.() ?? Date.now());
    if (!result.ok) return storeFailure(result);
    logger.info('mem-item-closed', { worktreeId, instanceId: actor.instanceId, itemId });
    return writeOk(result.record, false, []);
  });
}

// ---------------------------------------------------------------------------
// A person's writes from the screen (Issue #4227, design `mem-ui-4227.md` §0.0b S-A・S-D・§2.3)
// ---------------------------------------------------------------------------

type ScreenRequest = Parameters<typeof isScreenRequest>[0];

/** The refusals only the screen's entrance answers with (all 409; nothing is written). */
export const MEM_SCREEN_REFUSALS = ['incarnation_changed', 'membership_changed', 'confirmation_required', 'fenced'] as const;
export type MemScreenRefusal = (typeof MEM_SCREEN_REFUSALS)[number];

const SCREEN_MESSAGES: Record<MemScreenRefusal, string> = {
  incarnation_changed: 'The worktree or the instance is not the one the request was read for',
  membership_changed: 'The branch is not the one the request was made for',
  confirmation_required: 'Closing a recorded decision needs the confirmation that it is not reflected',
  fenced: 'The request was withdrawn before the write',
};

function screenRefusal(code: MemScreenRefusal, extra: Record<string, unknown> = {}): MemOutcome {
  return { status: 409, body: { ok: false, code, message: SCREEN_MESSAGES[code], ...extra } };
}

export type MemScreenWriteOp = 'add' | 'update' | 'close';

/**
 * What a caller fixed when the person's request (or the hand-off's request) was made,
 * compared in the final stretch (S-A (iii)・(iv)). The screen's own routes pass none:
 * the lifetimes are then fixed when the request is read, and the branch is `expectBranch`.
 */
export interface MemScreenPin {
  worktreeIncarnation: string | null;
  instanceLifetime: Pick<InstanceLifetime, 'incarnation' | 'onRoster'>;
  membership: { repositoryId: string; branch: string | null; detached: boolean };
}

export interface MemScreenWriteInput {
  op: MemScreenWriteOp;
  /** `human`: a person on the screen. `proposer`: an agent's proposal a person approved (written as the agent). */
  author: 'human' | 'proposer';
  /** The item updated or closed (not for `add`). */
  itemId?: string;
  /**
   * The request's fields as sent: `instanceId`, and per op `kind`・`text`・`closeWhen`・
   * `evidence`・`key`・`expectBranch` (add), `ifVersion`・`text`・`closeWhen`・`evidence`
   * (update), `ifVersion`・`reason`・`confirmUnreflected` (close). Never `author`, `pin`
   * or `fence`: those come from the caller, not from the request body.
   */
  body: Record<string, unknown>;
  pin?: MemScreenPin;
  /** Asked in the same transaction just before the write; false writes nothing (`fenced`). */
  fence?: () => boolean;
}

type ScreenPrepared =
  | { op: 'add'; kind: Exclude<MemKind, 'now'>; fields: { text: string; promoteTo: string | null; quote: string | null; quoteAt: number | null; evidence: string[] }; key: string; draft: CloseWhenDraft; closeWhenInput: string | null }
  | { op: 'update'; itemId: string; ifVersion: number; patch: { text?: string; closeWhen?: string | null; evidence?: string[] }; draft: CloseWhenDraft | null }
  | { op: 'close'; itemId: string; ifVersion: number; reason: string | null; confirmUnreflected: boolean };

const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** `expectBranch`: a branch name, or null for a detached HEAD. Undefined when not sent. */
function readExpectBranch(value: unknown): { ok: true; value: string | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || (typeof value === 'string' && value.length > 0)) return { ok: true, value };
  return { ok: false };
}

function prepareScreenWrite(
  db: Database.Database,
  input: MemScreenWriteInput,
  worktreePath: string,
  now0: number
): { ok: true; prepared: ScreenPrepared } | { ok: false; outcome: MemOutcome } {
  const body = input.body;
  const fail = (outcome: MemOutcome) => ({ ok: false as const, outcome });
  if (input.op === 'add') {
    // The `now` slot stays the #2427 note's path (§2.2): refused as A's `memAddItem` does.
    if (!isMemKind(body.kind) || body.kind === 'now') return fail(memError('invalid_request', { field: 'kind' }));
    const kind = body.kind;
    const fields = validateMemFields(kind, body, worktreePath, now0);
    if (!fields.ok) return fail(fieldError(fields.error));
    // One key per press: a second press or a resend is the same item (A §5.4).
    const key = validateKey(body.key);
    if (!key.ok) return fail(fieldError(key.error));
    const draft = parseCloseWhen(kind, body.closeWhen);
    if (!draft.ok) return fail(memError('invalid_close_when', { field: 'closeWhen', reason: draft.reason }));
    return {
      ok: true,
      prepared: {
        op: 'add',
        kind,
        fields: fields.value,
        key: key.value,
        draft: draft.draft,
        closeWhenInput: typeof body.closeWhen === 'string' ? body.closeWhen : null,
      },
    };
  }
  if (typeof input.itemId !== 'string' || input.itemId.length === 0) return fail(memError('invalid_request', { field: 'itemId' }));
  if (!isVersion(body.ifVersion)) return fail(memError('invalid_request', { field: 'ifVersion' }));
  const record = getMemRecord(db, input.itemId);
  if (!record) return fail(memError('item_not_found'));
  if (record.kind === 'now') return fail(memError('invalid_request', { field: 'kind' }));
  if (input.op === 'update') {
    const patch: { text?: string; evidence?: string[] } = {};
    if (body.text !== undefined) {
      const text = validateItemText(body.text);
      if (!text.ok) return fail(fieldError(text.error));
      if (text.value.length === 0) return fail(memError('invalid_request', { field: 'text' }));
      patch.text = text.value;
    }
    if (body.evidence !== undefined) {
      const evidence = validateEvidence(body.evidence, worktreePath);
      if (!evidence.ok) return fail(fieldError(evidence.error));
      patch.evidence = evidence.value;
    }
    let draft: CloseWhenDraft | null = null;
    if (body.closeWhen !== undefined) {
      const parsed = parseCloseWhen(record.kind, body.closeWhen);
      if (!parsed.ok) return fail(memError('invalid_close_when', { field: 'closeWhen', reason: parsed.reason }));
      draft = parsed.draft;
    }
    return { ok: true, prepared: { op: 'update', itemId: input.itemId, ifVersion: body.ifVersion, patch, draft } };
  }
  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    const checked = validateReason(body.reason);
    if (!checked.ok) return fail(fieldError(checked.error));
    reason = checked.value.length > 0 ? checked.value : null;
  }
  if (body.confirmUnreflected !== undefined && typeof body.confirmUnreflected !== 'boolean') {
    return fail(memError('invalid_request', { field: 'confirmUnreflected' }));
  }
  return {
    ok: true,
    prepared: { op: 'close', itemId: input.itemId, ifVersion: body.ifVersion, reason, confirmUnreflected: body.confirmUnreflected === true },
  };
}

/** Whether a stored item belongs to the branch the target resolved (S-A (i)). */
function itemOnTarget(record: MemRecord, target: MemTargetResolved): boolean {
  if (!target.readRepositoryIds.includes(record.owner.repositoryId)) return false;
  const branch = target.detached ? null : target.branch;
  if (record.owner.branch !== branch) return false;
  // A detached item is narrowed to its worktree, as the list narrows it (`scopeClause`).
  return branch !== null || record.owner.worktreeId === target.worktree?.id;
}

/**
 * The one way a person (or a proposal a person approved) writes an item from the
 * screen (Issue #4227, S-A): `add`・`update`・`close`. The same checks as A's three
 * entrances (validate, the condition, the mode `on` of the target), and the writer is
 * `human` for a person. A person passes A's `ownedBy`, so what an agent's entrance
 * gets from the ownership check is asked explicitly here, in the final stretch (the
 * target's synchronous build wrapped in one transaction):
 *
 * - (i) an item updated or closed belongs to the branch this worktree's route resolved;
 * - (ii) the mode is `on`;
 * - (iii) the worktree's lifetime and the instance's (`isSameInstanceLifetime`, so the
 *   lawful `null → lazy` issue is not refused) are those fixed when the request was read
 *   (or the caller's `pin`): otherwise 409 `incarnation_changed`;
 * - (iv) the branch is the one asked for (`pin.membership`, or the screen's `expectBranch`):
 *   otherwise 409 `membership_changed`.
 *
 * A close is compared against the version in the store's one transaction
 * (`closeMemItemVersioned`, S-D). A recorded decision closes (as `withdrawn`) only
 * for a person who confirmed it is not reflected (`confirmUnreflected: true`);
 * without it 409 `confirmation_required`. A proposal never closes a recorded one.
 *
 * The screen's mark is asked here too, not only in the route (403 `screen_only`).
 * Callers: the screen's item routes (`…/mem/screen/**`) and, later, the hand-off's
 * decide. The CLI has no way to it (`tests/unit/guards/mem-screen-write-4227.test.ts`).
 */
export async function memWriteFromScreen(
  db: Database.Database,
  request: ScreenRequest,
  worktreeId: string,
  input: MemScreenWriteInput,
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  if (!isScreenRequest(request)) return memError('screen_only');
  const lookup = lookupActor(db, worktreeId, input.body.instanceId, input.author === 'human' ? 'human' : 'agent');
  if (!lookup.ok) return lookup.outcome;
  const { worktree, actor } = lookup;
  // (iii): fixed now, before any await (or given by the caller that fixed them earlier).
  const worktreeIncarnation = input.pin ? input.pin.worktreeIncarnation : getWorktreeIncarnation(db, worktreeId);
  const earlierLifetime = input.pin ? input.pin.instanceLifetime : readInstanceLifetime(db, worktreeId, actor.instanceId);
  const expectBranch = readExpectBranch(input.body.expectBranch);
  if (!expectBranch.ok) return memError('invalid_request', { field: 'expectBranch' });
  // The screen's add names the branch it shows (S-A (iv), H14(e)); a pin names it for a caller.
  if (input.op === 'add' && input.author === 'human' && !input.pin && expectBranch.value === undefined) {
    return memError('invalid_request', { field: 'expectBranch' });
  }
  const prepared = prepareScreenWrite(db, input, worktree.path, deps.now?.() ?? Date.now());
  if (!prepared.ok) {
    logger.info('mem-screen-refused', { worktreeId, instanceId: actor.instanceId, op: input.op, code: (prepared.outcome.body as { code?: string }).code });
    return prepared.outcome;
  }
  const plan = prepared.prepared;
  const draft = plan.op === 'close' ? null : plan.draft;
  const answers = draft ? await askConditionGit(draft, worktree.path, deps) : { origin: null, tip: null };

  const write = (target: MemTarget): MemOutcome => {
    if (!target.ok) return targetFailure(target);
    if (target.mode !== 'on') return memError('disabled', { mode: target.mode, source: target.source });
    // (iii) the lifetimes.
    if (worktreeIncarnation === null || getWorktreeIncarnation(db, worktreeId) !== worktreeIncarnation) {
      return screenRefusal('incarnation_changed');
    }
    if (!isSameInstanceLifetime(earlierLifetime, readInstanceLifetime(db, worktreeId, actor.instanceId), actor.cliToolId)) {
      return screenRefusal('incarnation_changed');
    }
    if (actor.stillOnRoster && !actor.stillOnRoster()) return screenRefusal('incarnation_changed');
    // (iv) the branch asked for.
    const branch = target.detached ? null : target.branch;
    if (input.pin) {
      const pinned = input.pin.membership;
      if (pinned.repositoryId !== target.storageRepositoryId || pinned.branch !== branch || pinned.detached !== target.detached) {
        return screenRefusal('membership_changed');
      }
    }
    if (expectBranch.value !== undefined && expectBranch.value !== branch) return screenRefusal('membership_changed');
    const now = deps.now?.() ?? Date.now();

    if (plan.op === 'add') {
      const condition = bindCondition(db, plan.draft, answers, target.storageRepositoryId, now);
      if (!condition.ok) return memError('invalid_close_when', { field: 'closeWhen' });
      if (input.fence && !input.fence()) return screenRefusal('fenced');
      const scope = scopeOf(target);
      const result = createMemItem(
        db,
        actor,
        scope,
        {
          kind: plan.kind,
          text: plan.fields.text,
          closeWhen: condition.json,
          closeWhenInput: plan.closeWhenInput,
          promoteTo: plan.fields.promoteTo,
          quote: plan.fields.quote,
          quoteAt: plan.fields.quoteAt,
          evidence: plan.fields.evidence,
          key: plan.key,
        },
        now
      );
      if (!result.ok) return screenStoreFailure(result);
      logger.info('mem-screen-written', { worktreeId, instanceId: actor.instanceId, op: 'add', by: actor.by, itemId: result.record.id, replayed: result.replayed });
      return writeOk(result.record, result.replayed, openWarnings(db, scope, [plan.kind]));
    }

    // (i) the item is of this branch.
    const current = getMemRecord(db, plan.itemId);
    if (!current) return memError('item_not_found');
    if (!itemOnTarget(current, target)) return screenRefusal('membership_changed', { itemId: current.id });

    if (plan.op === 'update') {
      const patch: { text?: string; closeWhen?: string | null; evidence?: string[] } = { ...plan.patch };
      if (plan.draft) {
        const condition = bindCondition(db, plan.draft, answers, current.owner.repositoryId, now);
        if (!condition.ok) return memError('invalid_close_when', { field: 'closeWhen' });
        patch.closeWhen = condition.json;
      }
      if (input.fence && !input.fence()) return screenRefusal('fenced');
      const result = updateMemItem(db, actor, plan.itemId, plan.ifVersion, patch, now);
      if (!result.ok) return screenStoreFailure(result);
      logger.info('mem-screen-written', { worktreeId, instanceId: actor.instanceId, op: 'update', by: actor.by, itemId: plan.itemId, version: result.record.version });
      return writeOk(result.record, false, []);
    }

    let transition: MemVersionedCloseTransition = 'close';
    if (current.kind === 'decision' && current.state === 'recorded' && actor.by === 'human' && current.version === plan.ifVersion) {
      // S-D: only a person who said it is not reflected closes a recorded decision.
      if (!plan.confirmUnreflected) return screenRefusal('confirmation_required', { itemId: current.id });
      transition = 'withdraw-recorded';
    }
    if (input.fence && !input.fence()) return screenRefusal('fenced');
    const result = closeMemItemVersioned(db, actor, plan.itemId, { ifVersion: plan.ifVersion, reason: plan.reason, transition }, now);
    if (!result.ok) return screenStoreFailure(result);
    logger.info('mem-screen-written', { worktreeId, instanceId: actor.instanceId, op: 'close', by: actor.by, itemId: plan.itemId, transition });
    return writeOk(result.record, false, []);
  };

  return resolveTarget(db, { via: 'worktree', worktreeId }, deps, (target) => db.transaction(() => write(target))());
}

/** The store's refusals as the screen reads them: a lifetime the store found changed is `incarnation_changed`. */
function screenStoreFailure(failure: MemStoreFailure): MemOutcome {
  if (failure.code === 'instance_not_found') return screenRefusal('incarnation_changed');
  return storeFailure(failure);
}

// ---------------------------------------------------------------------------
// A decision recorded or promoted (Issue #4225, design `mem-promote-4225.md` §3.5・§6.3)
// ---------------------------------------------------------------------------

export interface MemDecisionTransitionInput {
  /** The worktree the screen's request was read for (the context of the promote). */
  worktreeId: string;
  /**
   * Its lifetime as the caller fixed it when the person's request arrived — before the
   * external write and its awaits (§3.5). This entrance compares and never fixes it
   * again; null is refused.
   */
  expectedWorktreeIncarnation: string | null;
  itemId: string;
  /** The item's version the person approved. */
  expectedVersion: number;
  transition: MemDecisionTransition;
}

/**
 * The one way a decision becomes `recorded` / `promoted`. Called by the promote
 * service of #4225 only (`src/lib/promote/service.ts`), after a person approved on
 * the screen and the external write succeeded (or the person confirmed the
 * reflection). The mode of the item's branch must be `on`, decided in the same
 * synchronous stretch as the write; the version and the worktree's lifetime are the
 * ones the caller fixed.
 */
export async function memSettleDecisionTransition(
  db: Database.Database,
  input: MemDecisionTransitionInput,
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  if (!getWorktreeById(db, input.worktreeId)) return memError('not_found');
  if (input.expectedWorktreeIncarnation === null) return memError('instance_not_found', { reason: 'incarnation_changed' });
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) return memError('invalid_request', { field: 'ifVersion' });
  const before = getMemRecord(db, input.itemId);
  if (!before || before.kind !== 'decision') return memError('item_not_found');
  const expectedIncarnation = input.expectedWorktreeIncarnation;

  // The mode is that of the item's branch at every root of the worktree's repository
  // (5-2b P1): roots that differ answer `ambiguous`, as every other mem entrance does.
  // A named branch reaches `decideMemTarget` as it is; null is a detached item's branch.
  const spec: MemTargetSpec = { via: 'worktree', worktreeId: input.worktreeId, branch: before.owner.branch as string };
  return resolveTarget(db, spec, deps, (target) => {
    if (!target.ok) return targetFailure(target);
    const current = getMemRecord(db, input.itemId);
    if (!current || current.kind !== 'decision') return memError('item_not_found');
    if (!target.readRepositoryIds.includes(current.owner.repositoryId)) return memError('not_found');
    if (target.mode !== 'on' || !memModeOnFor(db, [current.owner.repositoryId], current.owner.branch)) {
      return memError('disabled', { mode: target.mode, source: target.source });
    }
    const alive = () => getWorktreeIncarnation(db, input.worktreeId) === expectedIncarnation;
    const result = transitionDecision(db, alive, input.itemId, { version: input.expectedVersion }, input.transition, deps.now?.() ?? Date.now());
    if (!result.ok) return storeFailure(result);
    logger.info('mem-decision-transitioned', { itemId: input.itemId, transition: input.transition, version: result.record.version });
    return writeOk(result.record, false, []);
  });
}

// ---------------------------------------------------------------------------
// Reads and purge (both ways in)
// ---------------------------------------------------------------------------

export async function memMode(db: Database.Database, spec: MemTargetSpec, deps: MemServiceDeps = {}): Promise<MemOutcome> {
  if (spec.via === 'worktree' && !getWorktreeById(db, spec.worktreeId)) return memError('not_found');
  return resolveTarget(db, spec, deps, (target) => {
    if (!target.ok) return targetFailure(target);
    const body: MemModeResponse = {
      ok: true,
      mode: target.mode,
      source: target.source,
      target: { via: target.via, worktreeId: target.worktree?.id ?? null },
      branch: target.detached ? null : target.branch,
      detached: target.detached,
      features: target.features,
      repositoryIds: target.members.map((root) => root.id),
    };
    return { status: 200, body };
  });
}

export async function memList(
  db: Database.Database,
  spec: MemTargetSpec,
  options: { all?: boolean; instanceId?: string },
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  if (spec.via === 'worktree' && !getWorktreeById(db, spec.worktreeId)) return memError('not_found');
  const fixed = fixMemEvalLifetime(db, spec);
  const target = await resolveTarget(db, spec, deps, (resolved) => resolved);
  if (!target.ok) return targetFailure(target);
  if (target.mode === 'off') return memError('disabled', { mode: target.mode, source: target.source });
  // Issue #4222: `on` evaluates the conditions (and closes what is met) before listing;
  // `derived` shows the items frozen and evaluates nothing (§4).
  const report = await evaluateMemConditions(db, target, evalContext('list', spec, options.instanceId, fixed, deps));
  const frozen = target.mode === 'derived';
  const scope = scopeOf(target);
  const listed = listMem(db, scope, options);
  const now = deps.now?.() ?? Date.now();
  const warnings = openWarnings(db, scope, ['waiting', 'next', 'external', 'note', 'decision']);
  const closed = countClosedItems(db, scope);
  if (closed > MEM_CLOSED_WARN) warnings.push({ code: 'closed_count', count: closed, threshold: MEM_CLOSED_WARN });
  const body: MemListResponse = {
    ok: true,
    mode: target.mode,
    branch: scope.branch,
    items: listed.items.map((record) => presentMemItem(record, { now, frozen })),
    now: listed.now.map((slot) => ({ instanceId: slot.instanceId, item: presentMemItem(slot.record, { now, frozen }) })),
    warnings,
    ...(report.evaluated ? { conditions: conditionsById(report) } : {}),
  };
  return { status: 200, body };
}

// ---------------------------------------------------------------------------
// Conditions (Issue #4222)
// ---------------------------------------------------------------------------

function evalContext(
  trigger: MemEvalContext['trigger'],
  spec: MemTargetSpec,
  instanceId: unknown,
  lifetime: MemEvalLifetime,
  deps: MemServiceDeps
): MemEvalContext {
  return {
    trigger,
    caller:
      spec.via === 'worktree'
        ? { worktreeId: spec.worktreeId, instanceId: typeof instanceId === 'string' && instanceId.length > 0 ? instanceId : null }
        : null,
    lifetime,
    deps: deps.evaluation,
    limits: deps.evaluation?.limits,
    deadlineMs: deps.evaluation?.deadlineMs,
  };
}

function conditionsById(report: MemEvalReport): Record<string, MemConditionView> {
  const out: Record<string, MemConditionView> = {};
  for (const result of report.results) out[result.itemId] = result.condition;
  return out;
}

/**
 * `mem check`: evaluate the branch's conditions and close what is met (§4). `off` and
 * `derived` answer `disabled` and ask nothing. Nothing is acknowledged here (§3.5).
 */
export async function memCheck(
  db: Database.Database,
  spec: MemTargetSpec,
  body: Record<string, unknown>,
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  if (spec.via === 'worktree' && !getWorktreeById(db, spec.worktreeId)) return memError('not_found');
  if (body.instanceId !== undefined && typeof body.instanceId !== 'string') return memError('invalid_request', { field: 'instanceId' });
  const fixed = fixMemEvalLifetime(db, spec);
  const target = await resolveTarget(db, spec, deps, (resolved) => resolved);
  if (!target.ok) return targetFailure(target);
  if (target.mode !== 'on') return memError('disabled', { mode: target.mode, source: target.source });
  const report = await evaluateMemConditions(db, target, evalContext('check', spec, body.instanceId, fixed, deps));
  logger.info('mem-checked', {
    branch: target.detached ? null : target.branch,
    evaluated: report.results.length,
    closed: report.results.filter((result) => result.condition.closed).length,
    queries: report.asked.length,
  });
  const response: MemCheckResponse = {
    ok: true,
    mode: target.mode,
    branch: target.detached ? null : target.branch,
    results: report.results.map((result) => ({ itemId: result.itemId, kind: result.kind, type: result.type, condition: result.condition })),
  };
  return { status: 200, body: response };
}

/** `GET /api/repositories/:id/mem/notices?branch=`: the notices nobody has taken. Any mode (§4: read only). */
export async function memUndeliveredNotices(
  db: Database.Database,
  repositoryId: string,
  branch: string,
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  const target = await resolveTarget(db, { via: 'repository', repositoryId, branch }, deps, (resolved) => resolved);
  if (!target.ok) return targetFailure(target);
  const body: MemNoticeListResponse = {
    ok: true,
    notices: listUndeliveredMemNotices(db, target.readRepositoryIds, branch, { now: deps.now }),
  };
  return { status: 200, body };
}

/** `POST /api/repositories/:id/mem/notices/:noticeId/acknowledge` — a person takes a notice (screen only, §3.3). */
export async function memAcknowledgeNotice(
  db: Database.Database,
  repositoryId: string,
  noticeId: string,
  body: Record<string, unknown>,
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  if (typeof body.ifVersion !== 'number' || !Number.isInteger(body.ifVersion) || body.ifVersion < 1) {
    return memError('invalid_request', { field: 'ifVersion' });
  }
  const ifVersion = body.ifVersion;
  const notice = getMemNoticeRow(db, noticeId);
  if (!notice) return memError('not_found');
  const target = await resolveTarget(db, { via: 'repository', repositoryId, branch: notice.branch ?? '' }, deps, (resolved) => resolved);
  if (!target.ok) return targetFailure(target);
  if (!target.readRepositoryIds.includes(notice.repository_id)) return memError('not_found');
  const result = acknowledgeMemNoticeByHuman(db, noticeId, ifVersion, { now: deps.now, bootId: deps.bootId });
  if (!result.ok) {
    if (result.code === 'version_conflict') return memError('version_conflict', { currentVersion: result.current?.version });
    if (result.code === 'disabled') return memError('disabled', { mode: target.mode, source: target.source });
    if (result.code === 'state_forbids') return memError('state_forbids');
    return memError('not_found');
  }
  logger.info('mem-notice-acknowledged', { noticeId, by: 'human' });
  return { status: 200, body: { ok: true, noticeId, version: result.notice.version } };
}

export async function memPurge(
  db: Database.Database,
  spec: MemTargetSpec,
  body: Record<string, unknown>,
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  if (typeof spec.branch !== 'string' || spec.branch.length === 0) return memError('target_required', { field: 'branch' });
  if (spec.via === 'worktree' && !getWorktreeById(db, spec.worktreeId)) return memError('not_found');
  // 4th integration review: a purge named through a worktree fixes its lifetime here,
  // before the awaits, so one the worktree's delete and re-creation (same id and
  // path) overtook deletes nothing the new worktree wrote.
  const namedWorktree = spec.via === 'worktree' ? spec.worktreeId : null;
  const lifetime = namedWorktree !== null ? getOrCreateWorktreeIncarnation(db, namedWorktree) : null;
  const alive = namedWorktree !== null ? () => getWorktreeIncarnation(db, namedWorktree) === lifetime : null;
  if (body.kind !== undefined && !isMemKind(body.kind)) return memError('invalid_request', { field: 'kind' });
  let before: number | undefined;
  if (body.before !== undefined) {
    const parsed = typeof body.before === 'string' ? parseIsoWithOffset(body.before) : null;
    if (parsed === null) return memError('invalid_request', { field: 'before' });
    before = parsed;
  }
  const confirm = body.confirm === true;
  return resolveTarget(db, spec, deps, (target) => {
    if (!target.ok) return targetFailure(target);
    const out = { notices: 0 };
    const counts = purgeMem(
      db,
      scopeOf(target),
      {
        closedOnly: body.closedOnly === true,
        kind: body.kind as MemKind | undefined,
        before,
        includeDecisions: body.includeDecisions === true,
      },
      confirm,
      alive,
      out
    );
    if (counts === null) return memError('not_found', { reason: 'incarnation_changed' });
    if (confirm) logger.info('mem-purged', { branch: spec.branch, counts, notices: out.notices });
    const response: MemPurgeResponse = { ok: true, dryRun: !confirm, counts, ...(out.notices > 0 ? { notices: out.notices } : {}) };
    return { status: 200, body: response };
  });
}

// ---------------------------------------------------------------------------
// The #2427 note written from the screen (§6.3・§10.2)
// ---------------------------------------------------------------------------

export interface ScreenNoteOutcome {
  status: number;
  body: unknown;
}

const conflictBody = (code: 'version_conflict' | 'version_required', current: SessionSlotView | null) => ({
  ...(memError(code).body as MemErrorBody),
  error: MESSAGES[code],
  current: current ? { text: current.text, version: current.version, updatedAt: current.updatedAt } : null,
});

/**
 * `PUT …/instances/notes`. The checks of mem apply when the row is a `now` of mem,
 * whatever the mode, and when the mode is `on` (the write makes it one). Otherwise
 * the note is what #2427 made it.
 */
export async function writeSessionNoteFromScreen(
  db: Database.Database,
  worktreeId: string,
  body: Record<string, unknown>,
  deps: MemServiceDeps = {}
): Promise<ScreenNoteOutcome> {
  const lookup = lookupActor(db, worktreeId, body.instanceId, 'human');
  if (!lookup.ok) return lookup.outcome;
  const { actor } = lookup;
  if (typeof body.text !== 'string') return { status: 400, body: { error: 'text must be a string' } };
  let baseVersion: number | undefined;
  if (body.baseVersion !== undefined && body.baseVersion !== null) {
    if (typeof body.baseVersion !== 'number' || !Number.isInteger(body.baseVersion) || body.baseVersion < 0) {
      return { status: 400, body: { error: 'baseVersion must be a non-negative integer', code: 'invalid_request' } };
    }
    baseVersion = body.baseVersion;
  }
  const raw = body.text;
  const normalized = normalizeSessionNoteText(raw);
  if (sessionNoteLength(normalized) > MAX_SESSION_NOTE_LENGTH) {
    return {
      status: 400,
      body: { error: `Session note exceeds ${MAX_SESSION_NOTE_LENGTH} characters`, maxLength: MAX_SESSION_NOTE_LENGTH, code: 'too_long' },
    };
  }

  const write = (target: MemTarget | null): ScreenNoteOutcome => {
    const on = target !== null && target.ok && target.mode === 'on';
    const memRow = isMemSlot(db, worktreeId, actor.instanceId);
    let text = normalized;
    if (text.length > 0 && (memRow || on)) {
      const checked = validateNowText(raw);
      if (!checked.ok) {
        logRefusal('session-note-refused', checked.error, { worktreeId, instanceId: actor.instanceId });
        const refusal = fieldError(checked.error);
        return { status: 400, body: { ...(refusal.body as MemErrorBody), error: MESSAGES[checked.error.code] } };
      }
      text = checked.value;
    }
    const result = writeScreenNote(
      db,
      {
        worktreeId,
        instanceId: actor.instanceId,
        text,
        baseVersion,
        memWrite: on && text.length > 0 ? { actor, scope: scopeOf(target as MemTargetResolved) } : null,
        // 3rd review P2-2: off / derived write the row directly, so the lifetime fixed
        // at `lookupActor` is asked here too, not only through `replaceNowSlot`.
        alive: actor.stillOnRoster ?? null,
      },
      deps.now?.() ?? Date.now()
    );
    if (!result.ok) {
      if (result.code === 'instance_not_found') {
        return { status: 409, body: { ...(memError('instance_not_found', { reason: result.reason }).body as object), error: MESSAGES.instance_not_found } };
      }
      return { status: 409, body: conflictBody(result.code, result.current) };
    }
    logger.info('session-note-updated', {
      worktreeId,
      instanceId: actor.instanceId,
      length: result.row ? result.row.text.length : 0,
      cleared: result.row === null,
      mem: Boolean(result.row?.mem),
    });
    return { status: 200, body: { instanceId: actor.instanceId, note: result.row } };
  };

  // Clearing needs no mode: a `now` cleared is closed whatever the mode (§3.1).
  if (normalized.length === 0) return write(null);
  return resolveTarget(db, { via: 'worktree', worktreeId }, deps, write);
}

/** For the note route's GET and tests: the slot as the screen reads it. */
export { readSessionSlot };

/** What a route answers when a mem function threw: 500, with the error's name only. */
export function memInternalError(event: string, error: unknown): MemOutcome {
  logger.error(event, { error: error instanceof Error ? error.name : 'unknown' });
  return memError('internal_error');
}

/** A JSON body that must be an object; anything else is an invalid request. */
export async function readMemBody(request: { json(): Promise<unknown> }): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
