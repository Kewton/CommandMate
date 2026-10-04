/**
 * Command Code pattern constants and helpers moved out of `../../cli-patterns.ts`
 * (Issue #3217). `cli-patterns.ts` re-exports every public name.
 */

import { stripAnsi } from '../../ansi';
import { PASTED_TEXT_PATTERN } from '../../shared/pasted-text';

/**
 * Command Code status-line spinner glyphs (Issue #2250).
 *
 * The complete `getWaveSymbol` frame set, read off the shipped bundle
 * (`command-code@1.40.1`, `dist/cli.mjs`):
 * `["·","○","◇","☆","✧","☆","◇","○","⌘"]` — six distinct glyphs, cycled.
 *
 * Deliberately NOT folded into {@link CLAUDE_SPINNER_CHARS}. Command Code marks
 * every assistant message with `⠶` (U+2836, see
 * {@link COMMAND_CODE_RESPONSE_MARKER_PATTERN}); adding that braille glyph to a
 * shared spinner class would make each reply's own first row read as "still
 * generating", and adding these glyphs to claude's class would do the same to
 * any claude reply that opens with `·`.
 */
export const COMMAND_CODE_SPINNER_CHARS = ['·', '○', '◇', '☆', '✧', '⌘'] as const;

/**
 * Command Code composer / dialog-cursor prompt pattern (Issue #2250).
 *
 * `❯` (U+276F) only — the ASCII `>` claude also accepts is not a glyph Command
 * Code 1.40.1 draws, and accepting it here would make every shell prompt and
 * every quoted diff line in a reply look like a composer.
 *
 * The row is drawn in two places, which is why prompt presence alone is not
 * "ready": the bottom-pinned composer (`❯ Ask your question...` between two
 * full-width rules) and the highlighted option of a permission dialog
 * (`❯ 1. Yes`). Completion is resolved structurally instead — see
 * {@link findCommandCodeChromeStart}.
 */
export const COMMAND_CODE_PROMPT_PATTERN = /^❯(\s*$|\s+\S)/m;

/**
 * Command Code separator pattern (Issue #2250).
 *
 * Full-pane runs of U+2500 fence the composer above and below, and one more is
 * drawn above a permission dialog. Measured at 200 columns on every fixture in
 * `tests/fixtures/command-code-live-2250/`.
 */
export const COMMAND_CODE_SEPARATOR_PATTERN = /^─{10,}$/m;

/**
 * Command Code status-line "esc to interrupt" hint (Issue #2250).
 *
 * The `Status` component renders `esc  to interrupt  •  <elapsed>  •  ↓ <tokens>`
 * only in its `"all"` layout, i.e. at a terminal width of 72 columns or more
 * (read off the bundle's `layoutMode` ladder; CommandMate panes are 200 wide, so
 * production always takes that branch). Below 42 columns the whole tail is
 * dropped and only the spinner + verb remain — which is why
 * {@link COMMAND_CODE_THINKING_PATTERN} keeps the spinner branch as well.
 */
export const COMMAND_CODE_INTERRUPT_HINT_PATTERN = /esc to interrupt/;

/**
 * Command Code thinking/processing pattern (Issue #2250).
 *
 * Three measured alternatives:
 *
 *  1. the status row — a spinner glyph, then a single word ending in `…`
 *     (`⌘ Planning…`, `· Synthesizing…`; the bundle's verb table is 74
 *     single-word entries, all capitalised, but the class is left case-agnostic
 *     because the `status` prop is not restricted to that table). Anchored at
 *     the start of the line with only leading spaces allowed, so the `·` in the
 *     banner's
 *     `# models: … · taste-1` row and in the idle footer's
 *     `? for shortcuts · taste on` cannot reach it;
 *  2. `✻ Thinking…` — the reasoning block's header WHILE it streams. It becomes
 *     `✻ Thought for 1 second [ctrl+o to expand]` once the block is closed, and
 *     that past-tense form must NOT match: it sits in the transcript of every
 *     finished turn (`turn-version.txt`);
 *  3. {@link COMMAND_CODE_INTERRUPT_HINT_PATTERN}, unanchored, for the same
 *     reason claude's pattern carries it.
 */
export const COMMAND_CODE_THINKING_PATTERN = new RegExp(
  `^[^\\S\\n]*[${COMMAND_CODE_SPINNER_CHARS.join('')}][^\\S\\n]+[A-Za-z]+…` +
    `|^[^\\S\\n]*✻ Thinking…` +
    `|${COMMAND_CODE_INTERRUPT_HINT_PATTERN.source}`,
  'm'
);

/**
 * Command Code assistant-message marker (Issue #2250).
 *
 * `⠶` (U+2836) at column 0, one space, then the reply. Fixed, not a spinner
 * frame: the bundle declares it as `Ct() ? "⠶" : "#"`, i.e. one constant with an
 * ASCII fallback for terminals without unicode support. That answers 親 Issue
 * #2249's 未確定事項 1 — the glyph does not rotate — and it is also why the `#`
 * fallback is deliberately NOT matched here: on such a terminal it is
 * indistinguishable from the `# Command Code v1.40.1` banner rows.
 *
 * Continuation rows of a multi-line reply are indented by two spaces (the marker
 * is one column wide and the body box carries `marginLeft: 1`).
 */
export const COMMAND_CODE_RESPONSE_MARKER_PATTERN = /^⠶(?:\s|$)/;

/**
 * Command Code turn-completion marker (Issue #2250).
 *
 * **Advisory only — never require it to declare a turn finished.** Two measured
 * reasons: `WorkedDurationNote` renders nothing for a turn under 1000 ms, and
 * the row belongs to the live turn's UI rather than to the transcript — it is
 * present in `turn-version.txt` and GONE from `dialog-create-file.txt`, which is
 * the same pane one prompt later.
 */
export const COMMAND_CODE_COMPLETION_PATTERN = /^[^\S\n]*✻ Worked for /m;

/**
 * Command Code footer mode indicator (Issue #2250).
 *
 * The row under the composer's closing rule. `? for shortcuts` is only the
 * DEFAULT-mode spelling: the bundle's `ModeIndicator` swaps it for a mode banner
 * in the other four permission modes, so a rule that keys on `? for shortcuts`
 * alone would stop recognising an idle pane the moment the operator pressed
 * shift+tab. All five spellings are listed.
 */
export const COMMAND_CODE_MODE_INDICATOR_PATTERN =
  /\?\s+for\s+shortcuts|»\s+accept edits on|»\s+permission bypass on|»\s+don't-ask on|^[^\S\n]*plan mode\s/m;

/**
 * Command Code startup banner rows (Issue #2250).
 *
 * The three-row header under the block-art logo — `# Command Code v1.40.1`,
 * `# models: …`, `# <cwd>` — plus the logo itself.
 *
 * The version row matches the tool's own NAME and version together, which is the
 * shape #2247 had to retreat to on claude: a bare `v\d+\.\d+` matched any reply
 * that mentioned a release, and the turn was silently dropped. Nothing here
 * matches a bare version string, a `│` table glyph, or a `Tip:` line.
 */
export const COMMAND_CODE_BANNER_PATTERNS: readonly RegExp[] = [
  /^#\s+Command Code v\d/, // Name + version, together
  /^#\s+models:\s/, // Model line
  /^#\s+[~/]/, // Working-directory line
  /^[^\S\n]*[█▀▄▌▐]{3,}/, // Block-art logo rows
] as const;

/**
 * Command Code hook notice row (Issue #2250).
 *
 * `◼ Ran 1 session start hook` — emitted into the transcript when SessionStart
 * hooks fire, so it lands ABOVE the first user echo and is chrome, not a reply.
 * Measured on a hooks-enabled 1.40.1 pane while capturing #2249's evidence.
 * Command Code's hook wiring itself is Phase B (#2251); this row only has to be
 * kept out of History.
 */
export const COMMAND_CODE_HOOK_NOTICE_PATTERN = /^[^\S\n]*◼\s+Ran\s+\d+\s+.*hooks?\b/;

/** How far above the last row Command Code's footer row may sit. */
const COMMAND_CODE_FOOTER_MAX_ROWS = 4;

/** How many rows the composer may span before the block stops looking like chrome. */
const COMMAND_CODE_INPUT_BOX_MAX_ROWS = 40;

/**
 * Locate the start of Command Code's bottom-pinned chrome within a captured pane.
 *
 * Command Code is inline-rendered, so its transcript grows downwards and the
 * last four rows of a settled pane are always the same four (measured on
 * `boot-idle.txt`, `turn-version.txt` and `turn-tool-write.txt`):
 *
 * ```text
 * ────────────────────  ← opening rule
 * ❯ Ask your question…  ← composer (one row per wrapped line)
 * ────────────────────  ← closing rule
 *   ? for shortcuts · taste on
 * ```
 *
 * Everything from the opening rule down is terminal furniture. Two things go
 * wrong if it reaches the extractor, and both are regressions this repository
 * has already paid for once: the composer's placeholder is drawn with the same
 * `❯ <text>` shape as a transcript echo, so the turn anchor lands on the FOOTER
 * and the reply extracts as empty (#1289); and the footer row is repainted while
 * the pane sits idle, so keeping it re-hashes the saved response on every poll
 * tick (#1268 / #1289).
 *
 * Structural, like the three readers next to it, and for the reason spelled out
 * on `findClaudeChromeStart`: the hint strings belong to Command Code and a rule
 * that matches them stops working the moment they are reworded. `-1` is the
 * honest answer for a frame with no composer at all — while a permission dialog
 * is up the whole block is replaced by the dialog, which the caller resolves on
 * the prompt path instead.
 *
 * @param lines - Captured pane lines, ANSI-bearing or not; trailing blanks tolerated
 * @returns Index of the opening rule, or -1 when no composer block is present
 */
export function findCommandCodeChromeStart(lines: string[]): number {
  const isSeparator = (line: string | undefined): boolean =>
    /^─{10,}$/.test(stripAnsi(line ?? '').trimEnd());

  let lastRow = lines.length - 1;
  while (lastRow >= 0 && lines[lastRow].trim() === '') lastRow--;
  if (lastRow < 0) return -1;

  // The closing rule sits just above the mode-indicator row.
  let closingSeparator = -1;
  for (let i = lastRow; i >= Math.max(0, lastRow - COMMAND_CODE_FOOTER_MAX_ROWS); i--) {
    if (isSeparator(lines[i])) {
      closingSeparator = i;
      break;
    }
  }
  if (closingSeparator < 0) return -1;

  // Walk up over the composer rows to the opening rule.
  let openingSeparator = -1;
  for (let i = closingSeparator - 1; i >= Math.max(0, closingSeparator - COMMAND_CODE_INPUT_BOX_MAX_ROWS); i--) {
    if (isSeparator(lines[i])) {
      openingSeparator = i;
      break;
    }
  }
  if (openingSeparator < 0) return -1;

  // Confirm the fenced rows are the composer and not a reply that happens to
  // contain two horizontal rules.
  if (!/^❯/.test(stripAnsi(lines[openingSeparator + 1] ?? ''))) return -1;

  return openingSeparator;
}

/**
 * Command Code skip patterns for response cleaning (Issue #2250).
 *
 * The dedicated cleaner Issue #2250 item 8 asks for: the startup banner, the
 * hook notice, the reasoning and turn summaries (`✻ Thought for` / `✻ Worked
 * for`), the composer, the rules and the footer.
 *
 * Nothing here touches the reply body or a tool block: `⠶ <text>`, ` WRITE
 * [probe.txt]`, ` └  Created probe.txt (1 line)` and `     1 │ hello` all
 * survive (`turn-tool-write.txt`). In particular there is no `^\s*│` rule — the
 * one codex carries — because Command Code renders file previews with it.
 */
export const COMMAND_CODE_SKIP_PATTERNS: readonly RegExp[] = [
  /^─{10,}$/, // Composer rules and the dialog's rule
  /^❯\s*$/, // Bare composer row
  /^❯\s+Ask your question\.\.\./, // Composer placeholder
  COMMAND_CODE_MODE_INDICATOR_PATTERN, // Footer mode indicator
  COMMAND_CODE_THINKING_PATTERN, // Status row
  /^[^\S\n]*✻\s+(?:Worked|Thought)\s+for\b/, // Turn / reasoning summaries
  COMMAND_CODE_HOOK_NOTICE_PATTERN, // "◼ Ran N session start hook"
  ...COMMAND_CODE_BANNER_PATTERNS, // Startup banner
  PASTED_TEXT_PATTERN, // [Pasted text #N +XX lines]
] as const;
