/**
 * Schedule "Ask AI" prompt templates (Issue #827, Schedules UX Phase 4).
 *
 * Single source of truth for the Japanese prompts that the ScheduleEditDialog
 * "Ask AI" buttons pre-populate into the active CLI tab's MessageInput composer
 * (no auto-send — the user reviews / edits the AI's reply, then pastes the
 * suggested cron / message back into the modal). Pure string builders: no
 * React / DOM, so they are unit-testable in isolation and reusable from any
 * schedule UI surface.
 *
 * Mirrors `git-ai-prompt-templates.ts` (Issue #817). i18n is a follow-up (this
 * Phase 4 ships ja only); centralizing the wording here is what makes that
 * follow-up a localized-table swap rather than a hunt through the dialog.
 */

/** Wrap `s` in Markdown inline code (kept literal so callers read naturally). */
function code(s: string): string {
  return '`' + s + '`';
}

/**
 * Cron-expression drafting. `current` is the user's in-progress cron input (may
 * be empty); when present it is echoed so the AI refines the existing value
 * rather than starting from scratch.
 */
export function cronPrompt(current: string): string {
  const trimmed = current.trim();
  const refine =
    trimmed.length > 0 ? `現在の入力は ${code(trimmed)} です。これを踏まえて、` : '';
  return (
    `スケジュール実行のタイミングを cron 式で表現したいです。${refine}` +
    '自然言語の要望（例: 「毎週月曜 9 時」）を cron 式に変換し、候補をいくつか提案してください' +
    `（例: 「毎週月曜 9 時」→ ${code('0 9 * * 1')}）。`
  );
}

/**
 * Message (instruction prompt) drafting for a schedule. `name` labels the
 * schedule so the AI can tailor the suggested instruction; falls back to a
 * generic phrasing when empty.
 */
export function messageDraftPrompt(name: string): string {
  const trimmed = name.trim();
  const subject =
    trimmed.length > 0 ? `スケジュール ${code(trimmed)} で` : 'このスケジュールで';
  return (
    `${subject} CLI ツールに定期実行させる message（指示プロンプト）を作成したいです。` +
    'まず用途を私に聞き取り、それを踏まえた message の内容を提案してください。'
  );
}
