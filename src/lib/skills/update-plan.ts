/**
 * Update Plan: proving an installed Skill is safe to move to another exact
 * version, and showing exactly what would change (Issue #1243)
 *
 * The 3-way inventory this module builds compares the *current receipt* (what
 * CommandMate installed), the *current filesystem* (what is there now) and the
 * *candidate artifact* (what the update would write). The receipt→candidate
 * axis is the version diff the user reviews; the receipt→filesystem axis is
 * the guard: a single modified, unknown, missing or irregular path under any
 * recorded install root makes the plan non-updatable (`LOCAL_CHANGES`),
 * because an update that overwrote or deleted a user's edit would destroy work
 * while reporting success. There is no partial update.
 *
 * The token contract is #1233's, reused rather than re-derived: same TTL, same
 * single-use semantics, same LRU bound, same {@link SkillPlanError} codes.
 * A consumed observation that no longer matches the binding — filesystem tree,
 * branch, HEAD or receipt digest — is `SKILL_PLAN_STALE` (HTTP 409), so apply
 * (#1244) can never write against a directory that moved after the preview.
 *
 * Apply is #1244. This module never writes; it defines the contract apply must
 * satisfy, exactly as #1233 did for #1235.
 *
 * @module lib/skills/update-plan
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import path from 'path';
import {
  SKILL_ID_MAX_LENGTH,
  SKILL_ID_PATTERN,
  SKILL_PRIMARY_INSTALL_ROOT_PREFIX,
  SKILL_RISK_ORDER,
} from '@/lib/skills/constants';
import { digestMatches } from '@/lib/skills/integrity';
import {
  SKILL_PLAN_MAX_ENTRIES,
  SKILL_PLAN_TTL_MS,
  SKILL_RECEIPT_FILENAME,
  SkillPlanError,
  SkillPlanErrorCode,
  buildSkillInstallReceipt,
  parseInstalledReceipt,
  receiptInstallRoots,
  serializeSkillInstallReceipt,
  type SkillPlanActor,
  type SkillPlanSkillDto,
} from '@/lib/skills/install-plan';
import {
  SKILL_DIFF_MAX_TOTAL_BYTES,
  SkillPreviewWarning,
  buildUnifiedDiff,
  computeSkillTreeHash,
  isBinaryContent,
  readExistingSkillTree,
  resolveSkillInstallRootFor,
  skillInstallRootFor,
  type SkillExistingTree,
  type SkillGitTargetState,
  type SkillPreviewWarningCode,
} from '@/lib/skills/preview-diff';
import {
  SkillUninstallReason,
  assessSkillUninstall,
  type SkillUninstallAssessment,
  type SkillUninstallReasonCode,
} from '@/lib/skills/uninstall-plan';
import { releaseSkillSnapshot } from '@/lib/skills/snapshot-store';
import {
  SKILL_SCRIPT_EXTENSIONS,
  type SkillPackageSnapshot,
} from '@/lib/skills/package-validator';
import type { SkillCommandMateCompatibility } from '@/lib/skills/compatibility';
import { compareSemVer } from '@/lib/skills/semver';
import type { SkillUpdateRecommendationReasonCode } from '@/lib/skills/version-resolver';
import type {
  SkillAgentCompatibility,
  SkillCatalogEntry,
  SkillCatalogVersion,
  SkillDeclaredPermission,
  SkillInstallReceipt,
  SkillRiskLevel,
} from '@/types/skills';

// =============================================================================
// Vocabulary
// =============================================================================

/** What the update would do to one path of the managed inventory. */
export type SkillUpdateFileChange = 'add' | 'update' | 'remove' | 'unchanged';

/** How the file currently on disk relates to what the receipt recorded. */
export type SkillUpdateLocalState = 'match' | 'modified' | 'missing' | 'unknown';

/** Why an update plan refuses to proceed. Stable machine codes. */
export const SkillUpdateBlockedReason = {
  /** A recorded file was edited, removed, or an unrecorded file appeared. */
  LOCAL_CHANGES: 'SKILL_UPDATE_LOCAL_CHANGES',
  /** A recorded install root is gone entirely. */
  ROOT_MISSING: 'SKILL_UPDATE_ROOT_MISSING',
  /** An install root carries no receipt, so ownership is unknowable. */
  RECEIPT_MISSING: 'SKILL_UPDATE_RECEIPT_MISSING',
  /** A receipt exists but cannot be parsed. */
  RECEIPT_UNREADABLE: 'SKILL_UPDATE_RECEIPT_UNREADABLE',
  /** The receipt describes a different Skill than the one being updated. */
  RECEIPT_FOREIGN: 'SKILL_UPDATE_RECEIPT_FOREIGN',
  /** Two recorded roots carry different receipts, so the install is skewed. */
  ROOT_RECEIPT_DIVERGED: 'SKILL_UPDATE_ROOT_RECEIPT_DIVERGED',
  /** A directory walk hit a bound, so absence of local changes is unproven. */
  TREE_SCAN_TRUNCATED: 'SKILL_UPDATE_TREE_SCAN_TRUNCATED',
  /** The candidate version is not compatible with the running CommandMate. */
  INCOMPATIBLE: 'SKILL_UPDATE_INCOMPATIBLE',
} as const;

export type SkillUpdateBlockedReasonCode =
  (typeof SkillUpdateBlockedReason)[keyof typeof SkillUpdateBlockedReason];

/** i18n key explaining each blocker, so UI and CLI say the same thing. */
export const SKILL_UPDATE_BLOCKED_MESSAGE_KEYS: Record<SkillUpdateBlockedReasonCode, string> = {
  [SkillUpdateBlockedReason.LOCAL_CHANGES]: 'skills.update.blocked.localChanges',
  [SkillUpdateBlockedReason.ROOT_MISSING]: 'skills.update.blocked.rootMissing',
  [SkillUpdateBlockedReason.RECEIPT_MISSING]: 'skills.update.blocked.receiptMissing',
  [SkillUpdateBlockedReason.RECEIPT_UNREADABLE]: 'skills.update.blocked.receiptUnreadable',
  [SkillUpdateBlockedReason.RECEIPT_FOREIGN]: 'skills.update.blocked.receiptForeign',
  [SkillUpdateBlockedReason.ROOT_RECEIPT_DIVERGED]: 'skills.update.blocked.rootReceiptDiverged',
  [SkillUpdateBlockedReason.TREE_SCAN_TRUNCATED]: 'skills.update.blocked.treeScanTruncated',
  [SkillUpdateBlockedReason.INCOMPATIBLE]: 'skills.update.blocked.incompatible',
};

/** i18n key for what the user should do next, per outcome. */
export const SKILL_UPDATE_NEXT_ACTION_KEYS = {
  updatable: 'skills.update.nextAction.updatable',
  blocked: 'skills.update.nextAction.blocked',
} as const;

/** i18n key for the confirmation a high effective-risk candidate requires. */
export const SKILL_UPDATE_HIGH_RISK_MESSAGE_KEY = 'skills.update.highRiskAcknowledgement';

/**
 * i18n key for the *additional* confirmation a risk increase requires,
 * separate from the ordinary update confirmation (fail closed on escalation).
 */
export const SKILL_UPDATE_RISK_INCREASE_MESSAGE_KEY = 'skills.update.riskIncreaseAcknowledgement';

// =============================================================================
// Shapes
// =============================================================================

/** Why the plan refuses to update. Paths are repository-relative, never absolute. */
export interface SkillUpdateBlocker {
  code: SkillUpdateBlockedReasonCode;
  path: string | null;
  messageKey: string;
  /** Underlying per-path reason (an uninstall-assessment code), when one exists. */
  detail: SkillUninstallReasonCode | null;
}

/**
 * One managed path and what the update would do to it.
 *
 * The entry universe is the union of the current receipt's inventory and the
 * candidate artifact's inventory — the version diff. Files on disk that neither
 * side records appear as {@link SkillUpdateBlocker}s, not as entries: they are
 * not part of any version, only in the way. Since #1460 the payload is
 * byte-identical in every recorded root, so one entry list describes each root;
 * paths are anchored at the primary root.
 */
export interface SkillUpdateFileEntry {
  /** Repository-relative POSIX path under the primary install root. */
  path: string;
  /** Path relative to the install root, as receipts record it. */
  relativePath: string;
  change: SkillUpdateFileChange;
  /** The CommandMate-generated receipt, as opposed to a publisher payload file. */
  generated: boolean;
  /** Digest the current receipt records, or null when the path is new. */
  recordedSha256: string | null;
  /** Digest the candidate would write, or null when the update removes the path. */
  candidateSha256: string | null;
  /** Digest of what is on the primary root's disk now, or null when absent. */
  currentSha256: string | null;
  localState: SkillUpdateLocalState;
  size: number | null;
  executable: boolean;
  binary: boolean;
  /** Unified diff body, or null for a binary file or an unshowable change. */
  diff: string | null;
  diffTruncated: boolean;
  additions: number;
  deletions: number;
}

/** Aggregate counts: the version diff plus the local-change guard findings. */
export interface SkillUpdateStats {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  localModified: number;
  localMissing: number;
  localUnknown: number;
  irregular: number;
}

/** Risk triple as one side of the risk comparison. */
export interface SkillUpdateRiskSide {
  declared: SkillRiskLevel;
  computed: SkillRiskLevel;
  effective: SkillRiskLevel;
}

/**
 * Security-relevant differences between the installed version and the
 * candidate, so the user compares the update's effect in one place.
 *
 * The receipt records permissions, risk, agents and the file inventory but not
 * runtime requirements, so `requirements` describes the candidate only.
 */
export interface SkillUpdateSecurityDiff {
  risk: {
    from: SkillUpdateRiskSide;
    to: SkillUpdateRiskSide;
    /** The candidate's effective risk outranks the installed one. */
    increased: boolean;
  };
  permissions: {
    added: SkillDeclaredPermission[];
    removed: SkillDeclaredPermission[];
    unchanged: SkillDeclaredPermission[];
  };
  executables: { added: string[]; removed: string[] };
  scripts: { added: string[]; removed: string[] };
  /** What the candidate requires. The receipt records no requirements to compare. */
  requirements: {
    commands: Array<{ name: string; versionRange: string | null }>;
    networkHosts: string[];
  };
  /** Changelogs of every listed version in (installed, candidate], newest first. */
  changelogs: Array<{ version: string; changelog: string }>;
  agents: { from: SkillAgentCompatibility[]; to: SkillAgentCompatibility[] };
}

/** One recorded install root as the plan assessed it. */
export interface SkillUpdateRootDto {
  /** Repository-relative install root, e.g. `.agents/skills/<id>`. */
  installRoot: string;
  rootPrefix: string;
  /** Every path under the root is recorded by the receipt and unchanged. */
  clean: boolean;
  receiptDigest: string | null;
  currentTreeHash: string;
}

/** The update target, described without a machine-absolute path. */
export interface SkillUpdateTargetDto {
  worktreeId: string;
  worktreeName: string;
  repositoryName: string;
  branch: string | null;
  headState: SkillGitTargetState['headState'];
  headCommit: string | null;
  workingTreeDirty: boolean;
  /** Primary install root; the binding's tree hashes are anchored here. */
  installRoot: string;
  /** Every recorded root, primary first. The receipt's set is authoritative (#1460). */
  installRoots: string[];
  roots: SkillUpdateRootDto[];
  currentTreeHash: string;
  plannedTreeHash: string;
}

/** From/to identity of the version move, every side an exact version. */
export interface SkillUpdateVersionsDto {
  fromVersion: string;
  toVersion: string;
  /** Newest offerable candidate at plan time, for "you could go further" UI. */
  latestVersion: string | null;
  /** Why this candidate was offered (or explicitly selected). */
  reasonCode: SkillUpdateRecommendationReasonCode;
  prerelease: boolean;
}

/** The update plan as served to a client. Contains no path outside the repository. */
export interface SkillUpdatePlanDto {
  token: string;
  /** RFC 3339 UTC instant after which the token is refused. */
  expiresAt: string;
  /** No local change, receipt problem or incompatibility stands in the way. */
  updatable: boolean;
  blockers: SkillUpdateBlocker[];
  nextActionKey: string;
  /** Candidate's effective risk is high, so apply requires an acknowledgement. */
  requiresRiskAcknowledgement: boolean;
  riskAcknowledgementMessageKey: string | null;
  /** Effective risk rises across the update, so apply requires a second, separate acknowledgement. */
  riskIncreased: boolean;
  riskIncreaseMessageKey: string | null;
  update: SkillUpdateVersionsDto;
  target: SkillUpdateTargetDto;
  /** The candidate as inspected, same shape the install plan serves (#1233). */
  skill: SkillPlanSkillDto;
  securityDiff: SkillUpdateSecurityDiff;
  receipt: { path: string; sha256: string; size: number };
  files: SkillUpdateFileEntry[];
  stats: SkillUpdateStats;
  warnings: SkillPreviewWarningCode[];
}

/** Everything a token is bound to. Mirrors #1233's install binding. */
export interface SkillUpdatePlanBinding {
  actor: SkillPlanActor;
  operation: 'update';
  worktreeId: string;
  skillId: string;
  fromVersion: string;
  toVersion: string;
  /** Lowercase hex SHA-256 of the candidate artifact the plan was computed from. */
  artifactSha256: string;
  /** Verified read-only artifact snapshot the candidate bytes came from (#1229). */
  snapshotId: string;
  /** Digest of the current receipt bytes on disk when the plan was built. */
  currentReceiptDigest: string;
  branch: string | null;
  headCommit: string | null;
  /** Primary root's tree hash now / after the update. */
  currentTreeHash: string;
  plannedTreeHash: string;
}

/** Server-side plan record. Never serialized. */
export interface SkillUpdatePlanRecord {
  token: string;
  binding: SkillUpdatePlanBinding;
  bindingHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  /** Server-resolved worktree path. Apply's only source of truth for where to write. */
  worktreePath: string;
  /** Root prefixes apply must rewrite, primary first — the receipt's own set. */
  rootPrefixes: string[];
  /** The receipt the update would leave behind, and its exact bytes. */
  receipt: SkillInstallReceipt;
  receiptBytes: Uint8Array;
  dto: SkillUpdatePlanDto;
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
export function computeSkillUpdateBindingHash(binding: SkillUpdatePlanBinding): string {
  return createHash('sha256').update(canonicalJson(binding)).digest('hex');
}

// =============================================================================
// Installed state
// =============================================================================

/** What reading the primary install root's receipt established. */
export type SkillInstalledReceiptRead =
  | { state: 'not_installed' }
  | { state: 'receipt_missing' }
  | { state: 'receipt_unreadable' }
  | { state: 'receipt_foreign' }
  | { state: 'ok'; receipt: SkillInstallReceipt; receiptDigest: string };

/**
 * Read the receipt at the primary install root, from disk rather than the index.
 *
 * The receipt is the ownership record and the source of the installed exact
 * version; the index can be rebuilt from it but never the other way round.
 *
 * @throws SkillPlanError `TARGET_UNSAFE` when the ID fails the slug grammar.
 */
export function readInstalledSkillReceipt(
  worktreePath: string,
  skillId: string,
  rootPrefix: string
): SkillInstalledReceiptRead {
  if (!SKILL_ID_PATTERN.test(skillId) || skillId.length > SKILL_ID_MAX_LENGTH) {
    throw new SkillPlanError(SkillPlanErrorCode.TARGET_UNSAFE);
  }
  let rootAbs: string;
  try {
    rootAbs = resolveSkillInstallRootFor(worktreePath, rootPrefix, skillId);
  } catch {
    throw new SkillPlanError(SkillPlanErrorCode.TARGET_UNSAFE);
  }

  const existing = readExistingSkillTree(rootAbs);
  if (!existing.present) return { state: 'not_installed' };

  const file = existing.files.find((entry) => entry.path === SKILL_RECEIPT_FILENAME);
  if (!file) return { state: 'receipt_missing' };
  const receipt = parseInstalledReceipt(file.bytes);
  if (receipt === null) return { state: 'receipt_unreadable' };
  if (receipt.skill_id !== skillId) return { state: 'receipt_foreign' };
  return { state: 'ok', receipt, receiptDigest: file.sha256 };
}

// =============================================================================
// Plan cache
// =============================================================================

interface UpdatePlanCacheState {
  records: Map<string, SkillUpdatePlanRecord>;
}

declare global {
  // eslint-disable-next-line no-var -- globalThis cache pattern for hot-reload persistence (install-plan.ts precedent)
  var __skillUpdatePlans: UpdatePlanCacheState | undefined;
}

const cache: UpdatePlanCacheState =
  globalThis.__skillUpdatePlans ?? (globalThis.__skillUpdatePlans = { records: new Map() });

/** Token grammar. Anything else is rejected before the store is consulted. */
export const SKILL_UPDATE_PLAN_TOKEN_PATTERN = /^[0-9a-f]{48}$/;

const SKILL_UPDATE_PLAN_TOKEN_BYTES = 24;

function dropRecord(record: SkillUpdatePlanRecord): void {
  cache.records.delete(record.token);
  // The snapshot reference was taken for this plan; an unconsumed plan must not
  // pin the candidate artifact bytes past its own lifetime.
  if (record.consumedAt === null) releaseSkillSnapshot(record.binding.snapshotId);
}

/**
 * Drop every expired plan, releasing the snapshot each one pinned.
 *
 * @param keep Token to leave in place so its own lookup can still answer
 *   `EXPIRED` rather than the ambiguous `NOT_FOUND`
 * @returns Number of plans dropped
 */
function sweepExpired(now: number, keep?: string): number {
  let dropped = 0;
  for (const record of [...cache.records.values()]) {
    if (record.token !== keep && now >= record.expiresAt) {
      dropRecord(record);
      dropped += 1;
    }
  }
  return dropped;
}

function sweep(now: number): void {
  sweepExpired(now);
  while (cache.records.size >= SKILL_PLAN_MAX_ENTRIES) {
    const oldest = [...cache.records.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    dropRecord(oldest);
  }
}

/**
 * Reclaim expired plans without creating one.
 *
 * The install cache's counterpart; called from the background sweeper so an
 * abandoned update plan does not pin its candidate artifact for the life of
 * the process.
 *
 * @returns Number of plans dropped
 */
export function sweepSkillUpdatePlans(options: { now?: number } = {}): number {
  return sweepExpired(options.now ?? Date.now());
}

function requireRecord(token: string, now: number): SkillUpdatePlanRecord {
  if (!SKILL_UPDATE_PLAN_TOKEN_PATTERN.test(token)) {
    throw new SkillPlanError(SkillPlanErrorCode.NOT_FOUND);
  }
  const record = cache.records.get(token);
  // Every token access reclaims the siblings that expired meanwhile, so a plan
  // nobody applies is not held until the next plan is created.
  sweepExpired(now, token);
  if (!record) throw new SkillPlanError(SkillPlanErrorCode.NOT_FOUND);

  const presented = Buffer.from(token, 'utf-8');
  const stored = Buffer.from(record.token, 'utf-8');
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    throw new SkillPlanError(SkillPlanErrorCode.NOT_FOUND);
  }
  if (now >= record.expiresAt) {
    dropRecord(record);
    throw new SkillPlanError(SkillPlanErrorCode.EXPIRED);
  }
  if (record.consumedAt !== null) throw new SkillPlanError(SkillPlanErrorCode.CONSUMED);
  return record;
}

/** Read a stored plan. Does not spend the token. */
export function getSkillUpdatePlan(
  token: string,
  options: { now?: number } = {}
): SkillUpdatePlanRecord {
  return requireRecord(token, options.now ?? Date.now());
}

/** Facts apply (#1244) must observe again before it is allowed to write. */
export interface SkillUpdateObservation {
  branch: string | null;
  headCommit: string | null;
  /** Tree hash of the primary install root as it is at apply time. */
  currentTreeHash: string;
  /** Digest of the receipt currently at the primary root, or null when gone. */
  receiptDigest: string | null;
}

/**
 * Spend a token.
 *
 * Binding equality is checked before staleness, so a token presented for the
 * wrong target is never told anything about the right one. Any drift of the
 * filesystem, branch, HEAD or receipt after the plan is `STALE` (409): the
 * preview the user approved no longer describes what would happen. Both risk
 * gates fail closed — a high-risk candidate and a risk increase each require
 * their own explicit acknowledgement.
 */
export function consumeSkillUpdatePlan(
  token: string,
  expected: {
    actor: SkillPlanActor;
    worktreeId: string;
    skillId: string;
    toVersion: string;
    riskAcknowledged: boolean;
    riskIncreaseAcknowledged: boolean;
  },
  observed: SkillUpdateObservation,
  options: { now?: number } = {}
): SkillUpdatePlanRecord {
  const now = options.now ?? Date.now();
  const record = requireRecord(token, now);
  const { binding } = record;

  const sameActor =
    binding.actor.type === expected.actor.type && binding.actor.id === expected.actor.id;
  if (
    !sameActor ||
    binding.worktreeId !== expected.worktreeId ||
    binding.skillId !== expected.skillId ||
    binding.toVersion !== expected.toVersion
  ) {
    throw new SkillPlanError(SkillPlanErrorCode.BINDING_MISMATCH);
  }
  if (!record.dto.updatable) throw new SkillPlanError(SkillPlanErrorCode.NOT_INSTALLABLE);
  if (record.dto.requiresRiskAcknowledgement && !expected.riskAcknowledged) {
    throw new SkillPlanError(SkillPlanErrorCode.RISK_NOT_ACKNOWLEDGED);
  }
  if (record.dto.riskIncreased && !expected.riskIncreaseAcknowledged) {
    throw new SkillPlanError(SkillPlanErrorCode.RISK_NOT_ACKNOWLEDGED, {
      riskIncreased: true,
    });
  }

  if (
    observed.branch !== binding.branch ||
    observed.headCommit !== binding.headCommit ||
    observed.currentTreeHash !== binding.currentTreeHash ||
    observed.receiptDigest === null ||
    !digestMatches(observed.receiptDigest, binding.currentReceiptDigest)
  ) {
    throw new SkillPlanError(SkillPlanErrorCode.STALE);
  }

  record.consumedAt = now;
  return record;
}

/** Drop a plan and release its artifact reference. Safe to call twice. */
export function discardSkillUpdatePlan(token: string): void {
  const record = cache.records.get(token);
  if (record) dropRecord(record);
}

/** @internal */
export function resetSkillUpdatePlanCacheForTesting(): void {
  cache.records.clear();
}

/** @internal Number of plans currently held. */
export function getSkillUpdatePlanCount(): number {
  return cache.records.size;
}

// =============================================================================
// Assessment helpers
// =============================================================================

function blocker(
  code: SkillUpdateBlockedReasonCode,
  blockedPath: string | null,
  detail: SkillUninstallReasonCode | null = null
): SkillUpdateBlocker {
  return { code, path: blockedPath, messageKey: SKILL_UPDATE_BLOCKED_MESSAGE_KEYS[code], detail };
}

/** Map one guard finding of the uninstall assessment onto the update vocabulary. */
const GUARD_BLOCKER_CODE: Partial<Record<SkillUninstallReasonCode, SkillUpdateBlockedReasonCode>> =
  {
    [SkillUninstallReason.LOCAL_MODIFICATION]: SkillUpdateBlockedReason.LOCAL_CHANGES,
    [SkillUninstallReason.RECEIPT_ORPHAN]: SkillUpdateBlockedReason.LOCAL_CHANGES,
    [SkillUninstallReason.UNMANAGED_FILE]: SkillUpdateBlockedReason.LOCAL_CHANGES,
    [SkillUninstallReason.NOT_A_REGULAR_FILE]: SkillUpdateBlockedReason.LOCAL_CHANGES,
    [SkillUninstallReason.NOT_INSTALLED]: SkillUpdateBlockedReason.ROOT_MISSING,
    [SkillUninstallReason.RECEIPT_MISSING]: SkillUpdateBlockedReason.RECEIPT_MISSING,
    [SkillUninstallReason.RECEIPT_UNREADABLE]: SkillUpdateBlockedReason.RECEIPT_UNREADABLE,
    [SkillUninstallReason.RECEIPT_FOREIGN]: SkillUpdateBlockedReason.RECEIPT_FOREIGN,
    [SkillUninstallReason.TREE_SCAN_TRUNCATED]: SkillUpdateBlockedReason.TREE_SCAN_TRUNCATED,
  };

interface AssessedRoot {
  prefix: string;
  rel: string;
  existing: SkillExistingTree;
  assessment: SkillUninstallAssessment;
}

function hasScriptExtension(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return SKILL_SCRIPT_EXTENSIONS.includes(base.slice(dot).toLowerCase());
}

function riskSideFromReceipt(receipt: SkillInstallReceipt): SkillUpdateRiskSide {
  return {
    declared: receipt.declared_risk,
    computed: receipt.computed_risk,
    effective: receipt.effective_risk,
  };
}

function buildSecurityDiff(
  receipt: SkillInstallReceipt,
  snapshot: SkillPackageSnapshot,
  version: SkillCatalogVersion,
  catalogEntry: SkillCatalogEntry
): SkillUpdateSecurityDiff {
  const from = riskSideFromReceipt(receipt);
  const to: SkillUpdateRiskSide = {
    declared: snapshot.declaredRisk,
    computed: snapshot.computedRisk,
    effective: snapshot.effectiveRisk,
  };

  const recordedPermissions = new Set(receipt.declared_permissions);
  const candidatePermissions = new Set(snapshot.inspection.declared_permissions);
  const permissions = {
    added: [...candidatePermissions].filter((permission) => !recordedPermissions.has(permission)),
    removed: [...recordedPermissions].filter(
      (permission) => !candidatePermissions.has(permission)
    ),
    unchanged: [...candidatePermissions].filter((permission) =>
      recordedPermissions.has(permission)
    ),
  };

  const recordedPaths = new Set(receipt.files.map((file) => file.path));
  const candidatePaths = new Set(snapshot.files.map((file) => file.path));
  const recordedExecutables = receipt.files
    .filter((file) => file.executable)
    .map((file) => file.path);
  const candidateExecutables = snapshot.files
    .filter((file) => file.executable)
    .map((file) => file.path);
  const executables = {
    added: candidateExecutables.filter((file) => !recordedExecutables.includes(file)),
    removed: recordedExecutables.filter((file) => !candidateExecutables.includes(file)),
  };

  // The receipt records paths but not script classification, so the script diff
  // is limited to what both sides can prove: candidate-classified scripts that
  // are new files, and recorded script-suffixed files the candidate drops.
  const scripts = {
    added: snapshot.inspection.script_paths.filter((file) => !recordedPaths.has(file)),
    removed: [...recordedPaths].filter(
      (file) => hasScriptExtension(file) && !candidatePaths.has(file)
    ),
  };

  const changelogs = catalogEntry.versions
    .filter((entry) => {
      const aboveFrom = compareSemVer(entry.version, receipt.version);
      const atOrBelowTo = compareSemVer(entry.version, version.version);
      return aboveFrom !== null && aboveFrom > 0 && atOrBelowTo !== null && atOrBelowTo <= 0;
    })
    .sort((a, b) => compareSemVer(b.version, a.version) ?? 0)
    .map((entry) => ({ version: entry.version, changelog: entry.changelog }));

  return {
    risk: {
      from,
      to,
      increased: SKILL_RISK_ORDER[to.effective] > SKILL_RISK_ORDER[from.effective],
    },
    permissions,
    executables,
    scripts,
    requirements: {
      commands: snapshot.manifest.requirements.commands.map((command) => ({
        name: command.name,
        versionRange: command.version_range ?? null,
      })),
      networkHosts: [...snapshot.manifest.requirements.network_hosts],
    },
    changelogs,
    agents: {
      from: receipt.agent_compatibility.map((entry) => ({ ...entry })),
      to: version.compatibility.agents.map((entry) => ({ ...entry })),
    },
  };
}

function toSkillPlanSkillDto(
  snapshot: SkillPackageSnapshot,
  version: SkillCatalogVersion,
  compatibility: SkillCommandMateCompatibility
): SkillPlanSkillDto {
  const { manifest } = snapshot;
  return {
    id: snapshot.skillId,
    name: manifest.name,
    version: snapshot.version,
    summary: manifest.summary,
    description: manifest.description,
    capabilities: [...manifest.capabilities],
    expectedOutcomes: [...manifest.expected_outcomes],
    provider: { ...manifest.provider },
    license: manifest.license,
    homepage: manifest.homepage ?? null,
    declaredPermissions: [...snapshot.inspection.declared_permissions],
    requirements: {
      commands: manifest.requirements.commands.map((command) => ({
        name: command.name,
        versionRange: command.version_range ?? null,
      })),
      networkHosts: [...manifest.requirements.network_hosts],
    },
    declaredRisk: snapshot.declaredRisk,
    computedRisk: snapshot.computedRisk,
    effectiveRisk: snapshot.effectiveRisk,
    riskRationale: manifest.risk_rationale,
    executablePaths: [...snapshot.inspection.executable_paths],
    scriptPaths: [...snapshot.inspection.script_paths],
    compatibility: {
      commandmate: compatibility,
      agents: version.compatibility.agents.map((agent) => ({ ...agent })),
    },
    source: {
      repository: version.source.repository,
      ref: version.source.ref,
      commit: version.source.commit,
    },
    artifact: {
      assetName: version.artifact.asset_name,
      sha256: version.artifact.sha256,
      size: version.artifact.size,
      format: version.artifact.format,
    },
  };
}

// =============================================================================
// Plan construction
// =============================================================================

/** Everything the update plan builder needs. All of it server-resolved. */
export interface CreateSkillUpdatePlanInput {
  actor: SkillPlanActor;
  worktree: {
    id: string;
    name: string;
    /** Server-resolved absolute path from the worktree row. Never client-supplied. */
    path: string;
    repositoryName: string;
  };
  skillId: string;
  /** Version the route read from the receipt; re-read drift is answered `STALE`. */
  fromVersion: string;
  /** Candidate package, already source/checksum/archive-verified (#1229/#1230). */
  snapshot: SkillPackageSnapshot;
  /** Catalog version the candidate artifact was published under. */
  version: SkillCatalogVersion;
  /** Snapshot ID the verified candidate bytes are stored under (#1229). */
  snapshotId: string;
  compatibility: SkillCommandMateCompatibility;
  /** Catalog entry, for the intermediate changelogs and the latest marker. */
  catalogEntry: SkillCatalogEntry;
  /** Newest offerable candidate at plan time, or null. */
  latestVersion: string | null;
  /** Why this candidate was offered. */
  reasonCode: SkillUpdateRecommendationReasonCode;
  prerelease: boolean;
  git: SkillGitTargetState;
  now?: number;
}

/**
 * Assess the installed roots, diff the candidate against the receipt, and
 * register a plan under a fresh token.
 *
 * A blocked assessment still produces a plan: the user asked what updating
 * would do and is entitled to see both the version diff and exactly which path
 * blocks it (#1233's precedent). Apply refuses to spend such a token, so the
 * preview cannot become a write by accident.
 *
 * @throws SkillPlanError — `NOT_FOUND` when nothing is installed at the target,
 *   `STALE` when the receipt changed since the route read it.
 */
export function createSkillUpdatePlan(input: CreateSkillUpdatePlanInput): SkillUpdatePlanRecord {
  if (!SKILL_ID_PATTERN.test(input.skillId) || input.skillId.length > SKILL_ID_MAX_LENGTH) {
    throw new SkillPlanError(SkillPlanErrorCode.TARGET_UNSAFE);
  }
  const now = input.now ?? Date.now();
  const { snapshot } = input;

  // The receipt's recorded root set is authoritative for where the update acts
  // (#1460): an install written before a root was added must not be treated as
  // half-missing, and one written with both roots must update both.
  const primaryRead = readInstalledSkillReceipt(
    input.worktree.path,
    input.skillId,
    SKILL_PRIMARY_INSTALL_ROOT_PREFIX
  );
  if (primaryRead.state === 'not_installed') {
    throw new SkillPlanError(SkillPlanErrorCode.NOT_FOUND);
  }
  if (primaryRead.state !== 'ok' || primaryRead.receipt.version !== input.fromVersion) {
    // The receipt changed (or became unreadable) between the route's read and
    // this one; the caller must re-resolve rather than plan against a ghost.
    throw new SkillPlanError(SkillPlanErrorCode.STALE);
  }
  const receipt = primaryRead.receipt;

  let roots: AssessedRoot[];
  try {
    roots = receiptInstallRoots(receipt).map((root) => {
      const prefix = path.posix.dirname(root);
      const abs = resolveSkillInstallRootFor(input.worktree.path, prefix, input.skillId);
      const existing = readExistingSkillTree(abs);
      return {
        prefix,
        rel: skillInstallRootFor(prefix, input.skillId),
        existing,
        assessment: assessSkillUninstall(abs, input.skillId, { existing, rootPrefix: prefix }),
      };
    });
  } catch {
    throw new SkillPlanError(SkillPlanErrorCode.TARGET_UNSAFE);
  }
  const primary = roots[0];

  const blockers: SkillUpdateBlocker[] = [];
  for (const root of roots) {
    for (const finding of root.assessment.blockers) {
      const code = GUARD_BLOCKER_CODE[finding.code];
      if (code) blockers.push(blocker(code, finding.path, finding.code));
    }
    // The payload and receipt are byte-identical in every root (#1460); two
    // roots with different receipts are a skewed install, not a clean one.
    if (
      root !== primary &&
      root.assessment.receiptDigest !== null &&
      root.assessment.receiptDigest !== primary.assessment.receiptDigest
    ) {
      blockers.push(
        blocker(
          SkillUpdateBlockedReason.ROOT_RECEIPT_DIVERGED,
          `${root.rel}/${SKILL_RECEIPT_FILENAME}`
        )
      );
    }
  }
  if (input.compatibility.status !== 'compatible') {
    blockers.push(blocker(SkillUpdateBlockedReason.INCOMPATIBLE, null));
  }

  // The new receipt is fixed first so it takes part in the inventory, the diff
  // and the planned tree hash like any other file (#1233's ordering).
  const rootPrefixes = roots.map((root) => root.prefix);
  const newReceipt = buildSkillInstallReceipt({
    snapshot,
    version: input.version,
    rootPrefixes,
  });
  const newReceiptBytes = serializeSkillInstallReceipt(newReceipt);
  const newReceiptDigest = createHash('sha256').update(newReceiptBytes).digest('hex');

  const recorded = new Map<
    string,
    { sha256: string; size: number | null; executable: boolean }
  >(
    receipt.files.map((file) => [
      file.path,
      { sha256: file.sha256, size: file.size, executable: file.executable },
    ])
  );
  const primaryReceiptFile = primary.existing.files.find(
    (file) => file.path === SKILL_RECEIPT_FILENAME
  );
  recorded.set(SKILL_RECEIPT_FILENAME, {
    sha256: primaryRead.receiptDigest,
    size: primaryReceiptFile?.size ?? null,
    executable: false,
  });

  const candidate = new Map<
    string,
    { sha256: string; size: number; executable: boolean; generated: boolean }
  >(
    snapshot.files.map((file) => [
      file.path,
      { sha256: file.sha256, size: file.size, executable: file.executable, generated: false },
    ])
  );
  candidate.set(SKILL_RECEIPT_FILENAME, {
    sha256: newReceiptDigest,
    size: newReceiptBytes.byteLength,
    executable: false,
    generated: true,
  });

  const onDisk = new Map(primary.existing.files.map((file) => [file.path, file]));
  const budget = { remainingBytes: SKILL_DIFF_MAX_TOTAL_BYTES };
  const entries: SkillUpdateFileEntry[] = [];
  const stats: SkillUpdateStats = {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    localModified: 0,
    localMissing: 0,
    localUnknown: 0,
    irregular: 0,
  };
  let anyBinary = false;
  let anyTruncated = false;

  for (const relative of [...new Set([...recorded.keys(), ...candidate.keys()])].sort()) {
    const before = recorded.get(relative) ?? null;
    const after = candidate.get(relative) ?? null;
    const disk = onDisk.get(relative) ?? null;

    let change: SkillUpdateFileChange;
    if (before && after) {
      change =
        digestMatches(before.sha256, after.sha256) && before.executable === after.executable
          ? 'unchanged'
          : 'update';
    } else if (after) {
      change = 'add';
    } else {
      change = 'remove';
    }

    let localState: SkillUpdateLocalState;
    if (before === null) {
      localState = disk === null ? 'match' : 'unknown';
    } else if (disk === null) {
      localState = 'missing';
    } else {
      localState =
        digestMatches(disk.sha256, before.sha256) && disk.executable === before.executable
          ? 'match'
          : 'modified';
    }

    const generated = after?.generated ?? relative === SKILL_RECEIPT_FILENAME;
    // The recorded bytes are only provably known when the disk still matches the
    // receipt; a locally modified file gets no body rather than a misleading one.
    const beforeBytes = before !== null && disk !== null && localState === 'match' ? disk.bytes : null;
    const afterBytes =
      after === null
        ? null
        : generated
          ? newReceiptBytes
          : snapshot.readFile(relative);
    const binary =
      (beforeBytes !== null && isBinaryContent(beforeBytes)) ||
      (afterBytes !== null && isBinaryContent(afterBytes));
    // A recorded file whose on-disk bytes drifted has no provable "before", so
    // no body is rendered at all: an after-only diff would present the change
    // as a fresh write and hide that it lands on top of the user's edit.
    const unprovable = before !== null && localState !== 'match';
    const body =
      binary || unprovable || change === 'unchanged'
        ? { text: null, truncated: false, additions: 0, deletions: 0 }
        : buildUnifiedDiff(beforeBytes, afterBytes, budget);

    entries.push({
      path: `${primary.rel}/${relative}`,
      relativePath: relative,
      change,
      generated,
      recordedSha256: before?.sha256 ?? null,
      candidateSha256: after?.sha256 ?? null,
      currentSha256: disk?.sha256 ?? null,
      localState,
      size: after?.size ?? before?.size ?? null,
      executable: after?.executable ?? before?.executable ?? false,
      binary,
      diff: body.text,
      diffTruncated: body.truncated,
      additions: body.additions,
      deletions: body.deletions,
    });

    if (change === 'add') stats.added += 1;
    else if (change === 'update') stats.updated += 1;
    else if (change === 'remove') stats.removed += 1;
    else stats.unchanged += 1;
    if (binary) anyBinary = true;
    if (body.truncated) anyTruncated = true;
  }

  for (const root of roots) {
    stats.localModified += root.assessment.stats.modified;
    stats.localMissing += root.assessment.stats.missing;
    stats.localUnknown += root.assessment.stats.unknown;
    stats.irregular += root.assessment.stats.irregular;
  }

  // The planned tree is exactly the candidate set plus its receipt: an update
  // only proceeds from a clean root, and a clean root holds nothing else.
  const plannedTreeHash = computeSkillTreeHash(
    [...candidate.entries()].map(([relative, file]) => ({
      path: relative,
      sha256: file.sha256,
      executable: file.executable,
    }))
  );

  const warnings: SkillPreviewWarningCode[] = [];
  if (input.git.headState === 'detached') warnings.push(SkillPreviewWarning.DETACHED_HEAD);
  if (input.git.headState === 'unborn') warnings.push(SkillPreviewWarning.UNBORN_HEAD);
  if (input.git.headState === 'unknown') warnings.push(SkillPreviewWarning.HEAD_UNRESOLVED);
  if (input.git.dirty) warnings.push(SkillPreviewWarning.WORKING_TREE_DIRTY);
  if (anyBinary) warnings.push(SkillPreviewWarning.BINARY_CONTENT);
  if (anyTruncated) warnings.push(SkillPreviewWarning.DIFF_TRUNCATED);
  if (roots.some((root) => root.existing.truncated)) {
    warnings.push(SkillPreviewWarning.TREE_SCAN_TRUNCATED);
  }

  const securityDiff = buildSecurityDiff(receipt, snapshot, input.version, input.catalogEntry);
  const requiresRiskAcknowledgement = snapshot.effectiveRisk === 'high';
  const riskIncreased = securityDiff.risk.increased;

  const token = randomBytes(SKILL_UPDATE_PLAN_TOKEN_BYTES).toString('hex');
  const expiresAt = now + SKILL_PLAN_TTL_MS;

  const binding: SkillUpdatePlanBinding = {
    actor: input.actor,
    operation: 'update',
    worktreeId: input.worktree.id,
    skillId: input.skillId,
    fromVersion: receipt.version,
    toVersion: snapshot.version,
    artifactSha256: input.version.artifact.sha256,
    snapshotId: input.snapshotId,
    currentReceiptDigest: primaryRead.receiptDigest,
    branch: input.git.branch,
    headCommit: input.git.headCommit,
    currentTreeHash: primary.assessment.currentTreeHash,
    plannedTreeHash,
  };

  const dto: SkillUpdatePlanDto = {
    token,
    expiresAt: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    updatable: blockers.length === 0,
    blockers,
    nextActionKey:
      blockers.length === 0
        ? SKILL_UPDATE_NEXT_ACTION_KEYS.updatable
        : SKILL_UPDATE_NEXT_ACTION_KEYS.blocked,
    requiresRiskAcknowledgement,
    riskAcknowledgementMessageKey: requiresRiskAcknowledgement
      ? SKILL_UPDATE_HIGH_RISK_MESSAGE_KEY
      : null,
    riskIncreased,
    riskIncreaseMessageKey: riskIncreased ? SKILL_UPDATE_RISK_INCREASE_MESSAGE_KEY : null,
    update: {
      fromVersion: receipt.version,
      toVersion: snapshot.version,
      latestVersion: input.latestVersion,
      reasonCode: input.reasonCode,
      prerelease: input.prerelease,
    },
    target: {
      worktreeId: input.worktree.id,
      worktreeName: input.worktree.name,
      repositoryName: input.worktree.repositoryName,
      branch: input.git.branch,
      headState: input.git.headState,
      headCommit: input.git.headCommit,
      workingTreeDirty: input.git.dirty,
      installRoot: primary.rel,
      installRoots: roots.map((root) => root.rel),
      roots: roots.map((root) => ({
        installRoot: root.rel,
        rootPrefix: root.prefix,
        clean: root.assessment.removable,
        receiptDigest: root.assessment.receiptDigest,
        currentTreeHash: root.assessment.currentTreeHash,
      })),
      currentTreeHash: primary.assessment.currentTreeHash,
      plannedTreeHash,
    },
    skill: toSkillPlanSkillDto(snapshot, input.version, input.compatibility),
    securityDiff,
    receipt: {
      path: `${primary.rel}/${SKILL_RECEIPT_FILENAME}`,
      sha256: newReceiptDigest,
      size: newReceiptBytes.byteLength,
    },
    files: entries,
    stats,
    warnings,
  };

  const record: SkillUpdatePlanRecord = {
    token,
    binding,
    bindingHash: computeSkillUpdateBindingHash(binding),
    createdAt: now,
    expiresAt,
    consumedAt: null,
    worktreePath: input.worktree.path,
    rootPrefixes,
    receipt: newReceipt,
    receiptBytes: newReceiptBytes,
    dto,
  };

  sweep(now);
  cache.records.set(token, record);
  return record;
}
