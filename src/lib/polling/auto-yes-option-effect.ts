/**
 * Auto-Yes option effects - what picking one row of a permission dialog does
 * (Issue #3822).
 *
 * Until #3822 the resolver picked the default row, or row 1, of any numbered
 * dialog. On every tool measured here the rows of a permission dialog do not
 * mean the same thing: one allows this call only, the others save a rule
 * (`don't ask again`, `always allow`, `Persist to settings.json`), switch the
 * permission mode for the session (`allow all edits`, `Full Access`), or deny.
 * Where the cursor rests is the tool's choice, not a promise that the row is
 * the narrow one — agy keeps the `>` where the operator left it — so Auto-Yes
 * answers only the row that reads as "allow this call once", by its number,
 * and nothing when no single row reads that way.
 *
 * ## Where the wording comes from
 *
 * Every rule below is a row read off a live capture in the repository, named
 * next to it. Nothing is inferred from another tool's wording. A tool without
 * a table (gemini, vibe-local, opencode, opencode-v2) keeps the pre-#3822
 * reading: opencode's and OpenCode V2's permission strips are unnumbered and
 * never reach the resolver as a prompt (they are answered through the hook,
 * whose `allow` is `allowOnce`), and gemini / vibe-local have no captured
 * permission dialog to read.
 *
 * ## When a dialog counts as a permission dialog
 *
 * When at least one of its rows reads as an allow — this call once, a saved
 * rule, or a mode change. A `No` row alone does not make one: a launch dialog
 * (`Yes, continue` / `No, quit`, `Yes, I trust this folder` / `No, exit`) is
 * judged where it always was (the launch-dialog branch, the contract's deny
 * patterns). A numbered list none of whose rows the tool's table recognises (a
 * question's options, a dialog whose wording was never captured) keeps the
 * pre-#3822 default-row reading — this module only narrows what a recognised
 * permission dialog may be answered with, it does not decide which screens are
 * dialogs.
 *
 * Client-safe: no server-only imports (the resolver is bundled into
 * `hooks/useAutoYes.ts`).
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

/** What choosing one row does. `unknown`: the tool's table does not recognise it. */
export type AutoYesOptionEffect = 'allow-once' | 'allow-persistent' | 'mode-change' | 'deny' | 'unknown';

type EffectRule = readonly [Exclude<AutoYesOptionEffect, 'unknown'>, RegExp];

/** `don't` with a straight or a typographic apostrophe. */
const DONT = "don['’]t";

/** `No`, alone or followed by its explanation (`No, cancel`, `No, and tell … differently`). */
const DENY_NO: EffectRule = ['deny', /^No(?:,|$)/];

/**
 * Each tool's rows, first match wins. A rule is anchored at the start of the
 * label and reads only the words that say what the row does, so the command or
 * path a row quotes after them does not matter.
 */
const OPTION_EFFECT_RULES: Partial<Record<CLIToolType, readonly EffectRule[]>> = {
  // tests/fixtures/canary/permission-dialog.raw.txt, permission-hook-no-decision.raw.txt,
  // tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt,
  // tests/fixtures/tui-frame-footer-2776/claude-2.1.278-bash-approval-task-panel.txt
  claude: [
    ['allow-once', /^Yes$/],
    ['allow-persistent', /^Yes, and always allow\b/],
    ['mode-change', /^Yes, allow all edits\b/],
    ['mode-change', /^Yes, and switch to\b/],
    DENY_NO,
  ],
  // tests/unit/lib/detection/fixtures/codex-live-1628/approval-{run-command,apply-patch}.txt,
  // tests/fixtures/codex-dialogs-0157/approval.txt, codex-hooks-review-0148.ts,
  // tests/fixtures/codex-browser-use-2609/approval-form-browser-use.txt (`Allow` /
  // `Always allow` / `Cancel`, each followed by its description), and
  // tests/fixtures/codex-live-2310/dialog-permissions-picker.txt (the approval modes)
  codex: [
    ['allow-once', /^Yes$/],
    ['allow-once', /^Yes, proceed\b/],
    ['allow-once', /^Allow(?:\s{2,}|$)/],
    ['allow-persistent', new RegExp(`^Yes, and ${DONT} ask again\\b`)],
    ['allow-persistent', /^Always allow\b/],
    ['mode-change', /^Ask for approval\b/],
    ['mode-change', /^Approve for me\b/],
    ['mode-change', /^Full Access\b/],
    ['deny', /^Cancel\b/],
    DENY_NO,
  ],
  // tests/fixtures/antigravity-live-2364/dialog-bash-*.txt, dialog-create-file.txt,
  // tests/fixtures/strict-respond-3812/permission-run-command.txt. `always allow in
  // this conversation` is as much a saved rule as `(Persist to settings.json)`:
  // neither is this call only.
  antigravity: [
    ['allow-once', /^Yes$/],
    ['allow-once', /^Yes, run command$/],
    ['allow-once', /^Yes, allow creation$/],
    ['allow-persistent', /^Yes, and always allow\b/],
    DENY_NO,
  ],
  // tests/fixtures/command-code-live-2250/dialog-shell-command.txt, dialog-create-file.txt,
  // dialog-kill-task-1490.txt, tests/fixtures/command-code-plan-review-2763/after-approve.txt
  'command-code': [
    ['allow-once', /^Yes$/],
    ['allow-persistent', new RegExp(`^Yes, ${DONT} ask again\\b`)],
    ['mode-change', /^Yes, allow all edits\b/],
    DENY_NO,
  ],
  // tests/unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt and
  // copilot-picker-1895/picker-permissions.txt (`Manual ✓` / `Allow all`, the modes)
  copilot: [
    ['allow-once', /^Yes$/],
    ['allow-persistent', new RegExp(`^Yes, and ${DONT} ask again\\b`)],
    ['mode-change', /^Manual\b/],
    ['mode-change', /^Allow all\b/],
    DENY_NO,
  ],
};

/** Every table, for a caller that does not say which tool drew the dialog. */
const ANY_TOOL_RULES: readonly EffectRule[] = Object.values(OPTION_EFFECT_RULES).flat();

/** The tools whose permission rows are read (the others keep the pre-#3822 reading). */
export const OPTION_EFFECT_TOOLS = Object.keys(OPTION_EFFECT_RULES) as readonly CLIToolType[];

function rulesFor(cliToolId: CLIToolType | undefined): readonly EffectRule[] | null {
  if (cliToolId === undefined) return ANY_TOOL_RULES;
  return OPTION_EFFECT_RULES[cliToolId] ?? null;
}

function readWith(rules: readonly EffectRule[], label: string): AutoYesOptionEffect {
  const text = label.trim();
  for (const [effect, pattern] of rules) {
    if (pattern.test(text)) return effect;
  }
  return 'unknown';
}

/**
 * What choosing the row labelled `label` does on `cliToolId`'s dialog.
 *
 * @param cliToolId - The tool that drew the dialog. Omitted, every tool's
 *   table is read (the first rule that matches decides); a tool with no table
 *   reads every row as `unknown`.
 */
export function readOptionEffect(label: string, cliToolId?: CLIToolType): AutoYesOptionEffect {
  const rules = rulesFor(cliToolId);
  return rules === null ? 'unknown' : readWith(rules, label);
}

/**
 * Which row of a numbered dialog Auto-Yes may answer.
 *
 * - `not-a-permission-dialog`: no row reads as an allow (or the tool has no
 *   table); the caller keeps its own reading.
 * - `allow-once`: exactly one row reads as "allow this call once" — answer its
 *   number, wherever the cursor or the default is.
 * - `unidentified`: a permission dialog with no such row, or with two. Nothing
 *   is answered.
 */
export type AllowOnceSelection<T extends { label: string }> =
  | { kind: 'not-a-permission-dialog' }
  | { kind: 'allow-once'; option: T }
  | { kind: 'unidentified'; allowOnceCount: number };

/**
 * Pick the one "allow this call once" row of a permission dialog.
 *
 * @param options - The dialog's rows, as parsed
 * @param cliToolId - The tool that drew it; see {@link readOptionEffect}
 */
export function selectAllowOnceOption<T extends { label: string }>(
  options: readonly T[],
  cliToolId?: CLIToolType,
): AllowOnceSelection<T> {
  const rules = rulesFor(cliToolId);
  if (rules === null) return { kind: 'not-a-permission-dialog' };
  const effects = options.map((option) => readWith(rules, option.label));
  if (!effects.some((effect) => effect === 'allow-once' || effect === 'allow-persistent' || effect === 'mode-change')) {
    return { kind: 'not-a-permission-dialog' };
  }
  const once = options.filter((_option, index) => effects[index] === 'allow-once');
  if (once.length === 1) return { kind: 'allow-once', option: once[0] };
  return { kind: 'unidentified', allowOnceCount: once.length };
}
