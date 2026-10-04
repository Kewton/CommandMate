/**
 * The live region: "where on this frame does the part the operator can act on
 * begin?" (Issue #3183, `docs/design/3183-live-region-extraction.md`).
 *
 * Before this module every tool answered that question on its own — codex by
 * the bottom-most `›` row (#892) and again by its SGR (#2841), agy by a `>`
 * under the list (#2845 / #2851), Command Code by a footer at the very bottom
 * (#2846), claude by the input box (#2847) — and a fix to one tool reached no
 * other. Here the answer is computed once per frame, by `normalizeFrame`, from
 * each tool's {@link LiveRegionSpec}; the status chain and the Auto-Yes path
 * then apply the SAME two rules to it:
 *
 *  - {@link isQuotedNumberedPrompt}: a numbered list on a frame whose input box
 *    is the bottom of the pane is conversation text, not a dialog;
 *  - {@link vetoesDialog}: likewise for a tool's own dialog reading.
 *
 * This file holds the shared parts the per-tool declarations are built from and
 * the two rules. It must stay free of the detector modules (`<tool>/detect.ts`)
 * so `normalizeFrame` can use it without an import cycle.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { PromptDetectionResult } from '../prompt-detector';
import type {
  DialogVerdict,
  LiveRegion,
  LiveRegionHit,
  LiveRegionMarker,
  LiveRegionRows,
  LiveRegionSpec,
} from './types';

/** The whole frame — the reading every rule had before Issue #3183. */
export function wholeFrameRegion(tool: CLIToolType | null, contentLines: readonly string[]): LiveRegion {
  return {
    tool,
    anchor: 'none',
    startRow: 0,
    composerAtBottom: false,
    composerHidesDialogs: false,
    lines: contentLines,
  };
}

/**
 * Locate the live region of one frame from one tool's declaration.
 *
 * The composer wins over the dialog top: a tool that draws its input box is,
 * by every measurement in the design doc §7, not showing a dialog above it.
 */
export function locateLiveRegion(
  spec: LiveRegionSpec | undefined,
  tool: CLIToolType | null,
  rows: LiveRegionRows,
): LiveRegion {
  const { contentLines } = rows;
  if (spec === undefined) return wholeFrameRegion(tool, contentLines);

  const composer = spec.composer.locate(rows);
  if (composer !== null) {
    return {
      tool,
      anchor: 'composer',
      startRow: composer.start,
      composerEndRow: composer.end ?? composer.start,
      composerAtBottom: composer.atBottom ?? true,
      composerHidesDialogs: spec.composerHidesDialogs,
      lines: contentLines.slice(composer.start),
    };
  }

  const dialog = spec.dialogTop?.locate(rows) ?? null;
  if (dialog !== null) {
    return {
      tool,
      anchor: 'dialog',
      startRow: dialog.start,
      composerAtBottom: false,
      composerHidesDialogs: spec.composerHidesDialogs,
      lines: contentLines.slice(dialog.start),
    };
  }

  return wholeFrameRegion(tool, contentLines);
}

/**
 * Is the numbered list the generic parser read a quotation? (Issue #3183)
 *
 * True when it is a `multiple_choice` reading on a frame whose input box is the
 * bottom of the pane, for a tool whose every answerable screen replaces the
 * input box ({@link LiveRegion.composerHidesDialogs}): the list then sits in
 * the conversation above it — an agent's reply quoting a dialog, or a dialog
 * left in the scrollback.
 *
 * For copilot and the opencode family a composer at the bottom does not prove
 * that much (their pickers are drawn over it), and their numbered candidates
 * stay with their own dialog rules — the Auto-Yes gate, which both enforce, and
 * opencode-v2's `requireVouchedPrompt`.
 *
 * The one rule both the status chain (`run-detection.ts`) and the Auto-Yes
 * path (`response-checker.ts`'s `detectPromptOnCleanFrame`) apply.
 */
export function isQuotedNumberedPrompt(region: LiveRegion, prompt: PromptDetectionResult): boolean {
  return (
    prompt.isPrompt &&
    prompt.promptData?.type === 'multiple_choice' &&
    region.composerAtBottom &&
    region.composerHidesDialogs
  );
}

/**
 * Should a tool's own dialog reading be discarded because the input box is the
 * bottom of the pane? (Issue #3183)
 *
 * Numbered dialogs always are: every tool measured removes its input box while
 * one is up (design doc §7). Arrow-key surfaces are only for tools whose every
 * screen replaces the input box ({@link LiveRegion.composerHidesDialogs}):
 * copilot and opencode draw their pickers OVER a live composer, so there a
 * composer at the bottom says nothing about a `keys` overlay.
 */
export function vetoesDialog(region: LiveRegion, verdict: DialogVerdict | null): boolean {
  if (verdict === null || !region.composerAtBottom) return false;
  return verdict.answerMode === 'numbered' || region.composerHidesDialogs;
}

// ---------------------------------------------------------------------------
// Shared parts the per-tool declarations are built from.
// ---------------------------------------------------------------------------

/**
 * A composer fenced by rules and pinned to the bottom (claude, Command Code,
 * copilot): the tool's own structural finder, which returns the index of the
 * block's first row or -1. The block runs to the last content row (the status
 * bar under the fence is part of it), so it is the bottom by construction.
 */
export function fencedComposer(find: (lines: string[]) => number): LiveRegionMarker {
  return {
    locate({ contentLines }): LiveRegionHit | null {
      const start = find(contentLines as string[]);
      if (start < 0) return null;
      return { start, end: lastContentRow(contentLines), atBottom: true };
    },
  };
}

/**
 * The bottom-most row `isComposerRow` accepts (agy's bare `>`, codex's `›`).
 * `atBottom` decides whether the rows below it still hold something live.
 */
export function bottomMostComposerRow(options: {
  isComposerRow: (row: string) => boolean;
  atBottom: (rows: LiveRegionRows, composerRow: number) => boolean;
}): LiveRegionMarker {
  return {
    locate(rows): LiveRegionHit | null {
      const { contentLines } = rows;
      for (let i = contentLines.length - 1; i >= 0; i--) {
        if (options.isComposerRow(contentLines[i])) {
          return { start: i, end: i, atBottom: options.atBottom(rows, i) };
        }
      }
      return null;
    },
  };
}

/** A dialog top found by a tool's own function over `contentLines` (-1 when absent). */
export function dialogTopFrom(find: (lines: readonly string[]) => number): LiveRegionMarker {
  return {
    locate({ contentLines }): LiveRegionHit | null {
      const start = find(contentLines);
      return start < 0 ? null : { start };
    },
  };
}

/** A numbered option row, cursor glyph optional (`❯ 1. Yes`, `  2. No`, `› 3. …`). */
const OPTION_ONE_ROW_PATTERN = /^\s*(?:[❯›>●]\s*)?1[.)]\s+\S/;

/**
 * The top of a dialog drawn as: rule, title, …, `1.` option, …, footer
 * (claude, Command Code). From the bottom-most footer, up to the first option,
 * up to the nearest rule. Searching from the OPTION rather than the footer is
 * what keeps an AskUserQuestion picker's second, inner rule (between its
 * options and its footer) from being taken for the top.
 */
export function ruleAboveOptionRun(options: {
  footer: (row: string) => boolean;
  rule: RegExp;
  maxRows: number;
}): LiveRegionMarker {
  return dialogTopFrom(lines => {
    let footer = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (options.footer(lines[i])) {
        footer = i;
        break;
      }
    }
    if (footer < 0) return -1;
    const floor = Math.max(0, footer - options.maxRows);
    let optionOne = -1;
    for (let i = footer - 1; i >= floor; i--) {
      if (OPTION_ONE_ROW_PATTERN.test(lines[i])) {
        optionOne = i;
        break;
      }
    }
    if (optionOne < 0) return -1;
    for (let i = optionOne - 1; i >= floor; i--) {
      if (options.rule.test(lines[i].trimEnd())) return i;
    }
    return -1;
  });
}

/** The last non-blank row's index, or -1. */
export function lastContentRow(lines: readonly string[]): number {
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === '') i--;
  return i;
}
