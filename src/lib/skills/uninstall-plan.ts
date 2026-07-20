/**
 * Uninstall Plan: proving a Skill directory is safe to remove (Issue #1236)
 *
 * The inverse of #1233's install plan, and deliberately not its mirror image.
 * An install may write into an empty destination; an uninstall must delete, and
 * deletion is the one operation a user cannot undo from CommandMate. So this
 * module answers a narrower question: *is every single file under the install
 * root provably one that CommandMate wrote and that nobody has touched since?*
 *
 * Anything else — a locally edited file, a file the receipt never recorded, a
 * recorded file that has gone missing, a symlink, an unreadable receipt, a scan
 * that hit its bound — makes the plan non-removable. There is no partial
 * uninstall: "delete the seven files we are sure about and leave the eighth"
 * would silently destroy a Skill the user had customised while telling them the
 * operation succeeded.
 *
 * The token contract is #1233's, reused rather than re-derived: the same TTL,
 * the same single-use semantics, the same LRU bound, and the same
 * {@link SkillPlanError} codes, so a drifting or replayed uninstall token is
 * answered exactly like a drifting or replayed install token.
 *
 * Apply is {@link module:lib/skills/uninstall-apply}. This module never deletes.
 *
 * @module lib/skills/uninstall-plan
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { SKILL_ID_MAX_LENGTH, SKILL_ID_PATTERN } from '@/lib/skills/constants';
import { computeSha256Hex, digestMatches } from '@/lib/skills/integrity';
import {
  SKILL_PLAN_MAX_ENTRIES,
  SKILL_PLAN_TTL_MS,
  SKILL_RECEIPT_FILENAME,
  SkillPlanError,
  SkillPlanErrorCode,
  parseInstalledReceipt,
  type SkillPlanActor,
} from '@/lib/skills/install-plan';
import {
  computeSkillTreeHash,
  readExistingSkillTree,
  skillInstallRoot,
  type SkillExistingTree,
  type SkillGitTargetState,
} from '@/lib/skills/preview-diff';
import type { SkillAgentSupport, SkillInstallReceipt } from '@/types/skills';

// =============================================================================
// Vocabulary
// =============================================================================

/** What uninstall would do to one path under the install root. */
export type SkillUninstallDisposition =
  /** Recorded by the receipt, byte-identical to it, and safe to delete. */
  | 'remove'
  /** Recorded by the receipt but its bytes or mode no longer match. */
  | 'modified'
  /** Recorded by the receipt and no longer on disk. */
  | 'missing'
  /** Present under the install root with no receipt recording it. */
  | 'unknown'
  /** Present but not a regular file: a symlink, a device, an oversized blob. */
  | 'irregular';

/** Stable machine reasons, one per disposition plus the plan-level failures. */
export const SkillUninstallReason = {
  /** Recorded, unchanged, and therefore deletable. */
  MANAGED_UNCHANGED: 'SKILL_UNINSTALL_MANAGED_UNCHANGED',
  /** Recorded but locally edited. Deleting it would destroy the user's work. */
  LOCAL_MODIFICATION: 'SKILL_UNINSTALL_LOCAL_MODIFICATION',
  /** Recorded but absent, so the install is no longer the one the receipt describes. */
  RECEIPT_ORPHAN: 'SKILL_UNINSTALL_RECEIPT_ORPHAN',
  /** Present but unrecorded: a user file, or another tool's output. */
  UNMANAGED_FILE: 'SKILL_UNINSTALL_UNMANAGED_FILE',
  /** Present as a symlink, a directory entry or another non-regular entry. */
  NOT_A_REGULAR_FILE: 'SKILL_UNINSTALL_NOT_A_REGULAR_FILE',
  /** No install root exists at all. */
  NOT_INSTALLED: 'SKILL_UNINSTALL_NOT_INSTALLED',
  /** The install root exists but carries no CommandMate receipt. */
  RECEIPT_MISSING: 'SKILL_UNINSTALL_RECEIPT_MISSING',
  /** A receipt file exists but cannot be parsed. */
  RECEIPT_UNREADABLE: 'SKILL_UNINSTALL_RECEIPT_UNREADABLE',
  /** The receipt describes a different Skill than the one being uninstalled. */
  RECEIPT_FOREIGN: 'SKILL_UNINSTALL_RECEIPT_FOREIGN',
  /** The directory walk hit a bound, so absence of unknown files is unproven. */
  TREE_SCAN_TRUNCATED: 'SKILL_UNINSTALL_TREE_SCAN_TRUNCATED',
} as const;

export type SkillUninstallReasonCode =
  (typeof SkillUninstallReason)[keyof typeof SkillUninstallReason];

/** i18n key explaining why one path cannot be removed (UX-07). */
export const SKILL_UNINSTALL_REASON_MESSAGE_KEYS: Record<SkillUninstallReasonCode, string> = {
  [SkillUninstallReason.MANAGED_UNCHANGED]: 'skills.uninstall.reason.managedUnchanged',
  [SkillUninstallReason.LOCAL_MODIFICATION]: 'skills.uninstall.reason.localModification',
  [SkillUninstallReason.RECEIPT_ORPHAN]: 'skills.uninstall.reason.receiptOrphan',
  [SkillUninstallReason.UNMANAGED_FILE]: 'skills.uninstall.reason.unmanagedFile',
  [SkillUninstallReason.NOT_A_REGULAR_FILE]: 'skills.uninstall.reason.notARegularFile',
  [SkillUninstallReason.NOT_INSTALLED]: 'skills.uninstall.reason.notInstalled',
  [SkillUninstallReason.RECEIPT_MISSING]: 'skills.uninstall.reason.receiptMissing',
  [SkillUninstallReason.RECEIPT_UNREADABLE]: 'skills.uninstall.reason.receiptUnreadable',
  [SkillUninstallReason.RECEIPT_FOREIGN]: 'skills.uninstall.reason.receiptForeign',
  [SkillUninstallReason.TREE_SCAN_TRUNCATED]: 'skills.uninstall.reason.treeScanTruncated',
};

/** i18n key for what the user should do next, per outcome (UX-07). */
export const SKILL_UNINSTALL_NEXT_ACTION_KEYS = {
  /** Every file checked out; the plan can be applied. */
  removable: 'skills.uninstall.nextAction.removable',
  /** Something is ambiguous, so nothing will be deleted until the user resolves it. */
  blocked: 'skills.uninstall.nextAction.blocked',
  succeeded: 'skills.uninstall.nextAction.succeeded',
  committedReconciling: 'skills.uninstall.nextAction.committedReconciling',
  failed: 'skills.uninstall.nextAction.failed',
} as const;

/** i18n key per agent support level, so UI and CLI say the same thing (UX-01). */
export const SKILL_UNINSTALL_RELOAD_MESSAGE_KEYS: Record<SkillAgentSupport, string> = {
  native: 'skills.uninstall.reload.native',
  commandmate_runtime: 'skills.uninstall.reload.commandmateRuntime',
  unsupported: 'skills.uninstall.reload.unsupported',
  unknown: 'skills.uninstall.reload.unknown',
};

// =============================================================================
// Assessment
// =============================================================================

/** One path under the install root, and what uninstall would do to it. */
export interface SkillUninstallFileEntry {
  /** Repository-relative POSIX path. Never absolute. */
  path: string;
  /** Path relative to the install root, as the receipt records it. */
  relativePath: string;
  disposition: SkillUninstallDisposition;
  reason: SkillUninstallReasonCode;
  /** The receipt itself, which records every file but not itself. */
  generated: boolean;
  /** Digest the receipt recorded, or null when the file is unrecorded. */
  recordedSha256: string | null;
  /** Digest of what is on disk now, or null when the path is gone. */
  currentSha256: string | null;
  size: number | null;
  executable: boolean;
}

/** Why a plan refuses to delete anything. Paths are repository-relative. */
export interface SkillUninstallBlocker {
  code: SkillUninstallReasonCode;
  path: string | null;
  messageKey: string;
}

export interface SkillUninstallStats {
  removable: number;
  modified: number;
  missing: number;
  unknown: number;
  irregular: number;
}

/** The complete verdict on one install root. Produced without writing anything. */
export interface SkillUninstallAssessment {
  /** Repository-relative install root, always `.agents/skills/<skill-id>`. */
  installRoot: string;
  present: boolean;
  receipt: SkillInstallReceipt | null;
  /** Digest of the receipt bytes on disk; identifies *which* install this is. */
  receiptDigest: string | null;
  entries: SkillUninstallFileEntry[];
  blockers: SkillUninstallBlocker[];
  /** True only when every path under the root is recorded and unchanged. */
  removable: boolean;
  /** Tree hash of the install root as it is now, for drift detection. */
  currentTreeHash: string;
  stats: SkillUninstallStats;
}

function blocker(code: SkillUninstallReasonCode, path: string | null): SkillUninstallBlocker {
  return { code, path, messageKey: SKILL_UNINSTALL_REASON_MESSAGE_KEYS[code] };
}

type ScannedDisposition = Exclude<SkillUninstallDisposition, 'irregular'>;

const DISPOSITION_REASON: Record<ScannedDisposition, SkillUninstallReasonCode> = {
  remove: SkillUninstallReason.MANAGED_UNCHANGED,
  modified: SkillUninstallReason.LOCAL_MODIFICATION,
  missing: SkillUninstallReason.RECEIPT_ORPHAN,
  unknown: SkillUninstallReason.UNMANAGED_FILE,
};

/** Stat bucket each disposition counts towards. */
const DISPOSITION_STAT: Record<ScannedDisposition, keyof SkillUninstallStats> = {
  remove: 'removable',
  modified: 'modified',
  missing: 'missing',
  unknown: 'unknown',
};

/**
 * Decide what uninstall would do to every path under the install root.
 *
 * The receipt is the ownership record, and it is read from the directory it
 * describes rather than from the database: the index can be rebuilt from the
 * receipt but never the other way round, and a delete that trusted the index
 * would act on a claim instead of on evidence.
 *
 * The receipt does not list itself, so it is folded in here under its own
 * on-disk digest. Without that it would read as an unmanaged file and every
 * uninstall would block on the very file that authorises it.
 */
export function assessSkillUninstall(
  installRootAbs: string,
  skillId: string,
  options: { existing?: SkillExistingTree } = {}
): SkillUninstallAssessment {
  const installRoot = skillInstallRoot(skillId);
  const existing = options.existing ?? readExistingSkillTree(installRootAbs);
  const currentTreeHash = computeSkillTreeHash(existing.files);

  const empty: SkillUninstallAssessment = {
    installRoot,
    present: existing.present,
    receipt: null,
    receiptDigest: null,
    entries: [],
    blockers: [],
    removable: false,
    currentTreeHash,
    stats: { removable: 0, modified: 0, missing: 0, unknown: 0, irregular: 0 },
  };

  if (!existing.present) {
    return { ...empty, blockers: [blocker(SkillUninstallReason.NOT_INSTALLED, installRoot)] };
  }

  const blockers: SkillUninstallBlocker[] = [];
  if (existing.truncated) {
    blockers.push(blocker(SkillUninstallReason.TREE_SCAN_TRUNCATED, installRoot));
  }

  const receiptFile = existing.files.find((file) => file.path === SKILL_RECEIPT_FILENAME);
  const receipt = receiptFile ? parseInstalledReceipt(receiptFile.bytes) : null;
  if (!receiptFile) {
    blockers.push(
      blocker(SkillUninstallReason.RECEIPT_MISSING, `${installRoot}/${SKILL_RECEIPT_FILENAME}`)
    );
  } else if (receipt === null) {
    blockers.push(
      blocker(SkillUninstallReason.RECEIPT_UNREADABLE, `${installRoot}/${SKILL_RECEIPT_FILENAME}`)
    );
  } else if (receipt.skill_id !== skillId) {
    blockers.push(
      blocker(SkillUninstallReason.RECEIPT_FOREIGN, `${installRoot}/${SKILL_RECEIPT_FILENAME}`)
    );
  }

  // A receipt that cannot be trusted makes ownership unknowable for every path,
  // so nothing below could promote a file to `remove` anyway.
  const trustedReceipt =
    receiptFile && receipt !== null && receipt.skill_id === skillId ? receipt : null;

  const recorded = new Map<string, { sha256: string; executable: boolean; size: number | null }>();
  if (trustedReceipt && receiptFile) {
    for (const file of trustedReceipt.files) {
      recorded.set(file.path, {
        sha256: file.sha256,
        executable: file.executable,
        size: file.size,
      });
    }
    recorded.set(SKILL_RECEIPT_FILENAME, {
      sha256: receiptFile.sha256,
      executable: false,
      size: receiptFile.size,
    });
  }

  const existingByPath = new Map(existing.files.map((file) => [file.path, file]));
  const entries: SkillUninstallFileEntry[] = [];
  const stats: SkillUninstallStats = {
    removable: 0,
    modified: 0,
    missing: 0,
    unknown: 0,
    irregular: 0,
  };

  for (const relative of [...new Set([...recorded.keys(), ...existingByPath.keys()])].sort()) {
    const owned = recorded.get(relative) ?? null;
    const onDisk = existingByPath.get(relative) ?? null;

    let disposition: ScannedDisposition;
    if (owned === null) disposition = 'unknown';
    else if (onDisk === null) disposition = 'missing';
    else if (
      digestMatches(onDisk.sha256, owned.sha256) &&
      onDisk.executable === owned.executable
    ) {
      disposition = 'remove';
    } else disposition = 'modified';

    const reason = DISPOSITION_REASON[disposition];
    entries.push({
      path: `${installRoot}/${relative}`,
      relativePath: relative,
      disposition,
      reason,
      generated: relative === SKILL_RECEIPT_FILENAME,
      recordedSha256: owned?.sha256 ?? null,
      currentSha256: onDisk?.sha256 ?? null,
      size: onDisk?.size ?? owned?.size ?? null,
      executable: onDisk?.executable ?? owned?.executable ?? false,
    });
    stats[DISPOSITION_STAT[disposition]] += 1;
    if (disposition !== 'remove') {
      blockers.push(blocker(reason, `${installRoot}/${relative}`));
    }
  }

  for (const irregular of existing.irregularPaths) {
    const repoPath = irregular ? `${installRoot}/${irregular}` : installRoot;
    entries.push({
      path: repoPath,
      relativePath: irregular,
      disposition: 'irregular',
      reason: SkillUninstallReason.NOT_A_REGULAR_FILE,
      generated: false,
      recordedSha256: recorded.get(irregular)?.sha256 ?? null,
      currentSha256: null,
      size: null,
      executable: false,
    });
    stats.irregular += 1;
    blockers.push(blocker(SkillUninstallReason.NOT_A_REGULAR_FILE, repoPath));
  }

  return {
    installRoot,
    present: true,
    receipt: trustedReceipt,
    receiptDigest: receiptFile?.sha256 ?? null,
    entries: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    blockers,
    removable: trustedReceipt !== null && blockers.length === 0,
    currentTreeHash,
    stats,
  };
}

// =============================================================================
// Plan shape
// =============================================================================

/** The uninstall target, described without a machine-absolute path. */
export interface SkillUninstallTargetDto {
  worktreeId: string;
  worktreeName: string;
  repositoryName: string;
  branch: string | null;
  headState: SkillGitTargetState['headState'];
  headCommit: string | null;
  workingTreeDirty: boolean;
  installRoot: string;
  currentTreeHash: string;
}

/** Identity and provenance of the install being removed, taken from its receipt. */
export interface SkillUninstallSkillDto {
  id: string;
  version: string;
  source: { repository: string; ref: string; commit: string };
  artifact: { assetName: string; sha256: string };
  effectiveRisk: SkillInstallReceipt['effective_risk'];
  agents: Array<{ agent: string; support: SkillAgentSupport; messageKey: string }>;
}

/** The uninstall plan as served to a client. Contains no path outside the repository. */
export interface SkillUninstallPlanDto {
  token: string;
  /** RFC 3339 UTC instant after which the token is refused. */
  expiresAt: string;
  /** Every path under the install root is recorded and unchanged. */
  removable: boolean;
  blockers: SkillUninstallBlocker[];
  nextActionKey: string;
  target: SkillUninstallTargetDto;
  skill: SkillUninstallSkillDto;
  receipt: { path: string; sha256: string; size: number };
  /** Everything the uninstall would delete. */
  removals: SkillUninstallFileEntry[];
  /** Everything that would stay behind, with the reason it stays. */
  retained: SkillUninstallFileEntry[];
  stats: SkillUninstallStats;
}

/** Everything a token is bound to. Mirrors #1233's install binding. */
export interface SkillUninstallPlanBinding {
  actor: SkillPlanActor;
  operation: 'uninstall';
  worktreeId: string;
  skillId: string;
  version: string;
  /** Digest of the receipt bytes on disk when the plan was built. */
  receiptDigest: string;
  branch: string | null;
  headCommit: string | null;
  currentTreeHash: string;
}

/** Server-side plan record. Never serialized. */
export interface SkillUninstallPlanRecord {
  token: string;
  binding: SkillUninstallPlanBinding;
  bindingHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  /** Server-resolved worktree path. Apply's only source of truth for where to delete. */
  worktreePath: string;
  receipt: SkillInstallReceipt;
  assessment: SkillUninstallAssessment;
  dto: SkillUninstallPlanDto;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Digest of a binding, used to compare two of them without leaking either. */
export function computeSkillUninstallBindingHash(binding: SkillUninstallPlanBinding): string {
  return createHash('sha256').update(canonicalJson(binding)).digest('hex');
}

// =============================================================================
// Plan cache
// =============================================================================

interface UninstallPlanCacheState {
  records: Map<string, SkillUninstallPlanRecord>;
}

declare global {
  // eslint-disable-next-line no-var -- globalThis cache pattern for hot-reload persistence (install-plan.ts precedent)
  var __skillUninstallPlans: UninstallPlanCacheState | undefined;
}

const cache: UninstallPlanCacheState =
  globalThis.__skillUninstallPlans ??
  (globalThis.__skillUninstallPlans = { records: new Map() });

/** Token grammar. Anything else is rejected before the store is consulted. */
export const SKILL_UNINSTALL_PLAN_TOKEN_PATTERN = /^[0-9a-f]{48}$/;

const SKILL_UNINSTALL_PLAN_TOKEN_BYTES = 24;

function sweep(now: number): void {
  for (const record of [...cache.records.values()]) {
    if (now >= record.expiresAt) cache.records.delete(record.token);
  }
  while (cache.records.size >= SKILL_PLAN_MAX_ENTRIES) {
    const oldest = [...cache.records.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    cache.records.delete(oldest.token);
  }
}

function requireRecord(token: string, now: number): SkillUninstallPlanRecord {
  if (!SKILL_UNINSTALL_PLAN_TOKEN_PATTERN.test(token)) {
    throw new SkillPlanError(SkillPlanErrorCode.NOT_FOUND);
  }
  const record = cache.records.get(token);
  if (!record) throw new SkillPlanError(SkillPlanErrorCode.NOT_FOUND);

  const presented = Buffer.from(token, 'utf-8');
  const stored = Buffer.from(record.token, 'utf-8');
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    throw new SkillPlanError(SkillPlanErrorCode.NOT_FOUND);
  }
  if (now >= record.expiresAt) {
    cache.records.delete(record.token);
    throw new SkillPlanError(SkillPlanErrorCode.EXPIRED);
  }
  if (record.consumedAt !== null) throw new SkillPlanError(SkillPlanErrorCode.CONSUMED);
  return record;
}

/** Read a stored plan. Does not spend the token. */
export function getSkillUninstallPlan(
  token: string,
  options: { now?: number } = {}
): SkillUninstallPlanRecord {
  return requireRecord(token, options.now ?? Date.now());
}

/** Facts apply must observe again before it is allowed to delete. */
export interface SkillUninstallObservation {
  branch: string | null;
  headCommit: string | null;
  currentTreeHash: string;
  receiptDigest: string | null;
}

/**
 * Spend a token.
 *
 * Binding equality is checked before staleness, so a token presented for the
 * wrong target is never told anything about the right one. The receipt digest
 * is part of the observation as well as of the binding: branch and tree hash
 * would already catch a content change, but the digest is what proves this is
 * still *the same install* rather than a reinstall that happens to be identical.
 */
export function consumeSkillUninstallPlan(
  token: string,
  expected: { actor: SkillPlanActor; worktreeId: string; skillId: string },
  observed: SkillUninstallObservation,
  options: { now?: number } = {}
): SkillUninstallPlanRecord {
  const now = options.now ?? Date.now();
  const record = requireRecord(token, now);
  const { binding } = record;

  const sameActor =
    binding.actor.type === expected.actor.type && binding.actor.id === expected.actor.id;
  if (
    !sameActor ||
    binding.worktreeId !== expected.worktreeId ||
    binding.skillId !== expected.skillId
  ) {
    throw new SkillPlanError(SkillPlanErrorCode.BINDING_MISMATCH);
  }
  if (!record.dto.removable) throw new SkillPlanError(SkillPlanErrorCode.NOT_INSTALLABLE);

  if (
    observed.branch !== binding.branch ||
    observed.headCommit !== binding.headCommit ||
    observed.currentTreeHash !== binding.currentTreeHash ||
    observed.receiptDigest === null ||
    !digestMatches(observed.receiptDigest, binding.receiptDigest)
  ) {
    throw new SkillPlanError(SkillPlanErrorCode.STALE);
  }

  record.consumedAt = now;
  return record;
}

/** Drop a plan. Safe to call twice. */
export function discardSkillUninstallPlan(token: string): void {
  cache.records.delete(token);
}

/** @internal */
export function resetSkillUninstallPlanCacheForTesting(): void {
  cache.records.clear();
}

/** @internal Number of plans currently held. */
export function getSkillUninstallPlanCount(): number {
  return cache.records.size;
}

// =============================================================================
// Plan construction
// =============================================================================

/** Everything the uninstall plan builder needs. All of it server-resolved. */
export interface CreateSkillUninstallPlanInput {
  actor: SkillPlanActor;
  worktree: {
    id: string;
    name: string;
    /** Server-resolved absolute path from the worktree row. Never client-supplied. */
    path: string;
    repositoryName: string;
  };
  skillId: string;
  /** Absolute install root, derived server-side from the worktree and Skill ID. */
  installRootAbs: string;
  git: SkillGitTargetState;
  now?: number;
}

/**
 * Assess the install root and register a plan under a fresh token.
 *
 * A non-removable assessment still produces a plan: the user is entitled to see
 * *which* file is blocking and why, and #1233 established that a plan the apply
 * step will refuse is more useful than an opaque error. Apply declines to spend
 * such a token, so the preview cannot become a delete by accident.
 *
 * @throws SkillPlanError — `NOT_FOUND` when nothing is installed at the target.
 */
export function createSkillUninstallPlan(
  input: CreateSkillUninstallPlanInput
): SkillUninstallPlanRecord {
  if (!SKILL_ID_PATTERN.test(input.skillId) || input.skillId.length > SKILL_ID_MAX_LENGTH) {
    throw new SkillPlanError(SkillPlanErrorCode.TARGET_UNSAFE);
  }

  const now = input.now ?? Date.now();
  const assessment = assessSkillUninstall(input.installRootAbs, input.skillId);
  if (!assessment.present) {
    throw new SkillPlanError(SkillPlanErrorCode.NOT_FOUND);
  }

  const token = randomBytes(SKILL_UNINSTALL_PLAN_TOKEN_BYTES).toString('hex');
  const expiresAt = now + SKILL_PLAN_TTL_MS;
  const receipt = assessment.receipt;
  const receiptEntry = assessment.entries.find((entry) => entry.generated) ?? null;

  const binding: SkillUninstallPlanBinding = {
    actor: input.actor,
    operation: 'uninstall',
    worktreeId: input.worktree.id,
    skillId: input.skillId,
    version: receipt?.version ?? '',
    receiptDigest: assessment.receiptDigest ?? '',
    branch: input.git.branch,
    headCommit: input.git.headCommit,
    currentTreeHash: assessment.currentTreeHash,
  };

  const dto: SkillUninstallPlanDto = {
    token,
    expiresAt: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    removable: assessment.removable,
    blockers: assessment.blockers,
    nextActionKey: assessment.removable
      ? SKILL_UNINSTALL_NEXT_ACTION_KEYS.removable
      : SKILL_UNINSTALL_NEXT_ACTION_KEYS.blocked,
    target: {
      worktreeId: input.worktree.id,
      worktreeName: input.worktree.name,
      repositoryName: input.worktree.repositoryName,
      branch: input.git.branch,
      headState: input.git.headState,
      headCommit: input.git.headCommit,
      workingTreeDirty: input.git.dirty,
      installRoot: assessment.installRoot,
      currentTreeHash: assessment.currentTreeHash,
    },
    skill: {
      id: input.skillId,
      version: receipt?.version ?? '',
      source: receipt
        ? { ...receipt.source }
        : { repository: '', ref: '', commit: '' },
      artifact: {
        assetName: receipt?.artifact.asset_name ?? '',
        sha256: receipt?.artifact.sha256 ?? '',
      },
      effectiveRisk: receipt?.effective_risk ?? 'low',
      agents: (receipt?.agent_compatibility ?? []).map((entry) => ({
        agent: entry.agent,
        support: entry.support,
        messageKey: SKILL_UNINSTALL_RELOAD_MESSAGE_KEYS[entry.support],
      })),
    },
    receipt: {
      path: `${assessment.installRoot}/${SKILL_RECEIPT_FILENAME}`,
      sha256: assessment.receiptDigest ?? '',
      size: receiptEntry?.size ?? 0,
    },
    removals: assessment.entries.filter((entry) => entry.disposition === 'remove'),
    retained: assessment.entries.filter((entry) => entry.disposition !== 'remove'),
    stats: assessment.stats,
  };

  const record: SkillUninstallPlanRecord = {
    token,
    binding,
    bindingHash: computeSkillUninstallBindingHash(binding),
    createdAt: now,
    expiresAt,
    consumedAt: null,
    worktreePath: input.worktree.path,
    // A blocked plan has no trusted receipt; apply refuses it before this is read.
    receipt: receipt ?? ({} as SkillInstallReceipt),
    assessment,
    dto,
  };

  sweep(now);
  cache.records.set(token, record);
  return record;
}

/**
 * Digest of the receipt currently on disk, or null when there is none.
 *
 * Apply re-reads this immediately before spending the token, so a reinstall
 * between plan and apply is drift rather than a silent substitution.
 */
export function readSkillReceiptDigest(existing: SkillExistingTree): string | null {
  const file = existing.files.find((entry) => entry.path === SKILL_RECEIPT_FILENAME);
  if (!file) return null;
  return parseInstalledReceipt(file.bytes) === null ? null : computeSha256Hex(file.bytes);
}
