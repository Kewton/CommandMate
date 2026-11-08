/**
 * The mem store (Issue #4221, design §5・§8・§10): settings, items and the `now`
 * slots kept in `session_notes`.
 *
 * Everything here is synchronous and meant to run inside the synchronous stretch
 * that settled the membership (`lib/mem/target.ts`), so a write never pairs an old
 * membership with a newer mode. Each write is one transaction: the checks, the
 * move of the replaced content and the write go back together on any failure.
 *
 * Imports no roster or worktree module, because both of those call into this one
 * (moving a `now` out before its slot is deleted).
 *
 * @module lib/db/mem-db
 */

import { createHash, randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  MEM_FEATURE_KEYS,
  type MemBranchOverride,
  type MemBranchRule,
  type MemCloseReason,
  type MemFeatures,
  type MemItemOwner,
  type MemKind,
  type MemMode,
  type MemModeSource,
  type MemRepositorySettings,
  type MemState,
} from '@/types/mem';
import { getInstanceIncarnation, getOrCreateWorktreeIncarnation, startInstanceIncarnation } from '@/lib/mem/incarnation';
import { MEM_SECRET_RULES_VERSION } from '@/lib/mem/secret-scan';
import { findWithheld, type MemRecord } from '@/lib/mem/present';
import { memTransition } from '@/lib/mem/transitions';

// ===========================================================================
// Settings (§4・§9.4・§11.1)
// ===========================================================================

export const MEM_MAX_RULES = 50;
export const MEM_MAX_PATTERN_LENGTH = 200;
export const MEM_MAX_BRANCH_LENGTH = 250;

const NO_FEATURES: MemFeatures = { injectOnStart: false, promptOnEvents: false, popup: false };

export class MemSettingsConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('The mem settings changed since they were read');
    this.name = 'MemSettingsConflictError';
  }
}

export class MemSettingsInvalidError extends Error {
  constructor(readonly field: string) {
    super(`Invalid mem setting: ${field}`);
    this.name = 'MemSettingsInvalidError';
  }
}

interface SettingsRow {
  inject_on_start: number;
  prompt_on_events: number;
  popup: number;
  version: number;
}

const boolOrNull = (value: number | null): boolean | null => (value === null ? null : value === 1);
const intOrNull = (value: boolean | null): number | null => (value === null ? null : value ? 1 : 0);

export function getMemSettings(db: Database.Database, repositoryId: string): MemRepositorySettings {
  const row = db
    .prepare('SELECT inject_on_start, prompt_on_events, popup, version FROM mem_repository_settings WHERE repository_id = ?')
    .get(repositoryId) as SettingsRow | undefined;
  const rules = (
    db
      .prepare('SELECT match, pattern, mode FROM mem_branch_rules WHERE repository_id = ? ORDER BY position')
      .all(repositoryId) as Array<{ match: 'glob' | 'detached'; pattern: string | null; mode: MemMode }>
  ).map((rule) => ({ match: rule.match, pattern: rule.pattern, mode: rule.mode }));
  const overrides = (
    db
      .prepare(
        `SELECT branch, mode, inject_on_start, prompt_on_events, popup FROM mem_branch_overrides
         WHERE repository_id = ? ORDER BY branch`
      )
      .all(repositoryId) as Array<{
      branch: string;
      mode: MemMode | null;
      inject_on_start: number | null;
      prompt_on_events: number | null;
      popup: number | null;
    }>
  ).map((o) => ({
    branch: o.branch,
    mode: o.mode,
    injectOnStart: boolOrNull(o.inject_on_start),
    promptOnEvents: boolOrNull(o.prompt_on_events),
    popup: boolOrNull(o.popup),
  }));
  return {
    repositoryId,
    version: row?.version ?? 0,
    features: row
      ? { injectOnStart: row.inject_on_start === 1, promptOnEvents: row.prompt_on_events === 1, popup: row.popup === 1 }
      : { ...NO_FEATURES },
    rules,
    overrides,
  };
}

const PATTERN_CHARS = /^[A-Za-z0-9._/*?-]+$/;

export function validateBranchRules(raw: unknown): MemBranchRule[] {
  if (!Array.isArray(raw) || raw.length > MEM_MAX_RULES) throw new MemSettingsInvalidError('rules');
  return raw.map((entry, index) => {
    const rule = entry as Partial<MemBranchRule> | null;
    if (!rule || (rule.match !== 'glob' && rule.match !== 'detached')) throw new MemSettingsInvalidError(`rules[${index}].match`);
    if (rule.mode !== 'off' && rule.mode !== 'derived' && rule.mode !== 'on') throw new MemSettingsInvalidError(`rules[${index}].mode`);
    if (rule.match === 'detached') return { match: 'detached', pattern: null, mode: rule.mode };
    if (
      typeof rule.pattern !== 'string' ||
      rule.pattern.length === 0 ||
      rule.pattern.length > MEM_MAX_PATTERN_LENGTH ||
      !PATTERN_CHARS.test(rule.pattern)
    ) {
      throw new MemSettingsInvalidError(`rules[${index}].pattern`);
    }
    return { match: 'glob', pattern: rule.pattern, mode: rule.mode };
  });
}

export function validateFeatures(raw: unknown): MemFeatures {
  const value = raw as Partial<MemFeatures> | null;
  if (!value || typeof value !== 'object') throw new MemSettingsInvalidError('features');
  for (const key of MEM_FEATURE_KEYS) {
    if (typeof value[key] !== 'boolean') throw new MemSettingsInvalidError(`features.${key}`);
  }
  return { injectOnStart: value.injectOnStart!, promptOnEvents: value.promptOnEvents!, popup: value.popup! };
}

export function isValidBranchName(branch: unknown): branch is string {
  return (
    typeof branch === 'string' &&
    branch.length > 0 &&
    branch.length <= MEM_MAX_BRANCH_LENGTH &&
    /^[A-Za-z0-9._/-]+$/.test(branch) &&
    !branch.includes('..')
  );
}

function bumpSettingsVersion(db: Database.Database, repositoryId: string, expected: number, now: number): number {
  const current = getMemSettings(db, repositoryId).version;
  if (current !== expected) throw new MemSettingsConflictError(current);
  const next = current + 1;
  db.prepare(
    `INSERT INTO mem_repository_settings (repository_id, version, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(repository_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`
  ).run(repositoryId, next, now);
  return next;
}

/** Replace the rules and the switches, against the version the screen read. */
export function saveMemSettings(
  db: Database.Database,
  repositoryId: string,
  input: { version: number; features: MemFeatures; rules: MemBranchRule[] },
  now: number = Date.now()
): MemRepositorySettings {
  db.transaction(() => {
    bumpSettingsVersion(db, repositoryId, input.version, now);
    db.prepare(
      'UPDATE mem_repository_settings SET inject_on_start = ?, prompt_on_events = ?, popup = ? WHERE repository_id = ?'
    ).run(intOrNull(input.features.injectOnStart), intOrNull(input.features.promptOnEvents), intOrNull(input.features.popup), repositoryId);
    db.prepare('DELETE FROM mem_branch_rules WHERE repository_id = ?').run(repositoryId);
    const insert = db.prepare('INSERT INTO mem_branch_rules (repository_id, position, match, pattern, mode) VALUES (?, ?, ?, ?, ?)');
    input.rules.forEach((rule, position) => insert.run(repositoryId, position, rule.match, rule.pattern, rule.mode));
  })();
  return getMemSettings(db, repositoryId);
}

export function saveMemBranchOverride(
  db: Database.Database,
  repositoryId: string,
  version: number,
  override: MemBranchOverride,
  now: number = Date.now()
): MemRepositorySettings {
  db.transaction(() => {
    bumpSettingsVersion(db, repositoryId, version, now);
    db.prepare(
      `INSERT INTO mem_branch_overrides (repository_id, branch, mode, inject_on_start, prompt_on_events, popup, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repository_id, branch) DO UPDATE SET mode = excluded.mode, inject_on_start = excluded.inject_on_start,
         prompt_on_events = excluded.prompt_on_events, popup = excluded.popup, updated_at = excluded.updated_at`
    ).run(
      repositoryId,
      override.branch,
      override.mode,
      intOrNull(override.injectOnStart),
      intOrNull(override.promptOnEvents),
      intOrNull(override.popup),
      now
    );
  })();
  return getMemSettings(db, repositoryId);
}

export function deleteMemBranchOverride(
  db: Database.Database,
  repositoryId: string,
  version: number,
  branch: string,
  now: number = Date.now()
): MemRepositorySettings {
  db.transaction(() => {
    bumpSettingsVersion(db, repositoryId, version, now);
    db.prepare('DELETE FROM mem_branch_overrides WHERE repository_id = ? AND branch = ?').run(repositoryId, branch);
  })();
  return getMemSettings(db, repositoryId);
}

/** `*` stays within a segment, `**` crosses `/`, `?` is one character of a segment. */
export function branchGlobMatches(pattern: string, branch: string): boolean {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\-]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`).test(branch);
}

export interface MemRootDecision {
  mode: MemMode;
  features: MemFeatures;
  source: MemModeSource;
}

/**
 * One root's answer for a branch (§9.4): the branch override, then the first rule
 * that matches, then `off`. A detached HEAD matches only a `detached` rule.
 *
 * @param branch - null for a detached HEAD
 */
export function decideRootMode(db: Database.Database, repositoryId: string, branch: string | null): MemRootDecision {
  const settings = getMemSettings(db, repositoryId);
  const override = branch === null ? undefined : settings.overrides.find((o) => o.branch === branch);
  const features: MemFeatures = {
    injectOnStart: override?.injectOnStart ?? settings.features.injectOnStart,
    promptOnEvents: override?.promptOnEvents ?? settings.features.promptOnEvents,
    popup: override?.popup ?? settings.features.popup,
  };
  if (override && override.mode !== null) {
    return {
      mode: override.mode,
      features,
      source: { level: 'override', repositoryId, branch, rulePosition: null, pattern: null },
    };
  }
  for (let position = 0; position < settings.rules.length; position += 1) {
    const rule = settings.rules[position];
    const hit = rule.match === 'detached' ? branch === null : branch !== null && branchGlobMatches(rule.pattern ?? '', branch);
    if (hit) {
      return { mode: rule.mode, features, source: { level: 'rule', repositoryId, branch, rulePosition: position, pattern: rule.pattern } };
    }
  }
  return { mode: 'off', features, source: { level: 'fallback', repositoryId, branch, rulePosition: null, pattern: null } };
}

// ===========================================================================
// Items (§5・§8・§10)
// ===========================================================================

/** §8.1. null: no limit (a person's decisions are not refused by count). */
export const MEM_OPEN_LIMITS: Readonly<Record<Exclude<MemKind, 'now'>, { warn: number; max: number | null }>> = {
  waiting: { warn: 10, max: 30 },
  next: { warn: 10, max: 30 },
  external: { warn: 10, max: 30 },
  note: { warn: 20, max: 50 },
  decision: { warn: 20, max: null },
};
export const MEM_CLOSED_WARN = 500;
/** Superseded `now` contents kept per slot (§8.3). */
export const MEM_SUPERSEDED_KEPT = 20;

/** Who writes, as the store needs it. A person writes through the screen only. */
export interface MemActor {
  worktreeId: string;
  instanceId: string;
  cliToolId: string;
  /** The instance incarnation read when the request arrived; null when there was none (§10.4). */
  capturedIncarnation: string | null;
  sessionGeneration: string | null;
  by: 'agent' | 'human';
  /**
   * Whether the instance is still on the roster with the same tool, of the same
   * worktree lifetime as when the request arrived, asked inside the write's
   * transaction. Without an incarnation nothing else tells a deleted instance (or
   * a worktree deleted and made again under its id) from one that never had one
   * (review P1, 2nd review P1).
   */
  stillOnRoster?: () => boolean;
}

/** Where items are written and read (§9.5). */
export interface MemScope {
  storageRepositoryId: string;
  readRepositoryIds: string[];
  /** null: detached, which narrows to the worktree. */
  branch: string | null;
  worktreeId: string | null;
}

export type MemStoreFailure =
  | { ok: false; code: 'instance_not_found'; reason: 'incarnation_changed' }
  | { ok: false; code: 'item_not_found' }
  | { ok: false; code: 'version_conflict'; current: MemRecord }
  | { ok: false; code: 'not_owner'; current: MemRecord }
  | { ok: false; code: 'state_forbids'; current: MemRecord }
  | { ok: false; code: 'duplicate_key'; itemId: string; version: number }
  | { ok: false; code: 'limit_exceeded'; kind: MemKind; limit: number };

interface ItemRow {
  id: string;
  repository_id: string;
  branch: string | null;
  kind: MemKind;
  state: MemState;
  text: string;
  close_when: string | null;
  promote_to: string | null;
  quote: string | null;
  quote_at: number | null;
  evidence: string | null;
  origin_worktree_id: string;
  origin_worktree_incarnation: string;
  origin_instance_id: string;
  origin_cli_tool_id: string;
  origin_incarnation: string;
  origin_session_generation: string | null;
  created_by: 'agent' | 'human';
  updated_by: 'agent' | 'human' | 'server';
  version: number;
  checked_rules_version: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  close_reason: MemCloseReason | null;
  close_note: string | null;
}

interface SlotRow {
  worktree_id: string;
  instance_id: string;
  note: string;
  updated_at: number;
  version: number;
  mem_item_id: string | null;
  mem_repository_id: string | null;
  mem_branch: string | null;
  mem_cli_tool_id: string | null;
  mem_incarnation: string | null;
  mem_worktree_incarnation: string | null;
  mem_session_generation: string | null;
  mem_close_when: string | null;
  mem_evidence: string | null;
  mem_checked_rules_version: number | null;
  created_by: 'agent' | 'human' | null;
  updated_by: 'agent' | 'human' | 'server' | null;
  created_at: number | null;
}

function parseEvidence(json: string | null): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function recordFromItem(row: ItemRow): MemRecord {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    text: row.text,
    closeWhen: row.close_when,
    promoteTo: row.promote_to,
    quote: row.quote,
    quoteAt: row.quote_at,
    evidence: parseEvidence(row.evidence),
    closeNote: row.close_note,
    owner: {
      repositoryId: row.repository_id,
      branch: row.branch,
      worktreeId: row.origin_worktree_id,
      worktreeIncarnation: row.origin_worktree_incarnation,
      instanceId: row.origin_instance_id,
      cliToolId: row.origin_cli_tool_id,
      incarnation: row.origin_incarnation,
      sessionGeneration: row.origin_session_generation,
    },
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    version: row.version,
    checkedRulesVersion: row.checked_rules_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
  };
}

function recordFromSlot(row: SlotRow): MemRecord {
  return {
    id: row.mem_item_id as string,
    kind: 'now',
    state: 'open',
    text: row.note,
    closeWhen: row.mem_close_when,
    promoteTo: null,
    quote: null,
    quoteAt: null,
    evidence: parseEvidence(row.mem_evidence),
    closeNote: null,
    owner: {
      repositoryId: row.mem_repository_id ?? '',
      branch: row.mem_branch,
      worktreeId: row.worktree_id,
      worktreeIncarnation: row.mem_worktree_incarnation ?? '',
      instanceId: row.instance_id,
      cliToolId: row.mem_cli_tool_id ?? '',
      incarnation: row.mem_incarnation ?? '',
      sessionGeneration: row.mem_session_generation,
    },
    createdBy: row.created_by ?? 'agent',
    updatedBy: row.updated_by ?? 'agent',
    version: row.version,
    checkedRulesVersion: row.mem_checked_rules_version ?? 0,
    createdAt: row.created_at ?? row.updated_at,
    updatedAt: row.updated_at,
    closedAt: null,
    closeReason: null,
  };
}

const SLOT_COLUMNS = `worktree_id, instance_id, note, updated_at, version, mem_item_id, mem_repository_id, mem_branch,
  mem_cli_tool_id, mem_incarnation, mem_worktree_incarnation, mem_session_generation, mem_close_when, mem_evidence,
  mem_checked_rules_version, created_by, updated_by, created_at`;

function readSlot(db: Database.Database, worktreeId: string, instanceId: string): SlotRow | undefined {
  return db
    .prepare(`SELECT ${SLOT_COLUMNS} FROM session_notes WHERE worktree_id = ? AND instance_id = ?`)
    .get(worktreeId, instanceId) as SlotRow | undefined;
}

/**
 * The next version of a slot: one more than any it ever had, deletes included
 * (2nd review 2). The counter outlives the row, so a re-created row never repeats
 * a number a screen read before the delete.
 */
export function nextSlotVersion(db: Database.Database, worktreeId: string, instanceId: string): number {
  const counter = db
    .prepare('SELECT last_version FROM session_note_versions WHERE worktree_id = ? AND instance_id = ?')
    .get(worktreeId, instanceId) as { last_version: number } | undefined;
  const row = db
    .prepare('SELECT version FROM session_notes WHERE worktree_id = ? AND instance_id = ?')
    .get(worktreeId, instanceId) as { version: number } | undefined;
  const next = Math.max(counter?.last_version ?? 0, row?.version ?? 0) + 1;
  db.prepare(
    `INSERT INTO session_note_versions (worktree_id, instance_id, last_version) VALUES (?, ?, ?)
     ON CONFLICT(worktree_id, instance_id) DO UPDATE SET last_version = excluded.last_version`
  ).run(worktreeId, instanceId, next);
  return next;
}

/** Copy a slot's `now` into `mem_items` as closed, keeping the incarnations it was written under. */
function archiveSlot(
  db: Database.Database,
  slot: SlotRow,
  reason: MemCloseReason,
  updatedBy: 'agent' | 'human' | 'server',
  now: number
): void {
  if (!slot.mem_item_id) return;
  db.prepare(
    `INSERT INTO mem_items (id, repository_id, branch, kind, state, text, close_when, promote_to, quote, quote_at, evidence,
       origin_worktree_id, origin_worktree_incarnation, origin_instance_id, origin_cli_tool_id, origin_incarnation,
       origin_session_generation, created_by, updated_by, updated_by_instance, version, checked_rules_version,
       created_at, updated_at, closed_at, close_reason, close_note, idempotency_key, request_fingerprint)
     VALUES (?, ?, ?, 'now', 'closed', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
  ).run(
    slot.mem_item_id,
    slot.mem_repository_id ?? '',
    slot.mem_branch,
    slot.note,
    slot.mem_close_when,
    slot.mem_evidence,
    slot.worktree_id,
    slot.mem_worktree_incarnation ?? '',
    slot.instance_id,
    slot.mem_cli_tool_id ?? '',
    slot.mem_incarnation ?? '',
    slot.mem_session_generation,
    slot.created_by ?? 'agent',
    updatedBy,
    slot.version,
    slot.mem_checked_rules_version ?? 0,
    slot.created_at ?? slot.updated_at,
    now,
    now,
    reason
  );
  if (reason === 'superseded') {
    db.prepare(
      `DELETE FROM mem_items WHERE id IN (
         SELECT id FROM mem_items
         WHERE kind = 'now' AND close_reason = 'superseded' AND origin_worktree_id = ? AND origin_instance_id = ?
           AND origin_incarnation = ?
         ORDER BY closed_at DESC, rowid DESC LIMIT -1 OFFSET ?)`
    ).run(slot.worktree_id, slot.instance_id, slot.mem_incarnation ?? '', MEM_SUPERSEDED_KEPT);
  }
}

/**
 * Move every `now` of these worktrees (or of some instances of one) out of its
 * slot before the slot goes, whatever the mode (T2). Leaves the rows to the
 * caller's delete; plain #2427 notes are not touched.
 */
export function archiveNowSlots(
  db: Database.Database,
  worktreeIds: readonly string[],
  options: { instanceIds?: readonly string[]; reason?: MemCloseReason; now?: number; deleteRows?: boolean } = {}
): number {
  if (worktreeIds.length === 0) return 0;
  const now = options.now ?? Date.now();
  const rows = db
    .prepare(
      `SELECT ${SLOT_COLUMNS} FROM session_notes
       WHERE mem_item_id IS NOT NULL AND worktree_id IN (${worktreeIds.map(() => '?').join(',')})`
    )
    .all(...worktreeIds) as SlotRow[];
  const chosen = options.instanceIds ? rows.filter((row) => options.instanceIds!.includes(row.instance_id)) : rows;
  for (const row of chosen) {
    archiveSlot(db, row, options.reason ?? 'slot-removed', 'server', now);
    if (options.deleteRows) {
      nextSlotVersion(db, row.worktree_id, row.instance_id);
      db.prepare('DELETE FROM session_notes WHERE worktree_id = ? AND instance_id = ?').run(row.worktree_id, row.instance_id);
    }
  }
  return chosen.length;
}

/**
 * The actor's incarnation for this write, or a refusal (2nd review 3).
 *
 * The one read when the request arrived must still hold. When there was none
 * (a derived primary's first write, a row older than v66), one is made here only
 * if there is still none; and one whose tool differs is ended first.
 */
function settleActorIncarnation(
  db: Database.Database,
  actor: MemActor,
  now: number
): { ok: true; incarnation: string } | { ok: false } {
  // Still on the roster now: a row older than v66 has no incarnation, and deleting
  // the instance while the first write waited on git leaves none either (review P1).
  if (actor.stillOnRoster && !actor.stillOnRoster()) return { ok: false };
  const current = getInstanceIncarnation(db, actor.worktreeId, actor.instanceId);
  if (actor.capturedIncarnation !== null) {
    if (!current || current.incarnation !== actor.capturedIncarnation || current.cliToolId !== actor.cliToolId) {
      return { ok: false };
    }
    return { ok: true, incarnation: current.incarnation };
  }
  if (current && current.cliToolId === actor.cliToolId) return { ok: false };
  if (current) {
    archiveNowSlots(db, [actor.worktreeId], { instanceIds: [actor.instanceId], now, deleteRows: true });
  }
  return { ok: true, incarnation: startInstanceIncarnation(db, actor.worktreeId, actor.instanceId, actor.cliToolId, now) };
}

const scopeClause = (scope: MemScope, alias = ''): { sql: string; params: unknown[] } => {
  const ids = scope.readRepositoryIds.length > 0 ? scope.readRepositoryIds : [scope.storageRepositoryId];
  const marks = ids.map(() => '?').join(',');
  if (scope.branch === null) {
    return {
      sql: `${alias}repository_id IN (${marks}) AND ${alias}branch IS NULL AND ${alias}origin_worktree_id = ?`,
      params: [...ids, scope.worktreeId ?? ''],
    };
  }
  return { sql: `${alias}repository_id IN (${marks}) AND ${alias}branch = ?`, params: [...ids, scope.branch] };
};

export function countOpenItems(db: Database.Database, scope: MemScope, kind: MemKind): number {
  const where = scopeClause(scope);
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM mem_items WHERE ${where.sql} AND kind = ? AND state != 'closed'`).get(...where.params, kind) as {
      n: number;
    }
  ).n;
}

export function countClosedItems(db: Database.Database, scope: MemScope): number {
  const where = scopeClause(scope);
  return (db.prepare(`SELECT COUNT(*) AS n FROM mem_items WHERE ${where.sql} AND state = 'closed'`).get(...where.params) as { n: number }).n;
}

/** The fields that make two requests with one key the same request (§5.4). */
export function memRequestFingerprint(fields: Record<string, unknown>): string {
  const ordered = Object.keys(fields)
    .sort()
    .map((key) => [key, fields[key] ?? null]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export interface MemNewItem {
  kind: Exclude<MemKind, 'now'>;
  text: string;
  closeWhen: string | null;
  /** The condition as typed (normalized whitespace), for the fingerprint; null when omitted. */
  closeWhenInput: string | null;
  promoteTo: string | null;
  quote: string | null;
  quoteAt: number | null;
  evidence: string[];
  key: string | null;
}

function findItemRow(db: Database.Database, id: string): ItemRow | undefined {
  return db.prepare('SELECT * FROM mem_items WHERE id = ?').get(id) as ItemRow | undefined;
}

function findSlotByItem(db: Database.Database, id: string): SlotRow | undefined {
  return db.prepare(`SELECT ${SLOT_COLUMNS} FROM session_notes WHERE mem_item_id = ?`).get(id) as SlotRow | undefined;
}

/** An item by id, in either table. */
export function getMemRecord(db: Database.Database, id: string): MemRecord | null {
  const slot = findSlotByItem(db, id);
  if (slot) return recordFromSlot(slot);
  const row = findItemRow(db, id);
  return row ? recordFromItem(row) : null;
}

/** `mem add`: one item, with its key (§5.4) and the open limit (§8.1). */
export function createMemItem(
  db: Database.Database,
  actor: MemActor,
  scope: MemScope,
  input: MemNewItem,
  now: number = Date.now()
): { ok: true; record: MemRecord; replayed: boolean } | MemStoreFailure {
  return db.transaction(() => {
    const settled = settleActorIncarnation(db, actor, now);
    if (!settled.ok) return { ok: false as const, code: 'instance_not_found' as const, reason: 'incarnation_changed' as const };
    const worktreeIncarnation = getOrCreateWorktreeIncarnation(db, actor.worktreeId, now);

    let fingerprint: string | null = null;
    if (input.key !== null) {
      // The repository is checked apart from the fingerprint, against every root that
      // reads as this repository now: a root added since the first attempt must not
      // turn a retry into another request (R9). The condition is fingerprinted as it
      // was typed, because its stored form names the storage root and a branch tip.
      fingerprint = memRequestFingerprint({
        branch: scope.branch,
        worktreeId: actor.worktreeId,
        instanceId: actor.instanceId,
        incarnation: settled.incarnation,
        kind: input.kind,
        text: input.text,
        closeWhen: input.closeWhenInput,
        promoteTo: input.promoteTo,
        quote: input.quote,
        quoteAt: input.quoteAt,
        evidence: input.evidence,
      });
      const existing = db
        .prepare('SELECT * FROM mem_items WHERE origin_incarnation = ? AND idempotency_key = ?')
        .get(settled.incarnation, input.key) as (ItemRow & { request_fingerprint: string }) | undefined;
      if (existing) {
        const sameRepository = (scope.readRepositoryIds.length > 0 ? scope.readRepositoryIds : [scope.storageRepositoryId]).includes(
          existing.repository_id
        );
        if (sameRepository && existing.request_fingerprint === fingerprint) {
          return { ok: true as const, record: recordFromItem(existing), replayed: true };
        }
        return { ok: false as const, code: 'duplicate_key' as const, itemId: existing.id, version: existing.version };
      }
    }

    const limit = MEM_OPEN_LIMITS[input.kind].max;
    if (limit !== null && countOpenItems(db, scope, input.kind) >= limit) {
      return { ok: false as const, code: 'limit_exceeded' as const, kind: input.kind, limit };
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO mem_items (id, repository_id, branch, kind, state, text, close_when, promote_to, quote, quote_at, evidence,
         origin_worktree_id, origin_worktree_incarnation, origin_instance_id, origin_cli_tool_id, origin_incarnation,
         origin_session_generation, created_by, updated_by, updated_by_instance, version, checked_rules_version,
         created_at, updated_at, closed_at, close_reason, close_note, idempotency_key, request_fingerprint)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
    ).run(
      id,
      scope.storageRepositoryId,
      scope.branch,
      input.kind,
      input.text,
      input.closeWhen,
      input.promoteTo,
      input.quote,
      input.quoteAt,
      JSON.stringify(input.evidence),
      actor.worktreeId,
      worktreeIncarnation,
      actor.instanceId,
      actor.cliToolId,
      settled.incarnation,
      actor.sessionGeneration,
      actor.by,
      actor.by,
      actor.instanceId,
      MEM_SECRET_RULES_VERSION,
      now,
      now,
      input.key,
      fingerprint
    );
    return { ok: true as const, record: recordFromItem(findItemRow(db, id)!), replayed: false };
  })();
}

export interface MemNowInput {
  text: string;
  closeWhen: string | null;
  evidence: string[];
}

function writeSlot(
  db: Database.Database,
  actor: MemActor,
  scope: { repositoryId: string; branch: string | null },
  incarnation: string,
  worktreeIncarnation: string,
  input: MemNowInput,
  itemId: string,
  createdBy: 'agent' | 'human',
  createdAt: number,
  now: number
): void {
  const version = nextSlotVersion(db, actor.worktreeId, actor.instanceId);
  db.prepare(
    `INSERT INTO session_notes (worktree_id, instance_id, note, updated_at, version, mem_item_id, mem_repository_id, mem_branch,
       mem_cli_tool_id, mem_incarnation, mem_worktree_incarnation, mem_session_generation, mem_close_when, mem_evidence,
       mem_checked_rules_version, created_by, updated_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(worktree_id, instance_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at,
       version = excluded.version, mem_item_id = excluded.mem_item_id, mem_repository_id = excluded.mem_repository_id,
       mem_branch = excluded.mem_branch, mem_cli_tool_id = excluded.mem_cli_tool_id, mem_incarnation = excluded.mem_incarnation,
       mem_worktree_incarnation = excluded.mem_worktree_incarnation, mem_session_generation = excluded.mem_session_generation,
       mem_close_when = excluded.mem_close_when, mem_evidence = excluded.mem_evidence,
       mem_checked_rules_version = excluded.mem_checked_rules_version, created_by = excluded.created_by,
       updated_by = excluded.updated_by, created_at = excluded.created_at`
  ).run(
    actor.worktreeId,
    actor.instanceId,
    input.text,
    now,
    version,
    itemId,
    scope.repositoryId,
    scope.branch,
    actor.cliToolId,
    incarnation,
    worktreeIncarnation,
    actor.sessionGeneration,
    input.closeWhen,
    JSON.stringify(input.evidence),
    MEM_SECRET_RULES_VERSION,
    createdBy,
    actor.by,
    createdAt
  );
}

/**
 * `mem now`, or a person's note while the mode is `on`: the slot gets a new item,
 * and what it held moves to `mem_items` as superseded (a plain #2427 note is
 * replaced, as a note always was).
 *
 * @param hooks.afterArchive - Test seam: throw here to prove the move goes back with the write
 */
export function replaceNowSlot(
  db: Database.Database,
  actor: MemActor,
  scope: MemScope,
  input: MemNowInput,
  now: number = Date.now(),
  hooks: { afterArchive?: () => void } = {}
): { ok: true; record: MemRecord } | MemStoreFailure {
  return db.transaction(() => {
    const settled = settleActorIncarnation(db, actor, now);
    if (!settled.ok) return { ok: false as const, code: 'instance_not_found' as const, reason: 'incarnation_changed' as const };
    const worktreeIncarnation = getOrCreateWorktreeIncarnation(db, actor.worktreeId, now);
    const previous = readSlot(db, actor.worktreeId, actor.instanceId);
    if (previous?.mem_item_id) archiveSlot(db, previous, 'superseded', actor.by, now);
    hooks.afterArchive?.();
    writeSlot(
      db,
      actor,
      { repositoryId: previous?.mem_repository_id ?? scope.storageRepositoryId, branch: scope.branch },
      settled.incarnation,
      worktreeIncarnation,
      input,
      randomUUID(),
      actor.by,
      now,
      now
    );
    return { ok: true as const, record: recordFromSlot(readSlot(db, actor.worktreeId, actor.instanceId)!) };
  })();
}

export interface MemItemPatch {
  text?: string;
  closeWhen?: string | null;
  evidence?: string[];
}

/**
 * A partial update re-reads only the fields it was sent, so it may raise the
 * checked version only if every field it leaves behind also passes the current
 * rules; otherwise the old version stays and the record stays withheld (review P2-1).
 */
function settleCheckedVersion(db: Database.Database, itemId: string, previous: number): void {
  const record = getMemRecord(db, itemId);
  if (!record || !findWithheld({ ...record, checkedRulesVersion: 0 })) return;
  const slot = findSlotByItem(db, itemId);
  if (slot) db.prepare('UPDATE session_notes SET mem_checked_rules_version = ? WHERE mem_item_id = ?').run(previous, itemId);
  else db.prepare('UPDATE mem_items SET checked_rules_version = ? WHERE id = ?').run(previous, itemId);
}

/** Whether this actor may change this record: its author's incarnation, or a person. */
function ownedBy(db: Database.Database, record: MemRecord, actor: MemActor): boolean {
  if (actor.by === 'human') return true;
  const current = getInstanceIncarnation(db, actor.worktreeId, actor.instanceId);
  if (!current || current.incarnation !== actor.capturedIncarnation) return false;
  // The author is its incarnation, which a rename carries to the new worktree ID;
  // `owner.worktreeId` is where the item was written and stays the old ID (review P2-4).
  return record.owner.instanceId === actor.instanceId && record.owner.incarnation === current.incarnation;
}

/** `mem update --if-version`. */
export function updateMemItem(
  db: Database.Database,
  actor: MemActor,
  itemId: string,
  ifVersion: number,
  patch: MemItemPatch,
  now: number = Date.now()
): { ok: true; record: MemRecord } | MemStoreFailure {
  return db.transaction(() => {
    const current = getMemRecord(db, itemId);
    if (!current) return { ok: false as const, code: 'item_not_found' as const };
    if (!ownedBy(db, current, actor)) return { ok: false as const, code: 'not_owner' as const, current };
    if (!memTransition(current.kind, current.state, 'update').ok) {
      return { ok: false as const, code: 'state_forbids' as const, current };
    }
    if (current.version !== ifVersion) return { ok: false as const, code: 'version_conflict' as const, current };

    const slot = findSlotByItem(db, itemId);
    if (slot) {
      const version = nextSlotVersion(db, slot.worktree_id, slot.instance_id);
      db.prepare(
        `UPDATE session_notes SET note = ?, mem_close_when = ?, mem_evidence = ?, updated_at = ?, version = ?, updated_by = ?,
           mem_checked_rules_version = ? WHERE mem_item_id = ?`
      ).run(
        patch.text ?? slot.note,
        patch.closeWhen !== undefined ? patch.closeWhen : slot.mem_close_when,
        patch.evidence !== undefined ? JSON.stringify(patch.evidence) : slot.mem_evidence,
        now,
        version,
        actor.by,
        MEM_SECRET_RULES_VERSION,
        itemId
      );
      settleCheckedVersion(db, itemId, current.checkedRulesVersion);
      return { ok: true as const, record: recordFromSlot(findSlotByItem(db, itemId)!) };
    }
    const row = findItemRow(db, itemId)!;
    db.prepare(
      `UPDATE mem_items SET text = ?, close_when = ?, evidence = ?, updated_at = ?, version = version + 1, updated_by = ?,
         updated_by_instance = ?, checked_rules_version = ? WHERE id = ?`
    ).run(
      patch.text ?? row.text,
      patch.closeWhen !== undefined ? patch.closeWhen : row.close_when,
      patch.evidence !== undefined ? JSON.stringify(patch.evidence) : row.evidence,
      now,
      actor.by,
      actor.by === 'agent' ? actor.instanceId : null,
      MEM_SECRET_RULES_VERSION,
      itemId
    );
    settleCheckedVersion(db, itemId, current.checkedRulesVersion);
    return { ok: true as const, record: recordFromItem(findItemRow(db, itemId)!) };
  })();
}

/** `mem close` (§3): manual for a non-decision, a withdrawal for an open decision. */
export function closeMemItem(
  db: Database.Database,
  actor: MemActor,
  itemId: string,
  reason: string | null,
  now: number = Date.now()
): { ok: true; record: MemRecord } | MemStoreFailure {
  return db.transaction(() => {
    const current = getMemRecord(db, itemId);
    if (!current) return { ok: false as const, code: 'item_not_found' as const };
    if (!ownedBy(db, current, actor)) return { ok: false as const, code: 'not_owner' as const, current };
    const transition = memTransition(current.kind, current.state, 'close');
    if (!transition.ok) return { ok: false as const, code: 'state_forbids' as const, current };

    const slot = findSlotByItem(db, itemId);
    if (slot) {
      archiveSlot(db, slot, 'manual', actor.by, now);
      if (reason !== null) db.prepare('UPDATE mem_items SET close_note = ? WHERE id = ?').run(reason, itemId);
      nextSlotVersion(db, slot.worktree_id, slot.instance_id);
      db.prepare('DELETE FROM session_notes WHERE mem_item_id = ?').run(itemId);
      return { ok: true as const, record: recordFromItem(findItemRow(db, itemId)!) };
    }
    db.prepare(
      `UPDATE mem_items SET state = 'closed', closed_at = ?, close_reason = ?, close_note = ?, updated_at = ?,
         version = version + 1, updated_by = ?, updated_by_instance = ? WHERE id = ?`
    ).run(now, transition.reason ?? 'manual', reason, now, actor.by, actor.by === 'agent' ? actor.instanceId : null, itemId);
    return { ok: true as const, record: recordFromItem(findItemRow(db, itemId)!) };
  })();
}

/** Items of a branch (open only unless `all`), and the `now` of every slot on it. */
export function listMem(
  db: Database.Database,
  scope: MemScope,
  options: { all?: boolean } = {}
): { items: MemRecord[]; now: Array<{ instanceId: string; worktreeId: string; record: MemRecord }> } {
  const where = scopeClause(scope);
  const items = (
    db
      .prepare(
        `SELECT * FROM mem_items WHERE ${where.sql}${options.all ? '' : " AND state != 'closed'"} ORDER BY created_at, rowid`
      )
      .all(...where.params) as ItemRow[]
  ).map(recordFromItem);
  const ids = scope.readRepositoryIds.length > 0 ? scope.readRepositoryIds : [scope.storageRepositoryId];
  const marks = ids.map(() => '?').join(',');
  const slots = (
    scope.branch === null
      ? db
          .prepare(
            `SELECT ${SLOT_COLUMNS} FROM session_notes WHERE mem_item_id IS NOT NULL AND mem_repository_id IN (${marks})
             AND mem_branch IS NULL AND worktree_id = ? ORDER BY worktree_id, instance_id`
          )
          .all(...ids, scope.worktreeId ?? '')
      : db
          .prepare(
            `SELECT ${SLOT_COLUMNS} FROM session_notes WHERE mem_item_id IS NOT NULL AND mem_repository_id IN (${marks})
             AND mem_branch = ? ORDER BY worktree_id, instance_id`
          )
          .all(...ids, scope.branch)
  ) as SlotRow[];
  return {
    items,
    now: slots.map((slot) => ({ instanceId: slot.instance_id, worktreeId: slot.worktree_id, record: recordFromSlot(slot) })),
  };
}

export interface MemPurgeFilter {
  closedOnly?: boolean;
  kind?: MemKind;
  before?: number;
  includeDecisions?: boolean;
}

/** `mem purge` (§8.3): counts without `confirm`, deletes with it. `mem_items` only. */
export function purgeMem(
  db: Database.Database,
  scope: MemScope,
  filter: MemPurgeFilter,
  confirm: boolean
): Partial<Record<MemKind, number>> {
  const where = scopeClause(scope);
  const clauses = [where.sql];
  const params = [...where.params];
  if (filter.closedOnly) clauses.push("state = 'closed'");
  if (filter.kind) {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.before !== undefined) {
    clauses.push('updated_at < ?');
    params.push(filter.before);
  }
  if (!filter.includeDecisions) clauses.push("NOT (kind = 'decision' AND state IN ('recorded','promoted'))");
  const sql = clauses.join(' AND ');
  return db.transaction(() => {
    const counts: Partial<Record<MemKind, number>> = {};
    for (const row of db.prepare(`SELECT kind, COUNT(*) AS n FROM mem_items WHERE ${sql} GROUP BY kind`).all(...params) as Array<{
      kind: MemKind;
      n: number;
    }>) {
      counts[row.kind] = row.n;
    }
    if (confirm) db.prepare(`DELETE FROM mem_items WHERE ${sql}`).run(...params);
    return counts;
  })();
}

// ===========================================================================
// The #2427 note written from the screen (§6.3・§10.2)
// ===========================================================================

export type ScreenNoteResult =
  | { ok: true; row: SessionSlotView | null }
  | { ok: false; code: 'version_conflict' | 'version_required'; current: SessionSlotView | null }
  | { ok: false; code: 'instance_not_found'; reason: 'incarnation_changed' };

/** A slot as the screen reads it: the #2427 note plus its version and whether it is a `now` of mem. */
export interface SessionSlotView {
  text: string;
  updatedAt: number;
  version: number;
  mem: { itemId: string; createdBy: 'agent' | 'human'; updatedBy: 'agent' | 'human' | 'server' } | null;
}

export function toSlotView(row: SlotRow | undefined): SessionSlotView | null {
  if (!row) return null;
  return {
    text: row.note,
    updatedAt: row.updated_at,
    version: row.version,
    mem: row.mem_item_id
      ? { itemId: row.mem_item_id, createdBy: row.created_by ?? 'agent', updatedBy: row.updated_by ?? 'agent' }
      : null,
  };
}

export function readSessionSlot(db: Database.Database, worktreeId: string, instanceId: string): SessionSlotView | null {
  return toSlotView(readSlot(db, worktreeId, instanceId));
}

/** Whether a slot holds a `now` of mem. The note route asks before deciding which checks apply. */
export function isMemSlot(db: Database.Database, worktreeId: string, instanceId: string): boolean {
  return Boolean(readSlot(db, worktreeId, instanceId)?.mem_item_id);
}

/**
 * Write a person's note per the table of §10.2.
 *
 * @param text - Already normalized and, when the row is or becomes mem, already checked
 * @param baseVersion - What the screen read; undefined for a client older than v66
 * @param baseVersion - What the screen read; undefined for a client older than v66.
 *   0 names "there was no row" (a 409 answered `current: null`), and matches only
 *   while there is still none (3rd review P2-1); a row's version is never 0
 * @param memWrite - Set when the mode is `on`: the note becomes (or replaces) the `now`
 * @param alive - Whether the worktree and instance the request was read for are still
 *   the ones here (`MemActor.stillOnRoster`); asked first in the transaction, so every
 *   mode refuses a request that a delete and re-creation of the worktree (same id and
 *   path) overtook during its awaits (3rd review P2-2)
 */
export function writeScreenNote(
  db: Database.Database,
  input: {
    worktreeId: string;
    instanceId: string;
    text: string;
    baseVersion: number | undefined;
    memWrite: { actor: MemActor; scope: MemScope } | null;
    alive: (() => boolean) | null;
  },
  now: number = Date.now()
): ScreenNoteResult {
  return db.transaction((): ScreenNoteResult => {
    if (input.alive && !input.alive()) return { ok: false, code: 'instance_not_found', reason: 'incarnation_changed' };
    const row = readSlot(db, input.worktreeId, input.instanceId);
    const isMem = Boolean(row?.mem_item_id);
    if (input.baseVersion === undefined) {
      if (isMem) return { ok: false, code: 'version_required', current: toSlotView(row) };
    } else if (row ? row.version !== input.baseVersion : input.baseVersion !== 0) {
      return { ok: false, code: 'version_conflict', current: toSlotView(row) };
    }

    if (input.text.length === 0) {
      if (!row) return { ok: true, row: null };
      if (isMem) archiveSlot(db, row, 'manual', 'human', now);
      nextSlotVersion(db, input.worktreeId, input.instanceId);
      db.prepare('DELETE FROM session_notes WHERE worktree_id = ? AND instance_id = ?').run(input.worktreeId, input.instanceId);
      return { ok: true, row: null };
    }

    if (input.memWrite) {
      const replaced = replaceNowSlot(db, input.memWrite.actor, input.memWrite.scope, { text: input.text, closeWhen: JSON.stringify({ schema: 1, type: 'replaced' }), evidence: [] }, now);
      if (!replaced.ok) return { ok: false, code: 'instance_not_found', reason: 'incarnation_changed' };
      return { ok: true, row: readSessionSlot(db, input.worktreeId, input.instanceId) };
    }

    const version = nextSlotVersion(db, input.worktreeId, input.instanceId);
    if (isMem) {
      db.prepare(
        `UPDATE session_notes SET note = ?, updated_at = ?, version = ?, updated_by = 'human', mem_checked_rules_version = ?
         WHERE worktree_id = ? AND instance_id = ?`
      ).run(input.text, now, version, MEM_SECRET_RULES_VERSION, input.worktreeId, input.instanceId);
      settleCheckedVersion(db, row!.mem_item_id!, row!.mem_checked_rules_version ?? 0);
    } else {
      db.prepare(
        `INSERT INTO session_notes (worktree_id, instance_id, note, updated_at, version) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(worktree_id, instance_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at,
           version = excluded.version`
      ).run(input.worktreeId, input.instanceId, input.text, now, version);
    }
    return { ok: true, row: readSessionSlot(db, input.worktreeId, input.instanceId) };
  })();
}

export type { MemItemOwner };
