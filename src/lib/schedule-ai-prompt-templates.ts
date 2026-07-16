/**
 * Schedule "Ask AI" prompt templates (Issue #827, localized by #1307).
 *
 * Single source of truth for the prompts that the ScheduleEditDialog "Ask AI"
 * buttons pre-populate into the active CLI tab's MessageInput composer (no
 * auto-send — the user reviews / edits the AI's reply, then pastes the
 * suggested cron / message back into the modal). Because the draft is the
 * user's own outgoing message, it is localized.
 *
 * The wording lives in `schedule.edit.aiPrompts.*`; these builders only pick
 * the key and supply the context values. Mirrors `git-ai-prompt-templates.ts`.
 */

/**
 * Minimal structural type for a next-intl translator bound to the `schedule`
 * namespace. Declared here rather than imported so these stay plain functions:
 * callers pass the `t` they already hold.
 */
export type SchedulePromptTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string;

/** Wrap `s` in Markdown inline code (kept literal so callers read naturally). */
function code(s: string): string {
  return '`' + s + '`';
}

/**
 * Cron-expression drafting. `current` is the user's in-progress cron input (may
 * be empty); when present it is echoed so the AI refines the existing value
 * rather than starting from scratch.
 */
export function cronPrompt(t: SchedulePromptTranslator, current: string): string {
  const trimmed = current.trim();
  if (trimmed.length === 0) return t('edit.aiPrompts.cron');
  return t('edit.aiPrompts.cronRefine', { current: code(trimmed) });
}

/**
 * Message (instruction prompt) drafting for a schedule. `name` labels the
 * schedule so the AI can tailor the suggested instruction; falls back to a
 * generic phrasing when empty.
 */
export function messageDraftPrompt(t: SchedulePromptTranslator, name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return t('edit.aiPrompts.messageDraft');
  return t('edit.aiPrompts.messageDraftNamed', { name: code(trimmed) });
}
