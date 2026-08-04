/**
 * Atomic commit of a planned Skill update into one worktree (Issue #1244)
 *
 * The write half of #1243's update plan/apply pair. The plan fixed the old
 * receipt and tree, the new package and receipt exact bytes, and the target
 * binding (branch, HEAD, tree hash); this module is the only place a managed
 * Skill directory is switched from one version to another.
 *
 * The safety argument extends #1235's install commit rather than replacing it:
 *
 * - **Zero-write on any doubt about the old payload.** Every recorded root is
 *   re-assessed with the uninstall guard immediately before the first rename:
 *   one modified, unknown, missing or irregular path — or any drift from the
 *   receipt digest and tree hash the plan bound — and the operation stops
 *   having changed nothing under either root. There is no partial update.
 * - **The new payload is written by install's own primitives.** Staging uses
 *   {@link stageSkillRootPayload} — the same exclusive no-follow writes, the
 *   same digest/mode re-verification, the same tree-hash gate, the same
 *   same-filesystem check — into the reserved `.commandmate-staging/`
 *   namespace of each destination root.
 * - **The commit point is one rename.** Per root the switch is two renames —
 *   old directory aside into the staging namespace, then staged new payload
 *   into place — and the operation's single commit point is the rename that
 *   publishes the new payload at the *primary* root. Everything before it is
 *   undone in-process (the old directory is renamed back); everything after it
 *   converges forward from the new receipt via #1234 reconciliation, never
 *   backward. Both roots (#1460) ride one journaled operation.
 * - **The old bytes outlive the switch.** Before anything moves, the old
 *   payload is copied into a digest-verified, service-owned backup under the
 *   CommandMate state root — never inside the repository. Retention and
 *   restore are #1245's verified-backup contract; this module only writes the
 *   backup and names it by the operation ID (the interface boundary).
 * - **Nothing is executed.** No script, hook or archive-carried step runs at
 *   any point on this path.
 *
 * Crash recovery: {@link reconcileSkillUpdateTarget} converges an interrupted
 * update's primary root to exactly one of "old complete" or "new complete" —
 * an aside directory is renamed back, a fully verified staged payload whose
 * receipt matches the journal claim is adopted — and
 * {@link completeSecondarySkillUpdateRoots} then converges secondary roots
 * forward from the committed primary.
 *
 * @module lib/skills/updater
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';
import {
  SKILL_ID_MAX_LENGTH,
  SKILL_ID_PATTERN,
  SKILL_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';
import { computeSha256Hex, digestMatches } from '@/lib/skills/integrity';
import {
  SKILL_RECEIPT_FILENAME,
  parseInstalledReceipt,
  receiptInstallRoots,
} from '@/lib/skills/install-plan';
import {
  SKILL_INSTALL_OPERATION_ID_PATTERN,
  SkillInstallErrorCode,
  completeSecondarySkillInstallRoots,
  directoriesForSkillPayload,
  inspectSkillDestination,
  isSkillInstallError,
  resolveSkillInstallTargetFor,
  stageSkillRootPayload,
  type SkillPayloadFile,
  type SkillStagedRootPayload,
} from '@/lib/skills/install-apply';
import {
  assertSkillUninstallAncestors,
  isSkillUninstallError,
} from '@/lib/skills/uninstall-apply';
import { assessSkillUninstall, type SkillUninstallBlocker } from '@/lib/skills/uninstall-plan';
import {
  computeSkillTreeHash,
  readExistingSkillTree,
  resolveSkillInstallRootFor,
  skillInstallRootFor,
  type SkillExistingTree,
} from '@/lib/skills/preview-diff';
import {
  SKILL_STATE_DIR_MODE,
  SKILL_STATE_FILE_MODE,
  ensureSkillStateDir,
  getSkillInstallStagingRoot,
  readSkillStateFile,
  writeSkillStateFile,
  type SkillOperationStoreOptions,
} from '@/lib/skills/operation-store';
import type { SkillPackageSnapshot } from '@/lib/skills/package-validator';
import type { SkillAgentSupport, SkillInstalledFile } from '@/types/skills';

// =============================================================================
// Errors
// =============================================================================

/** Client-safe reasons an update refused to write or could not finish. */
export const SkillUpdateErrorCode = {
  /** The install root could not be derived safely from the worktree and Skill ID. */
  TARGET_UNSAFE: 'SKILL_UPDATE_TARGET_UNSAFE',
  /** An ancestor of an install root is a symlink or is not a directory. */
  ANCESTOR_UNSAFE: 'SKILL_UPDATE_ANCESTOR_UNSAFE',
  /** A recorded install root is not there to update. */
  NOT_INSTALLED: 'SKILL_UPDATE_NOT_INSTALLED',
  /** The old payload is not provably managed-and-unchanged. Nothing was written. */
  LOCAL_CHANGES: 'SKILL_UPDATE_LOCAL_CHANGES',
  /** The install changed between the plan and this apply. Nothing was written. */
  DRIFT: 'SKILL_UPDATE_DRIFT',
  /** Staging and destination are on different filesystems, so rename is not atomic. */
  CROSS_DEVICE: 'SKILL_UPDATE_CROSS_DEVICE',
  /** Staging could not be created or written. Nothing was written to either root. */
  STAGING_IO: 'SKILL_UPDATE_STAGING_IO',
  /** The service-owned old-payload backup could not be written or verified. */
  BACKUP_IO: 'SKILL_UPDATE_BACKUP_IO',
  /** What landed in staging (or was read back) is not what the plan fixed. */
  PAYLOAD_MISMATCH: 'SKILL_UPDATE_PAYLOAD_MISMATCH',
  /** A rename of the switch sequence failed before the commit point. Rolled back. */
  COMMIT_FAILED: 'SKILL_UPDATE_COMMIT_FAILED',
  /**
   * The publish rename failed *and* the old directory could not be renamed
   * back. The primary root is empty; the old payload survives in the aside
   * directory and in the service-owned backup, and startup reconciliation
   * retries the restore.
   */
  RESTORE_FAILED: 'SKILL_UPDATE_RESTORE_FAILED',
} as const;

export type SkillUpdateErrorCodeType =
  (typeof SkillUpdateErrorCode)[keyof typeof SkillUpdateErrorCode];

/** HTTP status each reason maps to, so every caller answers alike. */
export const SKILL_UPDATE_ERROR_STATUS: Record<SkillUpdateErrorCodeType, number> = {
  [SkillUpdateErrorCode.TARGET_UNSAFE]: 400,
  [SkillUpdateErrorCode.ANCESTOR_UNSAFE]: 409,
  [SkillUpdateErrorCode.NOT_INSTALLED]: 409,
  [SkillUpdateErrorCode.LOCAL_CHANGES]: 409,
  [SkillUpdateErrorCode.DRIFT]: 409,
  [SkillUpdateErrorCode.CROSS_DEVICE]: 500,
  [SkillUpdateErrorCode.STAGING_IO]: 500,
  [SkillUpdateErrorCode.BACKUP_IO]: 500,
  [SkillUpdateErrorCode.PAYLOAD_MISMATCH]: 500,
  [SkillUpdateErrorCode.COMMIT_FAILED]: 500,
  [SkillUpdateErrorCode.RESTORE_FAILED]: 500,
} as const;

/** An update rejection. The message is built from the code — never from a path. */
export class SkillUpdateError extends Error {
  constructor(
    readonly code: SkillUpdateErrorCodeType,
    readonly detail?: Record<string, string | number | boolean>,
    /** Repository-relative paths that blocked the operation, for UX-07. */
    readonly blockers: readonly SkillUninstallBlocker[] = []
  ) {
    super(`Skill update rejected: ${code}`);
    this.name = 'SkillUpdateError';
  }

  get status(): number {
    return SKILL_UPDATE_ERROR_STATUS[this.code];
  }
}

export function isSkillUpdateError(value: unknown): value is SkillUpdateError {
  return value instanceof SkillUpdateError;
}

function fail(
  code: SkillUpdateErrorCodeType,
  detail?: Record<string, string | number | boolean>,
  blockers: readonly SkillUninstallBlocker[] = []
): never {
  throw new SkillUpdateError(code, detail, blockers);
}

/** Update code each install-layer staging failure maps onto. */
const STAGING_ERROR_TRANSLATION: Partial<Record<string, SkillUpdateErrorCodeType>> = {
  [SkillInstallErrorCode.TARGET_UNSAFE]: SkillUpdateErrorCode.TARGET_UNSAFE,
  [SkillInstallErrorCode.ANCESTOR_UNSAFE]: SkillUpdateErrorCode.ANCESTOR_UNSAFE,
  [SkillInstallErrorCode.CROSS_DEVICE]: SkillUpdateErrorCode.CROSS_DEVICE,
  [SkillInstallErrorCode.PAYLOAD_MISMATCH]: SkillUpdateErrorCode.PAYLOAD_MISMATCH,
};

/** Map an install-layer staging failure onto the update vocabulary. */
function translateStagingError(error: unknown): never {
  if (isSkillInstallError(error)) {
    fail(STAGING_ERROR_TRANSLATION[error.code] ?? SkillUpdateErrorCode.STAGING_IO, error.detail);
  }
  throw error;
}

// =============================================================================
// Next-action vocabulary
// =============================================================================

/** i18n key for what the user should do next, per apply outcome (UX-07). */
export const SKILL_UPDATE_APPLY_NEXT_ACTION_KEYS = {
  succeeded: 'skills.update.nextAction.succeeded',
  committedReconciling: 'skills.update.nextAction.committedReconciling',
  failed: 'skills.update.nextAction.failed',
} as const;

/** i18n key per agent support level after an update, so UI and CLI agree (UX-01). */
export const SKILL_UPDATE_RELOAD_MESSAGE_KEYS: Record<SkillAgentSupport, string> = {
  native: 'skills.update.reload.native',
  commandmate_runtime: 'skills.update.reload.commandmateRuntime',
  unsupported: 'skills.update.reload.unsupported',
  unknown: 'skills.update.reload.unknown',
};

/**
 * i18n key naming the verified backup a successful update left behind.
 *
 * Lives here rather than in the route for the same reason the reload and
 * next-action keys do: the apply *contract* owns the vocabulary, and the UI,
 * the CLI and the i18n guard all read it from one place.
 */
export const SKILL_UPDATE_ROLLBACK_MESSAGE_KEY = 'skills.update.rollbackAvailable';

// =============================================================================
// Service-owned verified backup (#1245 interface boundary)
// =============================================================================

/** Sub-directory of the Skill state root holding old-payload backups. */
export const SKILL_UPDATE_BACKUP_DIRNAME = 'backups';

/** Filename of the manifest each backup carries next to its payload. */
export const SKILL_UPDATE_BACKUP_MANIFEST_FILENAME = 'backup.json';

/**
 * What one verified backup asserts about itself.
 *
 * This is the hand-off contract to #1245 (retention and rollback): the payload
 * bytes live under `payload/`, and every entry here was digest-verified after
 * the copy, so a later restore can re-prove the backup before trusting it.
 * The manifest is written last, so a manifest that exists names a backup whose
 * payload finished writing.
 */
export interface SkillUpdateBackupManifest {
  schemaVersion: 1;
  /** Backup identity: the update operation that created it. */
  backupId: string;
  worktreeId: string;
  skillId: string;
  /** Version the backup preserves. */
  fromVersion: string;
  /** Version the update moved to. */
  toVersion: string;
  /** Digest of the old receipt bytes, identifying *which* install this was. */
  receiptDigest: string;
  /** Tree hash of the old primary root, receipt included. */
  treeHash: string;
  files: SkillInstalledFile[];
  createdAt: number;
}

/** Where one backup's files live. Service-owned; never inside a repository. */
function backupDirFor(backupId: string, options: SkillOperationStoreOptions): string {
  return path.join(ensureSkillStateDir(SKILL_UPDATE_BACKUP_DIRNAME, options), backupId);
}

/** Read a backup's manifest, or null when the backup does not exist. */
export function readSkillUpdateBackupManifest(
  backupId: string,
  options: SkillOperationStoreOptions = {}
): SkillUpdateBackupManifest | null {
  if (!SKILL_INSTALL_OPERATION_ID_PATTERN.test(backupId)) return null;
  return readSkillStateFile<SkillUpdateBackupManifest>(
    path.join(backupDirFor(backupId, options), SKILL_UPDATE_BACKUP_MANIFEST_FILENAME)
  );
}

/**
 * Copy the old payload into the service-owned backup root and verify it.
 *
 * Runs before anything in the worktree moves, and reads only — a failure here
 * aborts the update with both roots untouched. Every copied file is re-read
 * and digest-compared against the receipt inventory, so the backup #1245 will
 * be asked to restore from is proven, not assumed.
 */
function createVerifiedSkillUpdateBackup(
  input: {
    backupId: string;
    worktreeId: string;
    skillId: string;
    fromVersion: string;
    toVersion: string;
    receiptDigest: string;
    treeHash: string;
    existing: SkillExistingTree;
  },
  options: SkillOperationStoreOptions
): SkillUpdateBackupManifest {
  const backupDir = backupDirFor(input.backupId, options);
  const payloadDir = path.join(backupDir, 'payload');
  try {
    mkdirSync(payloadDir, { recursive: true, mode: SKILL_STATE_DIR_MODE });
  } catch {
    fail(SkillUpdateErrorCode.BACKUP_IO, { reason: 'mkdir' });
  }

  const files: SkillInstalledFile[] = [];
  for (const file of input.existing.files) {
    const target = path.join(payloadDir, file.path);
    try {
      mkdirSync(path.dirname(target), { recursive: true, mode: SKILL_STATE_DIR_MODE });
      writeSkillStateBytes(target, file.bytes);
    } catch {
      fail(SkillUpdateErrorCode.BACKUP_IO, { reason: 'write' });
    }
    let readBack: Buffer;
    try {
      readBack = readFileSync(target);
    } catch {
      return fail(SkillUpdateErrorCode.BACKUP_IO, { reason: 'readback' });
    }
    if (!digestMatches(computeSha256Hex(readBack), file.sha256)) {
      fail(SkillUpdateErrorCode.BACKUP_IO, { reason: 'digest' });
    }
    files.push({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      executable: file.executable,
    });
  }

  const manifest: SkillUpdateBackupManifest = {
    schemaVersion: 1,
    backupId: input.backupId,
    worktreeId: input.worktreeId,
    skillId: input.skillId,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    receiptDigest: input.receiptDigest,
    treeHash: input.treeHash,
    files,
    createdAt: Date.now(),
  };
  try {
    writeSkillStateFile(
      path.join(backupDir, SKILL_UPDATE_BACKUP_MANIFEST_FILENAME),
      manifest
    );
  } catch {
    fail(SkillUpdateErrorCode.BACKUP_IO, { reason: 'manifest' });
  }
  return manifest;
}

/**
 * Plain 0600 byte write for backup payload files (service root, owner-only).
 *
 * `wx` refuses to overwrite: a colliding backup path means a colliding
 * operation ID, which must surface rather than silently merge two backups.
 */
function writeSkillStateBytes(target: string, bytes: Uint8Array): void {
  writeFileSync(target, bytes, { flag: 'wx', mode: SKILL_STATE_FILE_MODE });
}

// =============================================================================
// Path helpers
// =============================================================================

/** Name of the staged-new-payload directory for one update operation. */
export function skillUpdateStagingNameFor(operationId: string): string {
  return `${operationId}-new`;
}

/** Name of the old-payload aside directory for one update operation. */
export function skillUpdateAsideNameFor(operationId: string): string {
  return `${operationId}-old`;
}

/** Absolute install root for a validated Skill ID under one root prefix. */
function resolveUpdateTargetFor(
  worktreePath: string,
  rootPrefix: string,
  skillId: string
): string {
  if (!SKILL_ID_PATTERN.test(skillId) || skillId.length > SKILL_ID_MAX_LENGTH) {
    fail(SkillUpdateErrorCode.TARGET_UNSAFE, { reason: 'skill-id' });
  }
  try {
    return resolveSkillInstallRootFor(worktreePath, rootPrefix, skillId);
  } catch {
    return fail(SkillUpdateErrorCode.TARGET_UNSAFE, { reason: 'install-root' });
  }
}

/** Ancestor lstat walk, translated onto the update vocabulary. */
function assertUpdateAncestors(
  worktreeRealPath: string,
  worktreePath: string,
  rootPrefix: string
): void {
  try {
    assertSkillUninstallAncestors(worktreeRealPath, worktreePath, rootPrefix);
  } catch (error) {
    if (isSkillUninstallError(error)) {
      fail(SkillUpdateErrorCode.ANCESTOR_UNSAFE, error.detail);
    }
    throw error;
  }
}

/** Root prefix a repository-relative install root records for this Skill ID. */
function rootPrefixOf(rootRel: string, skillId: string): string {
  return rootRel.slice(0, Math.max(0, rootRel.length - skillId.length - 1));
}

/** Remove the staging root once it is empty, so it does not linger in a worktree. */
function pruneStagingRoot(stagingRoot: string): void {
  try {
    rmdirSync(stagingRoot);
  } catch {
    // Still in use by a concurrent operation, or already gone.
  }
}

function removeQuietly(target: string): void {
  rmSync(target, { recursive: true, force: true });
}

function isDirectory(target: string): boolean {
  try {
    const stats = lstatSync(target);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

// =============================================================================
// Apply
// =============================================================================

/** Injection points for the crash/failure tests. Production passes none. */
export interface SkillUpdateApplyHooks {
  /** Runs immediately before the old directory of `rootPrefix` moves aside. */
  beforeAside?: (rootPrefix: string) => void;
  /** Runs between the aside rename and the publish rename of `rootPrefix`. */
  beforePublish?: (rootPrefix: string) => void;
  /** Runs immediately after the publish rename of `rootPrefix` landed. */
  afterPublish?: (rootPrefix: string) => void;
}

/** Everything the commit needs. All of it server-resolved or plan-fixed. */
export interface SkillUpdateApplyInput {
  /** Absolute path from the worktree row. Never client-supplied. */
  worktreePath: string;
  /** Symlink-free form of {@link worktreePath}, resolved before the lock was taken. */
  worktreeRealPath: string;
  worktreeId: string;
  skillId: string;
  /** Opaque server-generated ID; names staging, aside and backup directories. */
  operationId: string;
  /** Verified candidate package the plan was computed from. Read, never re-downloaded. */
  snapshot: SkillPackageSnapshot;
  /** The exact new receipt bytes the plan fixed. Written verbatim, not rebuilt. */
  receiptBytes: Uint8Array;
  /** Tree hash the plan committed each destination root to. */
  plannedTreeHash: string;
  /** Digest of the old receipt bytes the plan bound. Re-proven before the switch. */
  expectedReceiptDigest: string;
  /** Tree hash of the old primary root the plan bound. Re-proven before the switch. */
  expectedTreeHash: string;
  /** Root prefixes to switch, primary first — the plan record's own set (#1460). */
  rootPrefixes?: readonly string[];
  /**
   * Called once, immediately after the primary root's publish rename landed.
   * This is the update's commit point: the caller records `FS_COMMITTED` here,
   * and any later failure is *committed, reconciling*, never a rollback.
   */
  onCommitPoint?: () => void;
  /** Override of the service-owned state root. Tests pass a temp directory. */
  stateRoot?: string;
  /** @internal Failure-injection seams for the crash tests. */
  hooks?: SkillUpdateApplyHooks;
}

/** Reference to the verified old-payload backup handed to #1245. */
export interface SkillUpdateBackupRef {
  /** Backup identity: equals the update operation ID. */
  backupId: string;
  /** Version whose bytes the backup preserves. */
  fromVersion: string;
  fileCount: number;
  /** Every copied byte was re-read and digest-verified. */
  verified: boolean;
}

/** What the commit produced. Paths are repository-relative. */
export interface SkillUpdateApplyResult {
  /** Primary repository-relative install root (`.agents/skills/<id>`). */
  installRoot: string;
  /** Every root the update targeted, primary first (#1460). */
  installRoots: string[];
  /** Roots whose switch to the new payload landed. */
  committedRoots: string[];
  /** Roots not yet switched because a failure followed the primary commit. */
  pendingRoots: string[];
  /** A secondary root is still owed: the operation committed but is reconciling. */
  reconciling: boolean;
  fromVersion: string;
  toVersion: string;
  receiptPath: string;
  receiptSha256: string;
  receiptSize: number;
  files: SkillInstalledFile[];
  treeHash: string;
  /** The verified backup of the old payload (#1245 interface boundary). */
  backup: SkillUpdateBackupRef;
}

interface AssessedUpdateRoot {
  prefix: string;
  rel: string;
  abs: string;
  existing: SkillExistingTree;
}

/**
 * Stage, verify and atomically switch one Skill install to a new exact version.
 *
 * Order of operations, and what each failure means:
 *
 * 1. re-assess every recorded root (clean, digest- and hash-identical to the
 *    plan binding) — any finding is a zero-write refusal;
 * 2. read and digest-verify the new payload from the snapshot — zero-write;
 * 3. write the verified service-owned backup of the old payload — zero-write;
 * 4. stage the new payload into every root's reserved namespace — zero-write
 *    (staging is removed on failure and the payload directories never moved);
 * 5. switch the primary root: old aside, staged new in. The publish rename is
 *    the commit point; on a pre-publish failure the old directory is renamed
 *    back and the worktree is byte-for-byte what it was;
 * 6. switch each secondary root the same way. A failure here leaves the
 *    operation *committed, reconciling* and the remaining roots to #1234.
 *
 * @throws SkillUpdateError — before the commit point the worktree is unchanged
 *   in every case except {@link SkillUpdateErrorCode.RESTORE_FAILED}, which is
 *   documented on the code itself.
 */
export function applySkillUpdate(input: SkillUpdateApplyInput): SkillUpdateApplyResult {
  if (!SKILL_INSTALL_OPERATION_ID_PATTERN.test(input.operationId)) {
    fail(SkillUpdateErrorCode.STAGING_IO, { reason: 'operation-id' });
  }
  if (
    !SKILL_INSTALL_OPERATION_ID_PATTERN.test(skillUpdateStagingNameFor(input.operationId)) ||
    !SKILL_INSTALL_OPERATION_ID_PATTERN.test(skillUpdateAsideNameFor(input.operationId))
  ) {
    fail(SkillUpdateErrorCode.STAGING_IO, { reason: 'operation-id-length' });
  }
  const storeOptions: SkillOperationStoreOptions =
    input.stateRoot === undefined ? {} : { root: input.stateRoot };

  const rootPrefixes =
    input.rootPrefixes && input.rootPrefixes.length > 0
      ? [...input.rootPrefixes]
      : [SKILL_INSTALL_ROOT_PREFIX];

  // ---------------------------------------------------------------------------
  // 1. Re-verify the old payload at every root, immediately before the switch.
  // ---------------------------------------------------------------------------
  const roots: AssessedUpdateRoot[] = [];
  let fromVersion: string | null = null;
  for (const prefix of rootPrefixes) {
    const abs = resolveUpdateTargetFor(input.worktreePath, prefix, input.skillId);
    assertUpdateAncestors(input.worktreeRealPath, input.worktreePath, prefix);

    const existing = readExistingSkillTree(abs);
    const assessment = assessSkillUninstall(abs, input.skillId, {
      existing,
      rootPrefix: prefix,
    });
    if (!assessment.present) {
      fail(SkillUpdateErrorCode.NOT_INSTALLED, { root: prefix });
    }
    // The uninstall guard is the strongest statement available about the old
    // payload: every path recorded by the receipt and byte-identical to it.
    // One finding and the update writes nothing (LOCAL_CHANGES fail-closed).
    if (!assessment.removable || assessment.receipt === null) {
      fail(SkillUpdateErrorCode.LOCAL_CHANGES, undefined, assessment.blockers);
    }
    // Every root must still be exactly the install the plan was built against:
    // the payload is byte-identical across roots (#1460), so each root must
    // match the same receipt digest and tree hash the token was bound to.
    if (
      assessment.receiptDigest === null ||
      !digestMatches(assessment.receiptDigest, input.expectedReceiptDigest)
    ) {
      fail(SkillUpdateErrorCode.DRIFT, { reason: 'receipt-digest', root: prefix });
    }
    if (assessment.currentTreeHash !== input.expectedTreeHash) {
      fail(SkillUpdateErrorCode.DRIFT, { reason: 'tree-hash', root: prefix });
    }
    fromVersion = assessment.receipt.version;
    roots.push({ prefix, rel: skillInstallRootFor(prefix, input.skillId), abs, existing });
  }
  const primary = roots[0];
  if (fromVersion === null) {
    fail(SkillUpdateErrorCode.NOT_INSTALLED);
  }

  // ---------------------------------------------------------------------------
  // 2. Read and prove the new payload once; stage the same bytes into each root.
  // ---------------------------------------------------------------------------
  const payload: SkillPayloadFile[] = input.snapshot.files.map((file) => {
    const bytes = input.snapshot.readFile(file.path);
    if (!digestMatches(computeSha256Hex(bytes), file.sha256)) {
      fail(SkillUpdateErrorCode.PAYLOAD_MISMATCH, { reason: 'snapshot-digest' });
    }
    return { relativePath: file.path, bytes, executable: file.executable };
  });
  const directories = directoriesForSkillPayload(
    input.snapshot.files.map((file) => file.path),
    input.snapshot.directories
  );

  // ---------------------------------------------------------------------------
  // 3. Verified service-owned backup of the old payload (#1245 boundary).
  // ---------------------------------------------------------------------------
  const backupManifest = createVerifiedSkillUpdateBackup(
    {
      backupId: input.operationId,
      worktreeId: input.worktreeId,
      skillId: input.skillId,
      fromVersion,
      toVersion: input.snapshot.version,
      receiptDigest: input.expectedReceiptDigest,
      treeHash: input.expectedTreeHash,
      existing: primary.existing,
    },
    storeOptions
  );

  // ---------------------------------------------------------------------------
  // 4. Stage the new payload into every root before the primary commits, so a
  //    root that cannot even stage aborts the whole operation with zero writes.
  // ---------------------------------------------------------------------------
  const staged = new Map<string, SkillStagedRootPayload>();
  const stagingName = skillUpdateStagingNameFor(input.operationId);
  try {
    for (const root of roots) {
      staged.set(
        root.prefix,
        stageSkillRootPayload({
          worktreePath: input.worktreePath,
          worktreeRealPath: input.worktreeRealPath,
          rootPrefix: root.prefix,
          skillId: input.skillId,
          stagingName,
          payload,
          directories,
          receiptBytes: input.receiptBytes,
          plannedTreeHash: input.plannedTreeHash,
        })
      );
    }
  } catch (error) {
    for (const stagedRoot of staged.values()) {
      removeQuietly(stagedRoot.stagingDir);
      pruneStagingRoot(stagedRoot.stagingRoot);
    }
    translateStagingError(error);
  }

  // ---------------------------------------------------------------------------
  // 5./6. Switch each root: old aside, staged new in. Primary publish = commit.
  // ---------------------------------------------------------------------------
  const committedRoots: string[] = [];
  const pendingRoots: string[] = [];
  let committed = false;

  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    const stagedRoot = staged.get(root.prefix)!;
    const asideDir = path.join(stagedRoot.stagingRoot, skillUpdateAsideNameFor(input.operationId));

    try {
      switchSkillRoot({
        root,
        stagedRoot,
        asideDir,
        worktreeRealPath: input.worktreeRealPath,
        worktreePath: input.worktreePath,
        expectedReceiptDigest: input.expectedReceiptDigest,
        expectedTreeHash: input.expectedTreeHash,
        hooks: input.hooks,
      });
      committedRoots.push(root.rel);
      if (index === 0) {
        committed = true;
        input.onCommitPoint?.();
      }
      input.hooks?.afterPublish?.(root.prefix);
    } catch (error) {
      if (!committed) {
        // The primary never published: undo is complete (switchSkillRoot
        // restored the aside directory or never moved it), so remove every
        // root's staging and report an unchanged worktree.
        for (const stagedEntry of staged.values()) {
          removeQuietly(stagedEntry.stagingDir);
          pruneStagingRoot(stagedEntry.stagingRoot);
        }
        throw error;
      }
      // The primary committed. Whatever a secondary did, the operation is
      // *committed, reconciling*: report every root that did not land and hand
      // it to #1234 forward convergence. This root's own staging/aside
      // leftovers are in the reserved namespace and are collected there.
      for (let rest = index; rest < roots.length; rest += 1) {
        if (!committedRoots.includes(roots[rest].rel)) pendingRoots.push(roots[rest].rel);
      }
      break;
    }
    // The old directory of this root is switched out; the aside copy served
    // its purpose (the durable copy lives in the service-owned backup).
    removeQuietly(asideDir);
    pruneStagingRoot(stagedRoot.stagingRoot);
  }

  const receiptSha256 = computeSha256Hex(input.receiptBytes);
  return {
    installRoot: primary.rel,
    installRoots: roots.map((root) => root.rel),
    committedRoots,
    pendingRoots,
    reconciling: pendingRoots.length > 0,
    fromVersion,
    toVersion: input.snapshot.version,
    receiptPath: `${primary.rel}/${SKILL_RECEIPT_FILENAME}`,
    receiptSha256,
    receiptSize: input.receiptBytes.byteLength,
    files: input.snapshot.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      executable: file.executable,
    })),
    treeHash: input.plannedTreeHash,
    backup: {
      backupId: backupManifest.backupId,
      fromVersion: backupManifest.fromVersion,
      fileCount: backupManifest.files.length,
      verified: true,
    },
  };
}

/** One root's aside → publish switch, undone in-process when publish fails. */
function switchSkillRoot(input: {
  root: AssessedUpdateRoot;
  stagedRoot: SkillStagedRootPayload;
  asideDir: string;
  worktreePath: string;
  worktreeRealPath: string;
  expectedReceiptDigest: string;
  expectedTreeHash: string;
  hooks?: SkillUpdateApplyHooks;
}): void {
  const { root, stagedRoot, asideDir } = input;

  // Re-checked immediately before the switch: the exclusive lock keeps
  // CommandMate out, but nothing keeps the user's own tooling from swapping an
  // ancestor or the payload while the staging was being written.
  assertUpdateAncestors(input.worktreeRealPath, input.worktreePath, root.prefix);
  const nowExisting = readExistingSkillTree(root.abs);
  const receiptNow = nowExisting.files.find((file) => file.path === SKILL_RECEIPT_FILENAME);
  if (!nowExisting.present || receiptNow === undefined) {
    fail(SkillUpdateErrorCode.DRIFT, { reason: 'receipt-vanished', root: root.prefix });
  }
  if (!digestMatches(receiptNow.sha256, input.expectedReceiptDigest)) {
    fail(SkillUpdateErrorCode.DRIFT, { reason: 'receipt-digest', root: root.prefix });
  }
  if (computeSkillTreeHash(nowExisting.files) !== input.expectedTreeHash) {
    fail(SkillUpdateErrorCode.DRIFT, { reason: 'tree-hash', root: root.prefix });
  }
  if (isDirectory(asideDir)) {
    fail(SkillUpdateErrorCode.STAGING_IO, { reason: 'aside-occupied', root: root.prefix });
  }

  input.hooks?.beforeAside?.(root.prefix);
  try {
    renameSync(root.abs, asideDir);
  } catch {
    fail(SkillUpdateErrorCode.COMMIT_FAILED, { reason: 'aside-rename', root: root.prefix });
  }

  try {
    input.hooks?.beforePublish?.(root.prefix);
    renameSync(stagedRoot.stagingDir, root.abs);
  } catch (error) {
    // The destination slot is empty and the old directory is intact in the
    // aside location: renaming it back restores the exact previous state.
    try {
      renameSync(asideDir, root.abs);
    } catch {
      fail(SkillUpdateErrorCode.RESTORE_FAILED, { root: root.prefix });
    }
    if (isSkillUpdateError(error)) throw error;
    fail(SkillUpdateErrorCode.COMMIT_FAILED, { reason: 'publish-rename', root: root.prefix });
  }
}

// =============================================================================
// Crash recovery (#1234 forward convergence)
// =============================================================================

/** What the journal entry claims, as the reconciler hands it over. */
export interface SkillUpdateReconcileClaim {
  operationId: string;
  /** Exact version the update moved to (the journal target's version). */
  toVersion: string | null;
  /** Digest of the new receipt bytes, when the entry recorded the commit. */
  receiptDigest: string | null;
}

/** How {@link reconcileSkillUpdateTarget} left the primary root. */
export type SkillUpdateReconcileAction =
  /** The new payload is at the root; leftovers were collected. */
  | 'committed'
  /** The old payload is (still or again) at the root. */
  | 'rolled_back'
  /** The root was empty; the aside directory was renamed back. */
  | 'restored_old'
  /** The root was empty; the fully verified staged payload was adopted. */
  | 'adopted_new'
  /** Nothing on disk backs either version; nothing was changed. */
  | 'unrecoverable';

/**
 * Converge an interrupted update's primary root to old-complete or new-complete.
 *
 * The filesystem question #1234 reconciliation asks of an `update` entry —
 * *did the switch land?* — with the convergence the two-rename sequence makes
 * necessary: a crash can leave the root empty with the old payload in the
 * aside directory, or leave a fully verified staged payload unpublished. This
 * routine restores the former and adopts the latter, so by the time it
 * answers, the root holds exactly one complete version and never a mixture.
 *
 * The new payload is recognised by the journal's own claim: a receipt whose
 * version equals the entry's target version and whose digest matches the
 * recorded one when there is one. An adoption additionally re-proves every
 * staged byte against the staged receipt before the rename — a half-written
 * staging directory is removed, not published.
 */
export function reconcileSkillUpdateTarget(
  worktreePath: string,
  skillId: string,
  claim: SkillUpdateReconcileClaim
): { committed: boolean; action: SkillUpdateReconcileAction } {
  if (
    !SKILL_ID_PATTERN.test(skillId) ||
    skillId.length > SKILL_ID_MAX_LENGTH ||
    !SKILL_INSTALL_OPERATION_ID_PATTERN.test(claim.operationId)
  ) {
    return { committed: false, action: 'unrecoverable' };
  }
  let rootAbs: string;
  try {
    rootAbs = resolveSkillInstallRootFor(worktreePath, SKILL_INSTALL_ROOT_PREFIX, skillId);
  } catch {
    return { committed: false, action: 'unrecoverable' };
  }
  const stagingRoot = getSkillInstallStagingRoot(worktreePath, SKILL_INSTALL_ROOT_PREFIX);
  const asideDir = path.join(stagingRoot, skillUpdateAsideNameFor(claim.operationId));
  const stagedDir = path.join(stagingRoot, skillUpdateStagingNameFor(claim.operationId));

  const matchesClaim = (bytes: Buffer): boolean => {
    const receipt = parseInstalledReceipt(bytes);
    if (receipt === null || receipt.skill_id !== skillId) return false;
    if (claim.toVersion !== null && receipt.version !== claim.toVersion) return false;
    return (
      claim.receiptDigest === null || digestMatches(computeSha256Hex(bytes), claim.receiptDigest)
    );
  };

  if (isDirectory(rootAbs)) {
    // The root is occupied: whichever version it holds, no restore is needed
    // and the operation's leftovers in the reserved namespace are collectable.
    let committed = false;
    try {
      committed = matchesClaim(readFileSync(path.join(rootAbs, SKILL_RECEIPT_FILENAME)));
    } catch {
      committed = false;
    }
    removeQuietly(asideDir);
    removeQuietly(stagedDir);
    pruneStagingRoot(stagingRoot);
    return { committed, action: committed ? 'committed' : 'rolled_back' };
  }

  // The root is empty: the crash hit between the aside and publish renames.
  // Restoring the old payload wins over adopting the new one — the journal
  // never recorded a commit for this shape, so the honest convergence is the
  // one that makes "nothing was committed" true again.
  if (isDirectory(asideDir)) {
    let asideReceipt: Buffer | null = null;
    try {
      asideReceipt = readFileSync(path.join(asideDir, SKILL_RECEIPT_FILENAME));
    } catch {
      asideReceipt = null;
    }
    const parsed = asideReceipt === null ? null : parseInstalledReceipt(asideReceipt);
    if (parsed !== null && parsed.skill_id === skillId) {
      try {
        renameSync(asideDir, rootAbs);
      } catch {
        return { committed: false, action: 'unrecoverable' };
      }
      removeQuietly(stagedDir);
      pruneStagingRoot(stagingRoot);
      return { committed: false, action: 'restored_old' };
    }
  }

  if (isDirectory(stagedDir)) {
    if (verifyStagedUpdatePayload(stagedDir, skillId, claim)) {
      try {
        renameSync(stagedDir, rootAbs);
      } catch {
        return { committed: false, action: 'unrecoverable' };
      }
      removeQuietly(asideDir);
      pruneStagingRoot(stagingRoot);
      return { committed: true, action: 'adopted_new' };
    }
    // A staging directory that does not prove itself is garbage, never payload.
    removeQuietly(stagedDir);
    pruneStagingRoot(stagingRoot);
  }

  return { committed: false, action: 'unrecoverable' };
}

/** Every staged byte must match the staged receipt, and the receipt the claim. */
function verifyStagedUpdatePayload(
  stagedDir: string,
  skillId: string,
  claim: SkillUpdateReconcileClaim
): boolean {
  let receiptBytes: Buffer;
  try {
    receiptBytes = readFileSync(path.join(stagedDir, SKILL_RECEIPT_FILENAME));
  } catch {
    return false;
  }
  const receipt = parseInstalledReceipt(receiptBytes);
  if (receipt === null || receipt.skill_id !== skillId) return false;
  if (claim.toVersion !== null && receipt.version !== claim.toVersion) return false;
  if (
    claim.receiptDigest !== null &&
    !digestMatches(computeSha256Hex(receiptBytes), claim.receiptDigest)
  ) {
    return false;
  }

  // The whole staged tree must be exactly the receipt's inventory plus the
  // receipt itself: extra files, missing files or drifted bytes all disqualify.
  const staged = readExistingSkillTree(stagedDir);
  if (!staged.present || staged.truncated || staged.irregularPaths.length > 0) return false;
  const expected = computeSkillTreeHash([
    ...receipt.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      executable: file.executable,
    })),
    {
      path: SKILL_RECEIPT_FILENAME,
      sha256: computeSha256Hex(receiptBytes),
      executable: false,
    },
  ]);
  return computeSkillTreeHash(staged.files) === expected;
}

/** What converging one worktree's secondary update roots produced. */
export interface SkillUpdateSecondaryConvergence {
  /** Repository-relative roots this call switched or filled to the new payload. */
  completed: string[];
  /** Roots left untouched because they are not provably clean managed installs. */
  skipped: string[];
}

/**
 * Converge a committed update's secondary roots forward from the primary (#1460).
 *
 * The update counterpart of {@link completeSecondarySkillInstallRoots}: after
 * the primary root committed, a secondary root may still hold the *previous*
 * version. A secondary that is a provably clean managed install (uninstall
 * guard, per-file digests) is switched with the same aside → publish sequence
 * apply uses; a root with any local finding is left alone and reported, so
 * convergence never overwrites what it cannot prove. Absent roots are filled
 * by the install-side converger. Idempotent.
 */
export function completeSecondarySkillUpdateRoots(
  worktreePath: string,
  worktreeRealPath: string,
  skillId: string
): SkillUpdateSecondaryConvergence {
  const primaryAbs = resolveUpdateTargetFor(worktreePath, SKILL_INSTALL_ROOT_PREFIX, skillId);
  const primaryReceiptBytes = readFileSync(path.join(primaryAbs, SKILL_RECEIPT_FILENAME));
  const primaryReceipt = parseInstalledReceipt(primaryReceiptBytes);
  if (primaryReceipt === null) {
    fail(SkillUpdateErrorCode.PAYLOAD_MISMATCH, { reason: 'primary-receipt-unreadable' });
  }
  const primaryDigest = computeSha256Hex(primaryReceiptBytes);

  // Read the primary payload from disk and prove it against the receipt before
  // it is copied anywhere: a copy of a tampered primary must not propagate.
  const payload: SkillPayloadFile[] = primaryReceipt.files.map((file) => {
    const bytes = readFileSync(path.join(primaryAbs, file.path));
    if (!digestMatches(computeSha256Hex(bytes), file.sha256)) {
      fail(SkillUpdateErrorCode.PAYLOAD_MISMATCH, { reason: 'primary-file-digest' });
    }
    return { relativePath: file.path, bytes, executable: file.executable };
  });
  const directories = directoriesForSkillPayload(primaryReceipt.files.map((file) => file.path));
  const plannedTreeHash = computeSkillTreeHash([
    ...primaryReceipt.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      executable: file.executable,
    })),
    { path: SKILL_RECEIPT_FILENAME, sha256: primaryDigest, executable: false },
  ]);

  const completed: string[] = [];
  const skipped: string[] = [];
  const convergeId = randomBytes(16).toString('hex');

  for (const rootRel of receiptInstallRoots(primaryReceipt)) {
    const prefix = rootPrefixOf(rootRel, skillId);
    if (prefix === SKILL_INSTALL_ROOT_PREFIX) continue;
    let abs: string;
    try {
      abs = resolveSkillInstallTargetFor(worktreePath, prefix, skillId);
    } catch {
      skipped.push(rootRel);
      continue;
    }
    // Absent roots are the install-side convergence below; only an occupied
    // root that still holds a different receipt is update's own case.
    if (!inspectSkillDestination(abs).present) continue;

    const assessment = assessSkillUninstall(abs, skillId, { rootPrefix: prefix });
    if (assessment.receiptDigest !== null && digestMatches(assessment.receiptDigest, primaryDigest)) {
      continue; // Already the new payload.
    }
    if (!assessment.removable) {
      skipped.push(rootRel);
      continue;
    }

    let stagedRoot: SkillStagedRootPayload;
    try {
      stagedRoot = stageSkillRootPayload({
        worktreePath,
        worktreeRealPath,
        rootPrefix: prefix,
        skillId,
        stagingName: skillUpdateStagingNameFor(convergeId),
        payload,
        directories,
        receiptBytes: primaryReceiptBytes,
        plannedTreeHash,
      });
    } catch {
      skipped.push(rootRel);
      continue;
    }
    const asideDir = path.join(stagedRoot.stagingRoot, skillUpdateAsideNameFor(convergeId));
    try {
      renameSync(abs, asideDir);
    } catch {
      removeQuietly(stagedRoot.stagingDir);
      pruneStagingRoot(stagedRoot.stagingRoot);
      skipped.push(rootRel);
      continue;
    }
    try {
      renameSync(stagedRoot.stagingDir, abs);
    } catch {
      try {
        renameSync(asideDir, abs);
      } catch {
        // The aside directory keeps the old payload adjacent to the root; the
        // next convergence pass retries from this exact shape.
      }
      removeQuietly(stagedRoot.stagingDir);
      pruneStagingRoot(stagedRoot.stagingRoot);
      skipped.push(rootRel);
      continue;
    }
    removeQuietly(asideDir);
    pruneStagingRoot(stagedRoot.stagingRoot);
    completed.push(rootRel);
  }

  const filled = completeSecondarySkillInstallRoots(worktreePath, worktreeRealPath, skillId);
  completed.push(...filled.completed);

  return { completed, skipped };
}
