/**
 * When a recorded Skill operation may still be replayed (Issue #1552)
 *
 * The journal answers a retried request from its recorded outcome instead of
 * doing the work twice (#1234). That is only honest while the outcome is still
 * true of the worktree. The idempotency key a client does not supply is derived
 * from the binding — actor, operation, target and plan hash — and every one of
 * those inputs is back to its original value after an uninstall, so the *next*
 * install of the same version derives the *same* key as the first one. Without a
 * precondition it is answered from the old entry: exit 0, "Installed …", and not
 * one byte on disk. The mirror case (install → uninstall → install → uninstall)
 * leaves the payload in place while reporting it removed.
 *
 * The precondition is the receipt at the primary install root, which is the
 * marker both sides already agree on: install writes it inside the atomic
 * rename, and uninstall deletes it last. An entry that never claimed a
 * filesystem commit is left alone — it is answered as in-progress or failed, and
 * has no on-disk claim to check.
 *
 * @module lib/skills/operation-replay
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { SKILL_RECEIPT_FILENAME } from '@/lib/skills/install-plan';
import { resolveSkillInstallRoot } from '@/lib/skills/preview-diff';
import {
  hasSkillFilesystemCommit,
  type SkillOperationJournalEntry,
} from '@/lib/skills/operation-journal';

/**
 * SHA-256 of the receipt at the primary install root, or null when there is
 * none to read.
 *
 * Null is the answer for every way the receipt can fail to be there — absent,
 * a directory, unreadable, or under a Skill ID that does not resolve to a root
 * inside the worktree — because all of them mean the same thing here: nothing
 * on disk backs a claim that this Skill is installed.
 */
export function readInstalledSkillReceiptDigest(
  worktreePath: string,
  skillId: string
): string | null {
  try {
    const bytes = readFileSync(
      join(resolveSkillInstallRoot(worktreePath, skillId), SKILL_RECEIPT_FILENAME)
    );
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Whether a recorded install may still be replayed.
 *
 * A committed install claims a specific receipt is on disk. The claim is
 * re-checked against the receipt's digest rather than its mere existence, so a
 * replay is only served when the bytes the entry recorded are the bytes that are
 * there. An entry from before receipt digests were recorded falls back to
 * existence, which is the strongest statement it supports.
 */
export function mayReplaySkillInstall(
  entry: SkillOperationJournalEntry,
  worktreePath: string,
  skillId: string
): boolean {
  if (!hasSkillFilesystemCommit(entry)) return true;
  const digest = readInstalledSkillReceiptDigest(worktreePath, skillId);
  if (digest === null) return false;
  return entry.receiptDigest === null || entry.receiptDigest === digest;
}

/**
 * Whether a recorded uninstall may still be replayed.
 *
 * The mirror of {@link mayReplaySkillInstall}: a committed uninstall claims the
 * receipt is gone, so a receipt that is back on disk means the claim describes
 * some earlier state of the worktree and not this one.
 */
export function mayReplaySkillUninstall(
  entry: SkillOperationJournalEntry,
  worktreePath: string,
  skillId: string
): boolean {
  if (!hasSkillFilesystemCommit(entry)) return true;
  return readInstalledSkillReceiptDigest(worktreePath, skillId) === null;
}

/**
 * Whether a recorded update may still be replayed (Issue #1244).
 *
 * A committed update claims the *new* receipt is at the primary install root —
 * the update always records its receipt digest at the commit point, so this is
 * a digest comparison, never mere existence: an old receipt that is back in
 * place (a later rollback, an uninstall + reinstall of the previous version)
 * means the recorded outcome no longer describes the worktree and the request
 * is new work.
 */
export function mayReplaySkillUpdate(
  entry: SkillOperationJournalEntry,
  worktreePath: string,
  skillId: string
): boolean {
  if (!hasSkillFilesystemCommit(entry)) return true;
  const digest = readInstalledSkillReceiptDigest(worktreePath, skillId);
  if (digest === null) return false;
  return entry.receiptDigest === null || entry.receiptDigest === digest;
}
