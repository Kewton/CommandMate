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
  updateMemItem,
  writeScreenNote,
  type MemActor,
  type MemScope,
  type MemStoreFailure,
  type SessionSlotView,
} from '@/lib/db/mem-db';
import { createLogger } from '@/lib/logger';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import {
  isMemKind,
  type MemErrorBody,
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
import { getInstanceIncarnation, getOrCreateWorktreeIncarnation } from './incarnation';
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
    tip: needs.tipOf !== null ? await git.refTip(worktreePath, needs.tipOf) : null,
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
  options: { all?: boolean },
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  if (spec.via === 'worktree' && !getWorktreeById(db, spec.worktreeId)) return memError('not_found');
  return resolveTarget(db, spec, deps, (target) => {
    if (!target.ok) return targetFailure(target);
    if (target.mode === 'off') return memError('disabled', { mode: target.mode, source: target.source });
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
    };
    return { status: 200, body };
  });
}

export async function memPurge(
  db: Database.Database,
  spec: MemTargetSpec,
  body: Record<string, unknown>,
  deps: MemServiceDeps = {}
): Promise<MemOutcome> {
  if (typeof spec.branch !== 'string' || spec.branch.length === 0) return memError('target_required', { field: 'branch' });
  if (spec.via === 'worktree' && !getWorktreeById(db, spec.worktreeId)) return memError('not_found');
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
    const counts = purgeMem(
      db,
      scopeOf(target),
      {
        closedOnly: body.closedOnly === true,
        kind: body.kind as MemKind | undefined,
        before,
        includeDecisions: body.includeDecisions === true,
      },
      confirm
    );
    if (confirm) logger.info('mem-purged', { branch: spec.branch, counts });
    const response: MemPurgeResponse = { ok: true, dryRun: !confirm, counts };
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
