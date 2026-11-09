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
 *   an instruction to the agents after it (Epic #4220 D12).
 *
 * Synchronous reads of `fs` only; nothing here writes.
 *
 * @module lib/promote/destination
 */

import { createHash } from 'crypto';
import { lstatSync, readFileSync } from 'fs';
import path from 'path';
import { hostAllowed } from '@/lib/mem/github-query';
import { normalizeRepoPath } from '@/lib/mem/validate';
import type { CloseWhenTarget } from '@/lib/mem/close-when';
import { PROMOTE_DOC_MAX_BYTES } from './model';
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

/**
 * The files an agent CLI reads as its instructions (PM review P3-8, D12). A document of
 * a worktree under one of them is refused as a destination, compared without case (a
 * case-insensitive file system names the same file either way).
 *
 * - `dir`: any path component (nested ones too: an agent reads `.claude/` below the root)
 * - `file`: the last component, in any directory (nested `CLAUDE.md` / `AGENTS.md` are read)
 * - `path`: the whole relative path
 *
 * Every project Skill root an agent was measured to discover (the probe roots of
 * `docs/reference/skill-agent-compatibility.md` and the `discoveryRoots` of
 * `lib/skills/compatibility-matrix.ts`) must fall under a row: a test reads those sources,
 * so a root added there fails until it is refused here (Codex review 5 P2-1).
 */
export const AGENT_INSTRUCTION_PATHS: ReadonlyArray<{ match: 'dir' | 'file' | 'path'; name: string; reader: string }> = [
  { match: 'dir', name: '.claude', reader: 'Claude Code (commands, agents, skills, settings)' },
  { match: 'dir', name: '.agents', reader: 'skills shared by Codex and others' },
  { match: 'dir', name: '.codex', reader: 'Codex' },
  { match: 'dir', name: '.gemini', reader: 'Gemini CLI' },
  { match: 'dir', name: '.agent', reader: 'Antigravity (rules, workflows)' },
  { match: 'dir', name: '.cursor', reader: 'Cursor (rules)' },
  { match: 'dir', name: '.windsurf', reader: 'Windsurf (rules)' },
  { match: 'dir', name: '.clinerules', reader: 'Cline' },
  { match: 'dir', name: '.commandcode', reader: 'Command Code (skills)' },
  { match: 'dir', name: '.opencode', reader: 'OpenCode' },
  { match: 'file', name: 'CLAUDE.md', reader: 'Claude Code' },
  { match: 'file', name: 'CLAUDE.local.md', reader: 'Claude Code' },
  { match: 'file', name: 'AGENTS.md', reader: 'Codex, OpenCode, Copilot and others' },
  { match: 'file', name: 'AGENTS.override.md', reader: 'Codex' },
  { match: 'file', name: 'GEMINI.md', reader: 'Gemini CLI' },
  { match: 'file', name: 'CMATE.md', reader: 'CommandMate (Schedules)' },
  { match: 'path', name: '.github/copilot-instructions.md', reader: 'GitHub Copilot' },
  { match: 'path', name: '.github/instructions', reader: 'GitHub Copilot (path-specific instructions)' },
  { match: 'path', name: '.github/prompts', reader: 'GitHub Copilot (prompt files)' },
  { match: 'path', name: '.github/chatmodes', reader: 'GitHub Copilot (chat modes)' },
  { match: 'path', name: '.github/skills', reader: 'GitHub Copilot (skills)' },
  { match: 'path', name: '.config/opencode', reader: 'OpenCode (its global config root, named among the measured Skill roots)' },
];

/** The row of {@link AGENT_INSTRUCTION_PATHS} a normalized relative path falls under, or null. */
export function agentInstructionPathOf(rel: string): (typeof AGENT_INSTRUCTION_PATHS)[number] | null {
  const lower = rel.toLowerCase();
  const segments = lower.split('/');
  for (const entry of AGENT_INSTRUCTION_PATHS) {
    const name = entry.name.toLowerCase();
    if (entry.match === 'dir' && segments.slice(0, -1).includes(name)) return entry;
    if (entry.match === 'file' && segments[segments.length - 1] === name) return entry;
    if (entry.match === 'path' && (lower === name || lower.startsWith(`${name}/`))) return entry;
  }
  return null;
}

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
  const checked = normalizeRepoPath(raw, root, 'promoteTo', false);
  if (!checked.ok) {
    const code = checked.error.code;
    if (code === 'absolute_path' || code === 'outside_repository' || code === 'symlink' || code === 'sensitive_path') return { ok: false, code };
    return { ok: false, code: 'invalid_destination' };
  }
  const rel = checked.value;
  const segments = rel.split('/');
  if (segments.some((segment) => segment.toLowerCase() === '.git')) return { ok: false, code: 'sensitive_path' };
  if (agentInstructionPathOf(rel)) return { ok: false, code: 'agent_instructions' };
  if (path.posix.extname(rel).toLowerCase() !== '.md') return { ok: false, code: 'invalid_destination' };
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
