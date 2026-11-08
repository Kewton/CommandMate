/**
 * What mem asks git (Issue #4221, design §9.3・§2.1). One module so the routes'
 * tests replace git in one place.
 *
 * @module lib/mem/git-observe
 */

import { execGitCommandCapture } from '@/lib/git/git-exec';
import { probeGitCommonDir } from '@/lib/git/git-common-dir';

/** The HEAD of a worktree and the git it belongs to. */
export interface WorktreeHeadObservation {
  /** null with `detached`, or when nothing could be read. */
  branch: string | null;
  detached: boolean;
  /** null on an unborn branch or a failure. */
  head: string | null;
  commonDir: string | null;
  /** false: git could not say which branch (or whether detached). */
  known: boolean;
}

export async function observeWorktreeHead(worktreePath: string): Promise<WorktreeHeadObservation> {
  const symbolic = await execGitCommandCapture(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktreePath);
  const head = await execGitCommandCapture(['rev-parse', '--verify', '--quiet', 'HEAD'], worktreePath);
  const probe = await probeGitCommonDir(worktreePath);
  const commonDir = probe.kind === 'repository' ? probe.commonDir : null;
  const sha = head.ok && /^[0-9a-f]{40}$/.test(head.stdout) ? head.stdout : null;
  if (symbolic.ok && symbolic.stdout.length > 0) {
    return { branch: symbolic.stdout, detached: false, head: sha, commonDir, known: true };
  }
  if (sha) return { branch: null, detached: true, head: sha, commonDir, known: true };
  return { branch: null, detached: false, head: null, commonDir, known: false };
}

/** The URL of `origin`, or null. */
export async function readOriginUrl(worktreePath: string): Promise<string | null> {
  const outcome = await execGitCommandCapture(['remote', 'get-url', 'origin'], worktreePath);
  return outcome.ok && outcome.stdout.length > 0 ? outcome.stdout.split('\n')[0] : null;
}

/** The commit a ref names, or null. */
export async function readRefTip(worktreePath: string, ref: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith('-')) return null;
  const outcome = await execGitCommandCapture(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], worktreePath);
  return outcome.ok && /^[0-9a-f]{40}$/.test(outcome.stdout) ? outcome.stdout : null;
}
