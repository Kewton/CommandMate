/**
 * Git "Ask AI" prompt templates (Issue #817, localized by #1307).
 *
 * Single source of truth for the prompts that the GitPane "Ask AI" buttons
 * pre-populate into the active CLI tab's MessageInput composer (no auto-send —
 * the user reviews / edits before sending). Because the draft is the user's own
 * outgoing message, it is localized: an English user gets an English draft.
 *
 * The wording lives in `worktree.git.aiPrompts.*`; these builders only pick the
 * key and supply the context values, so they stay pure (no React / DOM) and
 * unit-testable against a real translator.
 */

import type { GitResetMode } from '@/types/git';

/**
 * Minimal structural type for a next-intl translator bound to the `worktree`
 * namespace. Declared here rather than imported so these stay plain functions:
 * callers pass the `t` they already hold.
 */
export type GitPromptTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string;

/** Context for the force-push Ask AI prompt. */
export interface ForcePushPromptInput {
  /** Current local branch (null when unknown / detached HEAD). */
  branch: string | null;
  /** Commits ahead of upstream (null when unknown / no upstream). */
  ahead: number | null;
}

/** A stash entry referenced by the stash-cleanup prompt. */
export interface StashEntryRef {
  index: number;
  message: string;
}

/** Wrap `s` in Markdown inline code (kept literal so callers read naturally). */
function code(s: string): string {
  return '`' + s + '`';
}

/**
 * Branch create + checkout. Mirrors the create-branch modal inputs; `from`
 * falls back to the current HEAD when empty.
 */
export function branchCreatePrompt(
  t: GitPromptTranslator,
  name: string,
  from: string | undefined
): string {
  const base =
    from && from.trim().length > 0
      ? code(from.trim())
      : t('git.aiPrompts.branchCreateBaseHead');
  return t('git.aiPrompts.branchCreate', { base, name: code(name.trim()) });
}

/** Branch delete (force-aware). */
export function branchDeletePrompt(
  t: GitPromptTranslator,
  name: string,
  force: boolean
): string {
  // Whole-sentence keys per variant rather than an appended note: the force
  // clause attaches differently per language, and a concatenated fragment
  // cannot carry that.
  return t(force ? 'git.aiPrompts.branchDeleteForce' : 'git.aiPrompts.branchDelete', {
    name: code(name),
  });
}

/** Stash list / cleanup. */
export function stashCleanupPrompt(t: GitPromptTranslator, stashes: StashEntryRef[]): string {
  const head = t('git.aiPrompts.stashCleanup');
  if (stashes.length === 0) return head;
  const list = stashes.map((s) => `- stash@{${s.index}}: ${s.message}`).join('\n');
  return `${head}\n\n${t('git.aiPrompts.stashCleanupCurrent')}\n${list}`;
}

/** Stash pop / apply conflict resolution. Appends the conflict notice if any. */
export function stashConflictPrompt(
  t: GitPromptTranslator,
  conflictNotice: string | null
): string {
  const head = t('git.aiPrompts.stashConflict');
  return conflictNotice && conflictNotice.trim().length > 0
    ? `${head}\n\n${conflictNotice.trim()}`
    : head;
}

/**
 * Reset delegation. Hard mode uses a dedicated message that adds the
 * reflog-recovery note, so the same prompt covers the "undo the last hard
 * reset" recovery case.
 */
export function resetPrompt(
  t: GitPromptTranslator,
  mode: GitResetMode,
  target: string
): string {
  if (mode === 'hard') {
    return t('git.aiPrompts.resetHard', { target: code(target) });
  }
  return t('git.aiPrompts.reset', { target: code(target), mode });
}

/** Revert a specific commit. */
export function revertPrompt(t: GitPromptTranslator, commitHash: string): string {
  return t('git.aiPrompts.revert', { commit: code(commitHash.slice(0, 7)) });
}

/** Force push with --force-with-lease, diff-first. */
export function forcePushPrompt(
  t: GitPromptTranslator,
  { branch, ahead }: ForcePushPromptInput
): string {
  const branchRef = branch ? code(branch) : t('git.aiPrompts.forcePushCurrentBranch');
  const upstream = code(`origin/${branch ?? '<branch>'}`);
  const hasAhead = typeof ahead === 'number' && ahead > 0;
  return t(hasAhead ? 'git.aiPrompts.forcePushAhead' : 'git.aiPrompts.forcePush', {
    branchRef,
    upstream,
    ahead: ahead ?? 0,
  });
}
