/**
 * The one rule of a `promote_to` document path that does not depend on the disk (Issue #4354,
 * design `docs/design/mem-approval-4354.md`, the PR1a scope added on 2026-11-21).
 *
 * A destination that a write accepted must also be one the preview, the approval and the write
 * itself accept (I-B1). The disk-free part of that rule lives here, once:
 *
 * - no `.git` component (any case);
 * - no agent's instruction file ({@link AGENT_INSTRUCTION_PATHS}, any case);
 * - the last component ends in `.md` (any case).
 *
 * `validatePromoteTo` (`mem add`, the screen's add, a handoff proposal) and `checkDocPath`
 * (the preview, the approval, right before `writeDocBlock`) both reach it through
 * `checkPromoteToPath` (`lib/mem/validate.ts`), which first normalizes the path; what each step
 * reads from the disk (a symlink, a parent that exists, the size) is asked again at each step,
 * since the disk changes between them.
 *
 * Pure: no `fs`, no path aliases (the CLI build reads it too). `presentMemItem` reads a stored row with it to say why its
 * destination cannot be used (I-B3), without touching the disk.
 *
 * @module lib/promote/promote-to-rule
 */

import type { MemPromoteToRefusal } from '../../types/mem';

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

/**
 * Why a normalized relative path cannot be a promote destination, or null.
 *
 * - `git_dir`: a component is `.git`
 * - `agent_instructions`: an agent reads it as its instructions (Epic #4220 D12)
 * - `not_markdown`: the last component is not a `.md`
 */
export type PromoteToPathRefusal = MemPromoteToRefusal;

export const PROMOTE_TO_PATH_REFUSALS: readonly PromoteToPathRefusal[] = ['git_dir', 'agent_instructions', 'not_markdown'];

export function promoteToPathRule(rel: string): PromoteToPathRefusal | null {
  const segments = rel.split('/');
  if (segments.some((segment) => segment.toLowerCase() === '.git')) return 'git_dir';
  if (agentInstructionPathOf(rel)) return 'agent_instructions';
  const last = segments[segments.length - 1] ?? '';
  if (!last.toLowerCase().endsWith('.md') || last.length <= '.md'.length) return 'not_markdown';
  return null;
}

/**
 * The refusal of a stored `promote_to` value, read without the disk: a `path:` whose path breaks
 * {@link promoteToPathRule}. null for an Issue / PR, for no destination, and for a value this rule
 * does not judge (its grammar is `validatePromoteTo`'s).
 */
export function storedPromoteToRefusal(promoteTo: string | null): PromoteToPathRefusal | null {
  if (promoteTo === null || !promoteTo.startsWith('path:')) return null;
  const rel = promoteTo.slice('path:'.length).replace(/^(?:\.\/)+/, '');
  if (rel.length === 0) return null;
  return promoteToPathRule(rel);
}
