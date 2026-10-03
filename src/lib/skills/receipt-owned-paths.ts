/**
 * Files CommandMate itself placed into a worktree by installing a Skill (Issue #3092)
 *
 * `skill install` leaves `.agents/skills/<id>/…` and `.claude/skills/<id>/…`
 * untracked. Counted as change, those files made `work-evidence` pass on a
 * worktree nobody had worked in (`uncommitted=74`), and made a contract's
 * `requireScopeClean` fail on a worktree whose agent stayed inside `allow`.
 *
 * The answer is the receipt, and only the receipt. A path is reported as
 * CommandMate-owned when **all** of the following hold, so that nothing the
 * user or the agent wrote can be laundered through it into a false "no work":
 *
 *  - a receipt parses at `.agents/skills/<id>/.commandmate-receipt.json`, and
 *    its `skill_id` is that directory's name;
 *  - the root it names is `<known install prefix>/<skill_id>` — a receipt
 *    claiming `src` or `.commandcode` as a root claims nothing;
 *  - the file is listed in the receipt's `files`, is a regular file, and its
 *    bytes still hash to the recorded `sha256`. A Skill file the agent edited
 *    is the agent's change and stays counted;
 *  - for the receipt itself in a secondary root: byte-identical to the
 *    primary's.
 *
 * Callers apply the result to **untracked** entries only. A committed or
 * tracked-and-modified Skill file is history the branch carries, and judging
 * it is unchanged by this module.
 *
 * @module lib/skills/receipt-owned-paths
 */

import { createHash } from 'crypto';
import { lstatSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import {
  SKILL_ID_MAX_LENGTH,
  SKILL_ID_PATTERN,
  SKILL_INSTALL_ROOT_PREFIXES,
  SKILL_PRIMARY_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';
import {
  parseInstalledReceipt,
  receiptInstallRoots,
  SKILL_RECEIPT_FILENAME,
} from '@/lib/skills/install-plan';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Read a regular file (never through a link), or null. */
function readRegularFile(absolute: string): Buffer | null {
  try {
    if (!lstatSync(absolute).isFile()) return null;
    return readFileSync(absolute);
  } catch {
    return null;
  }
}

/** A receipt-relative payload path that cannot leave its root. */
function isSafeRelativePath(relative: string): boolean {
  if (relative === '' || relative.startsWith('/') || relative.includes('\\')) return false;
  return relative.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isValidSkillId(skillId: string): boolean {
  return SKILL_ID_PATTERN.test(skillId) && skillId.length <= SKILL_ID_MAX_LENGTH;
}

/**
 * Repository-relative POSIX paths of every untouched file a recorded Skill
 * install placed in this worktree, receipts included.
 *
 * Never throws: an unreadable directory or receipt contributes nothing, which
 * leaves those files counted exactly as before #3092.
 */
export function collectSkillReceiptOwnedPaths(worktreePath: string): Set<string> {
  const owned = new Set<string>();
  const primaryAbs = path.join(worktreePath, SKILL_PRIMARY_INSTALL_ROOT_PREFIX);

  let skillDirs: string[];
  try {
    skillDirs = readdirSync(primaryAbs);
  } catch {
    return owned;
  }

  for (const skillId of skillDirs) {
    if (!isValidSkillId(skillId)) continue;
    const primaryRoot = `${SKILL_PRIMARY_INSTALL_ROOT_PREFIX}/${skillId}`;
    const receiptBytes = readRegularFile(
      path.join(worktreePath, primaryRoot, SKILL_RECEIPT_FILENAME)
    );
    if (receiptBytes === null) continue;
    const receipt = parseInstalledReceipt(receiptBytes);
    if (receipt === null || receipt.skill_id !== skillId) continue;

    const allowedRoots = new Set(
      SKILL_INSTALL_ROOT_PREFIXES.map((prefix) => `${prefix}/${skillId}`)
    );
    const roots = receiptInstallRoots(receipt);
    // The receipt that names the roots must live in the primary one.
    if (roots[0] !== primaryRoot) continue;

    for (const root of roots) {
      if (typeof root !== 'string' || !allowedRoots.has(root)) continue;

      const rootReceipt = readRegularFile(path.join(worktreePath, root, SKILL_RECEIPT_FILENAME));
      if (rootReceipt !== null && rootReceipt.equals(receiptBytes)) {
        owned.add(`${root}/${SKILL_RECEIPT_FILENAME}`);
      }

      for (const file of receipt.files) {
        if (
          !file ||
          typeof file.path !== 'string' ||
          typeof file.sha256 !== 'string' ||
          !isSafeRelativePath(file.path) ||
          file.path === SKILL_RECEIPT_FILENAME
        ) {
          continue;
        }
        const bytes = readRegularFile(path.join(worktreePath, root, file.path));
        if (bytes !== null && sha256Hex(bytes) === file.sha256.toLowerCase()) {
          owned.add(`${root}/${file.path}`);
        }
      }
    }
  }

  return owned;
}
