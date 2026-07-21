/**
 * Deleting exactly the files CommandMate wrote, and nothing else (Issue #1236)
 *
 * The delete half of the plan/apply pair, and the only module in the codebase
 * that removes Skill payload from a repository. #1235's install could rely on a
 * single atomic rename for its safety argument; deletion has no such primitive,
 * so the argument here is built from four rules instead:
 *
 * - **Zero-delete on ambiguity.** The whole install root is re-assessed before
 *   the first `unlink`. One modified, unknown, missing or irregular path and the
 *   operation stops having deleted nothing. There is no partial uninstall —
 *   "removed seven of eight files" is a corrupted Skill reported as a success.
 * - **The destination is derived, never received.** The install root comes from
 *   the server-resolved worktree path plus a Skill ID re-checked against
 *   {@link SKILL_ID_PATTERN}, using #1233's resolver — the same derivation
 *   install uses, because a delete that resolved its target differently from the
 *   write that created it would eventually resolve it somewhere else entirely.
 * - **Nothing is followed.** Every path component from the install root down is
 *   `lstat`ed immediately before the file it leads to is unlinked, so a symlink
 *   swapped in after the scan is refused rather than traversed. `unlink` itself
 *   never follows its final component, so the directory chain is the exposure.
 * - **Directories go only when empty.** `rmdir(2)` is used, never a recursive
 *   remove, and only on directories the receipt's own file list implies. An
 *   empty directory the user made is not ours to collect.
 *
 * The receipt is deleted **last**. Until it is gone the directory still explains
 * itself: a crash mid-delete leaves a worktree that #1234 reconciliation — and a
 * human reading `.commandmate-receipt.json` — can still make sense of.
 *
 * @module lib/skills/uninstall-apply
 */

import { lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'fs';
import path from 'path';
import {
  SKILL_ID_MAX_LENGTH,
  SKILL_ID_PATTERN,
  SKILL_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';
import { computeSha256Hex, digestMatches } from '@/lib/skills/integrity';
import {
  SKILL_RECEIPT_FILENAME,
  receiptInstallRoots,
} from '@/lib/skills/install-plan';
import { readExistingSkillTree, resolveSkillInstallRootFor } from '@/lib/skills/preview-diff';
import {
  assessSkillUninstall,
  type SkillUninstallAssessment,
  type SkillUninstallBlocker,
} from '@/lib/skills/uninstall-plan';

// =============================================================================
// Errors
// =============================================================================

/** Client-safe reasons an uninstall refused to delete or could not finish. */
export const SkillUninstallErrorCode = {
  /** The install root could not be derived safely from the worktree and Skill ID. */
  TARGET_UNSAFE: 'SKILL_UNINSTALL_TARGET_UNSAFE',
  /** An ancestor of the install root is a symlink or is not a directory. */
  ANCESTOR_UNSAFE: 'SKILL_UNINSTALL_ANCESTOR_UNSAFE',
  /** There is nothing to uninstall at the target. */
  NOT_INSTALLED: 'SKILL_UNINSTALL_NOT_INSTALLED',
  /** At least one path is not provably managed and unchanged. Nothing was deleted. */
  BLOCKED: 'SKILL_UNINSTALL_BLOCKED',
  /** The install root changed between the plan and this apply. Nothing was deleted. */
  DRIFT: 'SKILL_UNINSTALL_DRIFT',
  /** A file changed between the re-assessment and its own delete. */
  FILE_CHANGED: 'SKILL_UNINSTALL_FILE_CHANGED',
  /** A path or one of its ancestors is not what it was when it was scanned. */
  PATH_UNSAFE: 'SKILL_UNINSTALL_PATH_UNSAFE',
  /** The delete syscall itself failed. */
  DELETE_FAILED: 'SKILL_UNINSTALL_DELETE_FAILED',
} as const;

export type SkillUninstallErrorCodeType =
  (typeof SkillUninstallErrorCode)[keyof typeof SkillUninstallErrorCode];

/** HTTP status each reason maps to, so every caller answers alike. */
export const SKILL_UNINSTALL_ERROR_STATUS: Record<SkillUninstallErrorCodeType, number> = {
  [SkillUninstallErrorCode.TARGET_UNSAFE]: 400,
  [SkillUninstallErrorCode.ANCESTOR_UNSAFE]: 409,
  [SkillUninstallErrorCode.NOT_INSTALLED]: 404,
  [SkillUninstallErrorCode.BLOCKED]: 409,
  [SkillUninstallErrorCode.DRIFT]: 409,
  [SkillUninstallErrorCode.FILE_CHANGED]: 409,
  [SkillUninstallErrorCode.PATH_UNSAFE]: 409,
  [SkillUninstallErrorCode.DELETE_FAILED]: 500,
};

/** An uninstall rejection. The message is built from the code — never from a path. */
export class SkillUninstallError extends Error {
  constructor(
    readonly code: SkillUninstallErrorCodeType,
    readonly detail?: Record<string, string | number | boolean>,
    /** Repository-relative paths that blocked the operation, for UX-07. */
    readonly blockers: readonly SkillUninstallBlocker[] = []
  ) {
    super(`Skill uninstall rejected: ${code}`);
    this.name = 'SkillUninstallError';
  }

  get status(): number {
    return SKILL_UNINSTALL_ERROR_STATUS[this.code];
  }
}

export function isSkillUninstallError(value: unknown): value is SkillUninstallError {
  return value instanceof SkillUninstallError;
}

function fail(
  code: SkillUninstallErrorCodeType,
  detail?: Record<string, string | number | boolean>,
  blockers: readonly SkillUninstallBlocker[] = []
): never {
  throw new SkillUninstallError(code, detail, blockers);
}

// =============================================================================
// Path safety
// =============================================================================

/**
 * Absolute install root for a validated Skill ID inside a server-resolved worktree.
 *
 * Delegates to #1233's resolver — the same one {@link resolveSkillInstallTarget}
 * uses — and re-checks the ID grammar here as well, because `path.join`
 * normalizes `..` away and a containment check alone would accept an ID that
 * walked out of the Skills directory.
 */
export function resolveSkillUninstallTarget(worktreePath: string, skillId: string): string {
  return resolveSkillUninstallTargetFor(worktreePath, SKILL_INSTALL_ROOT_PREFIX, skillId);
}

/** Absolute install root for a Skill ID under one root prefix (#1460). */
export function resolveSkillUninstallTargetFor(
  worktreePath: string,
  rootPrefix: string,
  skillId: string
): string {
  if (!SKILL_ID_PATTERN.test(skillId) || skillId.length > SKILL_ID_MAX_LENGTH) {
    fail(SkillUninstallErrorCode.TARGET_UNSAFE, { reason: 'skill-id' });
  }
  try {
    return resolveSkillInstallRootFor(worktreePath, rootPrefix, skillId);
  } catch {
    return fail(SkillUninstallErrorCode.TARGET_UNSAFE, { reason: 'install-root' });
  }
}

/**
 * Prove no ancestor of the install root was swapped for a link.
 *
 * `lstat` at every level from the worktree down. `realpath` alone would silently
 * *follow* a swapped ancestor and delete under whatever it pointed at, which is
 * precisely the failure this whole module exists to make unrepresentable.
 */
export function assertSkillUninstallAncestors(
  worktreeRealPath: string,
  worktreePath: string,
  rootPrefix: string = SKILL_INSTALL_ROOT_PREFIX
): void {
  let resolved: string;
  try {
    resolved = realpathSync(worktreePath);
  } catch {
    return fail(SkillUninstallErrorCode.ANCESTOR_UNSAFE, { reason: 'worktree-unresolvable' });
  }
  if (resolved !== worktreeRealPath) {
    fail(SkillUninstallErrorCode.ANCESTOR_UNSAFE, { reason: 'worktree-identity' });
  }

  let walked = worktreeRealPath;
  for (const segment of rootPrefix.split('/')) {
    walked = path.join(walked, segment);
    let stats;
    try {
      stats = lstatSync(walked);
    } catch {
      // Absent is fine: there is then nothing under it to delete.
      return;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      fail(SkillUninstallErrorCode.ANCESTOR_UNSAFE, { reason: 'not-a-directory' });
    }
  }
}

/**
 * Reject a receipt-recorded path that is not a plain relative path.
 *
 * The receipt is a file inside a repository, so it is data the user could have
 * edited even though CommandMate wrote it. Its `files` entries name what gets
 * unlinked, and are therefore validated here rather than trusted.
 */
function assertSafeRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    fail(SkillUninstallErrorCode.PATH_UNSAFE, { reason: 'grammar' });
  }
  for (const segment of relativePath.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      fail(SkillUninstallErrorCode.PATH_UNSAFE, { reason: 'segment' });
    }
  }
}

/**
 * `lstat` every directory from the install root down to the file's parent.
 *
 * Run immediately before each `unlink`, not once per operation: the exclusive
 * lock keeps CommandMate out, but nothing stops the user's own tooling from
 * replacing a directory with a link while the deletes are running.
 */
function assertDirectoryChainIsReal(installRootAbs: string, relativePath: string): void {
  let walked = installRootAbs;
  const segments = relativePath.split('/').slice(0, -1);
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) walked = path.join(walked, segments[index - 1]);
    let stats;
    try {
      stats = lstatSync(walked);
    } catch {
      return fail(SkillUninstallErrorCode.PATH_UNSAFE, { reason: 'ancestor-missing' });
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      fail(SkillUninstallErrorCode.PATH_UNSAFE, { reason: 'ancestor-not-a-directory' });
    }
  }
}

// =============================================================================
// File removal
// =============================================================================

/** What the receipt says a file should be at the moment it is deleted. */
export interface SkillUninstallExpectedFile {
  sha256: string;
  executable: boolean;
}

/**
 * Delete one receipt-owned file, having just proved it is still that file.
 *
 * The digest is re-read here even though the assessment already checked it, for
 * the same reason install re-reads what it wrote: the assessment is evidence
 * about a moment that has passed, and the only claim worth making about a delete
 * is one established immediately before the syscall.
 *
 * @internal Exported for the guard tests; callers use {@link applySkillUninstall}.
 * @throws SkillUninstallError — the file was not deleted in every case.
 */
export function removeReceiptOwnedFile(
  installRootAbs: string,
  relativePath: string,
  expected: SkillUninstallExpectedFile
): number {
  assertSafeRelativePath(relativePath);
  assertDirectoryChainIsReal(installRootAbs, relativePath);

  const absolute = path.join(installRootAbs, relativePath);
  if (path.relative(installRootAbs, absolute) !== relativePath.split('/').join(path.sep)) {
    fail(SkillUninstallErrorCode.PATH_UNSAFE, { reason: 'containment' });
  }

  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    return fail(SkillUninstallErrorCode.FILE_CHANGED, { reason: 'vanished' });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail(SkillUninstallErrorCode.PATH_UNSAFE, { reason: 'not-a-regular-file' });
  }
  // A hard link means the same inode is reachable from somewhere we did not
  // scan, so the receipt cannot claim sole ownership of this content.
  if (stats.nlink !== 1) {
    fail(SkillUninstallErrorCode.PATH_UNSAFE, { reason: 'hard-linked' });
  }
  if (((stats.mode & 0o111) !== 0) !== expected.executable) {
    fail(SkillUninstallErrorCode.FILE_CHANGED, { reason: 'mode' });
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch {
    return fail(SkillUninstallErrorCode.FILE_CHANGED, { reason: 'unreadable' });
  }
  if (!digestMatches(computeSha256Hex(bytes), expected.sha256)) {
    fail(SkillUninstallErrorCode.FILE_CHANGED, { reason: 'digest' });
  }

  try {
    unlinkSync(absolute);
  } catch {
    return fail(SkillUninstallErrorCode.DELETE_FAILED, { reason: 'unlink' });
  }
  return bytes.byteLength;
}

/**
 * Remove a directory only if it is empty.
 *
 * `rmdir(2)` refuses a non-empty directory, so the emptiness check and the
 * removal are one indivisible step rather than a scan followed by a delete that
 * could act on a directory something was written into meanwhile.
 *
 * @returns whether the directory was removed
 */
function removeIfEmpty(directoryAbs: string): boolean {
  let stats;
  try {
    stats = lstatSync(directoryAbs);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  try {
    rmdirSync(directoryAbs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories the receipt's file list implies, deepest first.
 *
 * Derived from the receipt rather than from a directory walk on purpose: an
 * empty directory the user created inside the install root is not something the
 * install put there, and collecting it would be a deletion nobody asked for.
 */
function directoriesImpliedByReceipt(relativePaths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const relative of relativePaths) {
    const segments = relative.split('/').slice(0, -1);
    let walked = '';
    for (const segment of segments) {
      walked = walked === '' ? segment : `${walked}/${segment}`;
      directories.add(walked);
    }
  }
  return [...directories].sort(
    (a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1)
  );
}

// =============================================================================
// Apply
// =============================================================================

/** Everything the delete needs. All of it server-resolved or plan-fixed. */
export interface SkillUninstallApplyInput {
  /** Absolute path from the worktree row. Never client-supplied. */
  worktreePath: string;
  /** Symlink-free form of {@link worktreePath}, resolved before the lock was taken. */
  worktreeRealPath: string;
  skillId: string;
  /** Digest of the receipt bytes the plan was built against. */
  expectedReceiptDigest: string;
  /** Tree hash the plan recorded for the install root. */
  expectedTreeHash: string;
  /**
   * Called once, after every check has passed and before the first `unlink`.
   *
   * This is the uninstall's commit point. Unlike install there is no single
   * atomic syscall to hang it on, so the caller records it here and treats any
   * later failure as reconcilable rather than as an untouched worktree.
   */
  onCommitPoint?: () => void;
}

/** One file that was deleted. Paths are repository-relative. */
export interface SkillUninstallRemovedFile {
  path: string;
  sha256: string;
  size: number;
}

/** Something that is still on disk, and why. */
export interface SkillUninstallRetainedPath {
  path: string;
  reason: string;
  messageKey: string;
}

/** What the delete produced. */
export interface SkillUninstallApplyResult {
  /** Primary repository-relative install root (`.agents/skills/<id>`). */
  installRoot: string;
  /** Every recorded root the uninstall acted on, primary first (#1460). */
  installRoots: string[];
  version: string;
  removedFiles: SkillUninstallRemovedFile[];
  /** Repository-relative directories removed because they became empty. */
  removedDirectories: string[];
  /** Directories that could not be collected, so the user knows what is left. */
  retained: SkillUninstallRetainedPath[];
  receiptRemoved: boolean;
  /** Every recorded root's install directory is gone. */
  fullyRemoved: boolean;
}

/**
 * Verify and delete one Skill install.
 *
 * Everything before {@link SkillUninstallApplyInput.onCommitPoint} is a read:
 * on any rejection the worktree is byte-for-byte what it was. After it, files
 * are gone and a failure is reported as *committed, reconciling* — the receipt
 * survives until last precisely so that state remains explainable.
 *
 * @throws SkillUninstallError
 */
export function applySkillUninstall(
  input: SkillUninstallApplyInput
): SkillUninstallApplyResult {
  // The primary root anchors the plan: its receipt names every root, and its
  // tree hash and receipt digest are what the plan bound the token to.
  const primaryAbs = resolveSkillUninstallTarget(input.worktreePath, input.skillId);
  assertSkillUninstallAncestors(input.worktreeRealPath, input.worktreePath);

  const primary: SkillUninstallAssessment = assessSkillUninstall(primaryAbs, input.skillId, {
    existing: readExistingSkillTree(primaryAbs),
  });
  if (!primary.present) {
    fail(SkillUninstallErrorCode.NOT_INSTALLED, undefined, primary.blockers);
  }
  if (!primary.removable || primary.receipt === null) {
    fail(SkillUninstallErrorCode.BLOCKED, undefined, primary.blockers);
  }
  if (primary.currentTreeHash !== input.expectedTreeHash) {
    fail(SkillUninstallErrorCode.DRIFT, { reason: 'tree-hash' });
  }
  const receipt = primary.receipt;
  const receiptDigest = primary.receiptDigest;
  if (receiptDigest === null || !digestMatches(receiptDigest, input.expectedReceiptDigest)) {
    fail(SkillUninstallErrorCode.DRIFT, { reason: 'receipt-digest' });
  }

  // Resolve and assess every recorded root before deleting anything (#1460). An
  // absent root is already gone and skipped; any present root that is not
  // provably managed-and-unchanged blocks the whole operation, so "zero-delete
  // on ambiguity" holds across roots, not just within one.
  const installRoots = receiptInstallRoots(receipt);
  const planned: Array<{ abs: string; assessment: SkillUninstallAssessment }> = [];
  for (const rootRel of installRoots) {
    const rootPrefix = rootRel.slice(0, Math.max(0, rootRel.length - input.skillId.length - 1));
    const abs =
      rootPrefix === SKILL_INSTALL_ROOT_PREFIX
        ? primaryAbs
        : resolveSkillUninstallTargetFor(input.worktreePath, rootPrefix, input.skillId);
    assertSkillUninstallAncestors(input.worktreeRealPath, input.worktreePath, rootPrefix);
    const assessment =
      rootPrefix === SKILL_INSTALL_ROOT_PREFIX
        ? primary
        : assessSkillUninstall(abs, input.skillId, {
            existing: readExistingSkillTree(abs),
            rootPrefix,
          });
    // A recorded root already removed is not an error: convergence may have
    // deleted it, or a legacy single-root receipt never wrote it.
    if (!assessment.present) continue;
    if (!assessment.removable || assessment.receipt === null) {
      fail(SkillUninstallErrorCode.BLOCKED, undefined, assessment.blockers);
    }
    // Every root holds the byte-identical payload, so each must match the same
    // tree hash and receipt digest the plan bound; anything else is drift.
    if (assessment.currentTreeHash !== input.expectedTreeHash) {
      fail(SkillUninstallErrorCode.DRIFT, { reason: 'tree-hash' });
    }
    if (
      assessment.receiptDigest === null ||
      !digestMatches(assessment.receiptDigest, input.expectedReceiptDigest)
    ) {
      fail(SkillUninstallErrorCode.DRIFT, { reason: 'receipt-digest' });
    }
    planned.push({ abs, assessment });
  }

  input.onCommitPoint?.();

  const removedFiles: SkillUninstallRemovedFile[] = [];
  const removedDirectories: string[] = [];
  const retained: SkillUninstallRetainedPath[] = [];
  let allFullyRemoved = true;
  let primaryReceiptRemoved = false;

  for (const { abs, assessment } of planned) {
    const removed = deleteSkillInstallRoot(abs, assessment, receiptDigest);
    removedFiles.push(...removed.removedFiles);
    removedDirectories.push(...removed.removedDirectories);
    retained.push(...removed.retained);
    if (!removed.fullyRemoved) allFullyRemoved = false;
    if (abs === primaryAbs) primaryReceiptRemoved = removed.receiptRemoved;
  }

  return {
    installRoot: primary.installRoot,
    installRoots,
    version: receipt.version,
    removedFiles,
    removedDirectories,
    retained,
    receiptRemoved: primaryReceiptRemoved,
    fullyRemoved: allFullyRemoved,
  };
}

/** Delete every managed file in one root, receipt last. All checks already passed. */
function deleteSkillInstallRoot(
  installRootAbs: string,
  assessment: SkillUninstallAssessment,
  receiptDigest: string
): {
  removedFiles: SkillUninstallRemovedFile[];
  removedDirectories: string[];
  retained: SkillUninstallRetainedPath[];
  receiptRemoved: boolean;
  fullyRemoved: boolean;
} {
  const payload = assessment.entries.filter(
    (entry) => entry.disposition === 'remove' && !entry.generated
  );

  const removedFiles: SkillUninstallRemovedFile[] = [];
  for (const entry of payload) {
    const size = removeReceiptOwnedFile(installRootAbs, entry.relativePath, {
      sha256: entry.recordedSha256 as string,
      executable: entry.executable,
    });
    removedFiles.push({ path: entry.path, sha256: entry.recordedSha256 as string, size });
  }

  const removedDirectories: string[] = [];
  for (const relative of directoriesImpliedByReceipt(payload.map((entry) => entry.relativePath))) {
    if (removeIfEmpty(path.join(installRootAbs, relative))) {
      removedDirectories.push(`${assessment.installRoot}/${relative}`);
    }
  }

  // Last, so that up to this point the directory still says what it is.
  const receiptEntry = assessment.entries.find((entry) => entry.generated);
  if (receiptEntry) {
    const size = removeReceiptOwnedFile(installRootAbs, SKILL_RECEIPT_FILENAME, {
      sha256: receiptDigest,
      executable: false,
    });
    removedFiles.push({
      path: `${assessment.installRoot}/${SKILL_RECEIPT_FILENAME}`,
      sha256: receiptDigest,
      size,
    });
  }

  const fullyRemoved = removeIfEmpty(installRootAbs);
  const retained = fullyRemoved ? [] : listRetainedPaths(installRootAbs, assessment.installRoot);

  return {
    removedFiles,
    removedDirectories,
    retained,
    receiptRemoved: receiptEntry !== undefined,
    fullyRemoved,
  };
}

/**
 * Name what is still inside the install root.
 *
 * Only reached when the root would not collect, which after a fail-closed
 * assessment means something appeared during the delete. The user is told the
 * paths rather than that "uninstall partially failed" (UX-07).
 */
function listRetainedPaths(installRootAbs: string, installRoot: string): SkillUninstallRetainedPath[] {
  let entries: string[];
  try {
    entries = readdirSync(installRootAbs);
  } catch {
    return [];
  }
  return entries.map((name) => ({
    path: `${installRoot}/${name}`,
    reason: 'SKILL_UNINSTALL_UNMANAGED_FILE',
    messageKey: 'skills.uninstall.reason.unmanagedFile',
  }));
}

/**
 * Whether the payload a committed uninstall removed is really gone.
 *
 * The uninstall counterpart of `hasCommittedSkillPayload`: #1234's reconciler
 * asks whether the filesystem side of an operation landed, and for a delete
 * that means the receipt no longer names this install.
 */
export function hasRemovedSkillPayload(
  worktreePath: string,
  skillId: string,
  receiptDigest: string | null
): boolean {
  let installRootAbs: string;
  try {
    installRootAbs = resolveSkillUninstallTarget(worktreePath, skillId);
  } catch {
    return true;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path.join(installRootAbs, SKILL_RECEIPT_FILENAME));
  } catch {
    return true;
  }
  return receiptDigest !== null && !digestMatches(computeSha256Hex(bytes), receiptDigest);
}
