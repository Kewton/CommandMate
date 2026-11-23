/**
 * Where a promote writes, normalized, and the content it was made against (Issue
 * #4225, design §2.2・§5.3).
 *
 * - An Issue / PR comment: `issue:[host/owner/repo]#N` or `pr:…#N` (A's grammar). With
 *   no target, the repository's `origin` names it (as B resolves `#N`). The host must
 *   pass B's allow-list (`github.com` or the `origin`'s host).
 * - A document of a worktree: `path:<rel>`. A's check runs again at the chosen
 *   worktree's root, and E adds its own: the root is no symlink, no `.git`, an
 *   existing last component is a regular file, `.md`, at most 1 MiB, and the parent
 *   directory exists (nothing is made on the way). An agent's instruction file
 *   ({@link AGENT_INSTRUCTION_PATHS}) is refused: a decision an agent wrote is data, never
 *   an instruction to the agents after it (Epic #4220 D12). The disk-free part (`.git`, the
 *   instruction files, `.md`) is the write's own check (`checkPromoteToPath`, Issue #4354): a
 *   destination `mem add` accepted is one this accepts, unless the disk changed.
 *
 * Synchronous reads of `fs` only; nothing here writes.
 *
 * @module lib/promote/destination
 */

import { createHash } from 'crypto';
import { lstatSync, readFileSync } from 'fs';
import path from 'path';
import { hostAllowed } from '@/lib/mem/github-query';
import { checkPromoteToPath } from '@/lib/mem/validate';
import type { CloseWhenTarget } from '@/lib/mem/close-when';
import { PROMOTE_DOC_MAX_BYTES } from './model';
export { AGENT_INSTRUCTION_PATHS, agentInstructionPathOf } from './promote-to-rule';
import { sha256 } from './render';

const ISSUE = /^(issue|pr):(?:([A-Za-z0-9.-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+))?#([1-9][0-9]{0,9})$/;

export type ParsedPromoteTo =
  | { kind: 'issue'; ref: 'issue' | 'pr'; target: CloseWhenTarget | null; number: number }
  | { kind: 'path'; path: string };

export function parsePromoteTo(raw: string | null): ParsedPromoteTo | null {
  if (raw === null) return null;
  const issue = ISSUE.exec(raw);
  if (issue) {
    return {
      kind: 'issue',
      ref: issue[1] as 'issue' | 'pr',
      target: issue[2] ? { host: issue[2], owner: issue[3], repo: issue[4] } : null,
      number: Number(issue[5]),
    };
  }
  if (raw.startsWith('path:') && raw.length > 'path:'.length) return { kind: 'path', path: raw.slice('path:'.length) };
  return null;
}

/** The comment's destination, or null when the host is not allowed or there is no target. */
export function resolveIssueTarget(
  parsed: Extract<ParsedPromoteTo, { kind: 'issue' }>,
  origin: CloseWhenTarget | null
): { host: string; owner: string; repo: string } | null {
  const target = parsed.target ?? origin;
  if (!target) return null;
  if (!hostAllowed(target.host, origin?.host ?? null)) return null;
  return { host: target.host.toLowerCase(), owner: target.owner, repo: target.repo };
}

export type DocPathCheck =
  | { ok: true; rel: string; abs: string; exists: boolean }
  | { ok: false; code: 'absolute_path' | 'outside_repository' | 'symlink' | 'sensitive_path' | 'agent_instructions' | 'invalid_destination' };

/** §5.3, at `root`. Asked at the preview, at the approval and right before the write. */
export function checkDocPath(root: string, raw: string): DocPathCheck {
  // The root itself is no symlink (its ancestors are the user's layout, e.g. macOS's /var → /private/var).
  let rootIsReal = false;
  try {
    const stat = lstatSync(root);
    rootIsReal = stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    rootIsReal = false;
  }
  if (!rootIsReal) return { ok: false, code: 'symlink' };
  // Issue #4354 I-B1: the same check as the write's (`validatePromoteTo`), then the disk's.
  const checked = checkPromoteToPath(raw, root);
  if (!checked.ok) {
    const { code, reason } = checked.error;
    if (code === 'absolute_path' || code === 'outside_repository' || code === 'symlink' || code === 'sensitive_path') return { ok: false, code };
    if (reason === 'git_dir') return { ok: false, code: 'sensitive_path' };
    if (reason === 'agent_instructions') return { ok: false, code: 'agent_instructions' };
    return { ok: false, code: 'invalid_destination' };
  }
  const rel = checked.value;
  const segments = rel.split('/');
  const abs = path.join(root, ...segments);
  // Every directory on the way must exist and be a real directory (nothing is made).
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return { ok: false, code: 'symlink' };
      if (!stat.isDirectory()) return { ok: false, code: 'invalid_destination' };
    } catch {
      return { ok: false, code: 'invalid_destination' };
    }
  }
  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) return { ok: false, code: 'symlink' };
    if (!stat.isFile() || stat.size > PROMOTE_DOC_MAX_BYTES) return { ok: false, code: 'invalid_destination' };
    return { ok: true, rel, abs, exists: true };
  } catch {
    return { ok: true, rel, abs, exists: false };
  }
}

/** The document's content as the base of a diff: its SHA-256 and size, or `absent`. */
export function docBaseFingerprint(abs: string): string {
  try {
    const content = readFileSync(abs);
    return `sha256:${createHash('sha256').update(content).digest('hex')}:${content.length}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    return 'unreadable';
  }
}

/** What an Issue's base is (design §2.2): which Issue it is, whether it is open and unlocked, its body. */
export function issueBaseFingerprint(json: unknown): string | null {
  const issue = json as { node_id?: unknown; repository_url?: unknown; state?: unknown; locked?: unknown; body?: unknown } | null;
  if (!issue || typeof issue.node_id !== 'string' || typeof issue.repository_url !== 'string') return null;
  return sha256(
    JSON.stringify([issue.node_id, issue.repository_url, issue.state ?? null, issue.locked ?? null, sha256(String(issue.body ?? ''))])
  );
}
