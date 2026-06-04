/**
 * Git "Ask AI" prompt templates (Issue #817).
 *
 * Single source of truth for the Japanese prompts that the GitPane "Ask AI"
 * buttons pre-populate into the active CLI tab's MessageInput composer (no
 * auto-send — the user reviews / edits before sending). Pure string builders:
 * no React / DOM, so they are unit-testable in isolation and reusable from any
 * GitPane section.
 *
 * i18n is a follow-up (this Phase 3 ships ja only); centralizing the wording
 * here is what makes that follow-up a localized-table swap rather than a hunt
 * through GitPane.tsx.
 */

import type { GitResetMode } from '@/types/git';

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

const RESOLVE_THEN_COMMIT = 'conflict を解決してから commit してください。';

/** Wrap `s` in Markdown inline code (kept literal so callers read naturally). */
function code(s: string): string {
  return '`' + s + '`';
}

/**
 * Branch create + checkout. Mirrors the create-branch modal inputs; `from`
 * falls back to the current HEAD when empty.
 */
export function branchCreatePrompt(name: string, from: string | undefined): string {
  const base = from && from.trim().length > 0 ? code(from.trim()) : '現在の HEAD';
  return `${base} から ${code(name.trim())} ブランチを作成して checkout してください。`;
}

/** Branch delete (force-aware). */
export function branchDeletePrompt(name: string, force: boolean): string {
  const forceNote = force
    ? '（マージされていないコミットがあっても -D で強制削除してください）'
    : '';
  return `${code(name)} ブランチを削除してください。${forceNote}`;
}

/** Stash list / cleanup ("古い stash entry をリストアップ…"). */
export function stashCleanupPrompt(stashes: StashEntryRef[]): string {
  const head = '古い stash entry をリストアップし、不要なものを削除する提案をしてください。';
  if (stashes.length === 0) return head;
  const list = stashes.map((s) => `- stash@{${s.index}}: ${s.message}`).join('\n');
  return `${head}\n\n現在の stash:\n${list}`;
}

/** Stash pop / apply conflict resolution. Appends the conflict notice if any. */
export function stashConflictPrompt(conflictNotice: string | null): string {
  const head = `stash の pop / apply で conflict が発生しました。${RESOLVE_THEN_COMMIT}`;
  return conflictNotice && conflictNotice.trim().length > 0
    ? `${head}\n\n${conflictNotice.trim()}`
    : head;
}

/**
 * Reset delegation. Hard mode adds a reflog-recovery note so the same prompt
 * covers the "直前の hard reset を取り消したい" recovery case.
 */
export function resetPrompt(mode: GitResetMode, target: string): string {
  const head = `${code(target)} に対して ${mode} reset を行いたいです。安全に実行してください。`;
  if (mode === 'hard') {
    return (
      `${head} hard reset は作業内容を失う可能性があります。` +
      'もし直前の hard reset を取り消したい場合は git reflog から復旧してください。'
    );
  }
  return head;
}

/** Revert a specific commit. */
export function revertPrompt(commitHash: string): string {
  return `コミット ${code(commitHash.slice(0, 7))} を revert してください。`;
}

/** Force push with --force-with-lease, diff-first. */
export function forcePushPrompt({ branch, ahead }: ForcePushPromptInput): string {
  const branchRef = branch ? code(branch) : '現在のブランチ';
  const aheadNote = typeof ahead === 'number' && ahead > 0 ? `（↑${ahead}）` : '';
  const upstream = code(`origin/${branch ?? '<branch>'}`);
  return (
    `${branchRef}${aheadNote} を force-with-lease で push したいです。` +
    `事前に upstream（${upstream}）との差分を確認し、安全な場合のみ push してください。`
  );
}
