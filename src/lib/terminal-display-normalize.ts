/**
 * Panel-aware display-only blank-row compaction for TUI terminal panes
 * (Issue #2049).
 *
 * ## Why this module exists next to `lib/terminal/terminal-display-normalizer.ts`
 *
 * Issue #1172 already compacts the hundreds of layout-only blank rows a pinned
 * 1000-row pane leaves between the transcript and the composer, and
 * {@link normalizeTerminalOutputForDisplay} is the tested implementation of that
 * rule. Issue #2049 asked for the same treatment for `opencode` — but opencode
 * has one row shape #1172 never had to consider, and turning the existing flag
 * on for it verbatim **deletes structure**:
 *
 *   opencode draws its overlays (`ctrl+p` command palette, the model picker) as
 *   a background-painted panel. The panel's separator / padding rows carry no
 *   glyphs at all: they are ~70 columns of spaces under `ESC[48;2;20;20;20m`.
 *   `stripAnsi(row).trim() === ''` for them, so #1172's rule reads them as
 *   layout padding and folds them into the surrounding blank run — the panel
 *   loses its top band and its section separators.
 *
 * Measured live on opencode **1.18.22** (see
 * `docs/design/opencode-server-live-verification.md` §19). On the captured
 * `ctrl+p` frame the #1172 rule keeps 7 of the panel's 8 painted rows; the rule
 * here keeps 8 of 8, while still taking the frame from 201 rows to 58.
 *
 * The discriminator is measured, not guessed. Across every in-repo opencode live
 * capture plus the 1.18.22 recordings, visually-blank rows fall into exactly
 * three buckets:
 *
 * | bucket                                    | count | meaning              |
 * |-------------------------------------------|-------|----------------------|
 * | no columns, no SGR (`''`)                  | many  | layout padding       |
 * | no columns, background SGR                 | 1/frame | frame color init   |
 * | **columns of spaces + background SGR**     | 8–9 in overlay frames | panel body |
 *
 * "columns of spaces but no background" never occurs. So: **a visually-blank row
 * that actually paints columns with a background colour is structure.**
 *
 * The composer gutter (`┃`), the `╹▀▀▀…` separator and the approval-dialog rows
 * need no special handling at all — they carry glyphs, so they were never blank
 * and neither rule could ever drop them. The tests assert that rather than
 * assuming it.
 *
 * This module lives at `src/lib/` rather than beside its sibling because Issue
 * #2049's task contract scopes it here; {@link compactBlankRuns} is the shared
 * engine and `tests/unit/lib/terminal-display-normalize-2049.test.ts` pins it to
 * `normalizeTerminalOutputForDisplay` byte-for-byte on a fixture corpus so the
 * two rules cannot silently diverge.
 *
 * Like #1172 this is DISPLAY ONLY. The raw capture that feeds status/prompt
 * detection, Auto-Yes, response saving, transport and line counting is untouched.
 * The transform is pure, idempotent, preserves every non-blank line (content,
 * order, duplicates) and generates no HTML.
 */

import { stripAnsi, extractAnsiSequences } from '@/lib/detection/ansi';

/** SGR sequences only — `ESC[<params>m`. Cursor/erase CSI carry no colour. */
const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/**
 * Does this SGR parameter list set a non-default background colour?
 *
 * Parsed as a proper parameter walk rather than "does any number fall in 40–47",
 * because the extended-colour forms embed arbitrary numbers: `ESC[38;5;44m` is a
 * *foreground* 256-colour selection whose third parameter (44) would otherwise
 * read as "background green". `38`/`48`/`58` consume `5;n` or `2;r;g;b`.
 *
 * `49` (reset background to default) deliberately does NOT count — restoring the
 * default is the opposite of painting a panel.
 */
function paramsSetBackground(params: readonly number[]): boolean {
  let i = 0;
  while (i < params.length) {
    const p = params[i];
    if (p === 38 || p === 48 || p === 58) {
      if (p === 48) return true;
      const kind = params[i + 1];
      i += kind === 5 ? 3 : kind === 2 ? 5 : 2;
      continue;
    }
    if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) return true;
    i += 1;
  }
  return false;
}

/** True when the row carries at least one SGR that sets a background colour. */
function setsBackgroundColor(line: string): boolean {
  SGR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_PATTERN.exec(line)) !== null) {
    const params = match[1]
      .split(';')
      .filter((raw) => raw !== '')
      .map((raw) => Number(raw))
      .filter((n) => Number.isInteger(n));
    if (paramsSetBackground(params)) return true;
  }
  return false;
}

/** A line is visually blank if it has no printable content once ANSI is stripped. */
function isVisuallyBlank(line: string): boolean {
  return stripAnsi(line).trim() === '';
}

/**
 * Is this row the body of a background-painted panel rather than layout padding?
 *
 * Three conditions, all load-bearing:
 *
 * 1. **it is visually blank** — a row with glyphs is content under every rule
 *    and is never at risk, so it is not this predicate's business. Folding the
 *    blankness check in here (rather than leaving it to the caller) means
 *    `frame.filter(isPaintedPanelRow)` counts exactly the at-risk rows; without
 *    it, every painted *text* row of the panel would be counted too and a
 *    "panel rows survived" assertion would pass on a rule that dropped all of
 *    the blank ones.
 * 2. **it paints columns** — `stripAnsi(line) !== ''`. The single `ESC[38;2;…m
 *    ESC[48;2;4;4;4m` row every opencode frame opens with sets the frame colours
 *    but occupies no columns; it is not a panel and must stay collapsible.
 * 3. **it sets a background** — a run of unstyled spaces is padding, not a band.
 */
export function isPaintedPanelRow(line: string): boolean {
  return isVisuallyBlank(line) && stripAnsi(line) !== '' && setsBackgroundColor(line);
}

/** Options for {@link compactBlankRuns}. */
export interface CompactBlankRunsOptions {
  /**
   * Rows this predicate accepts are treated as content: they are emitted
   * verbatim and they break the surrounding blank run in two. Defaults to "no
   * row is structural", which reproduces the Issue #1172 rule exactly.
   */
  isStructuralRow?: (line: string) => boolean;
}

/**
 * Collapse layout-only blank rows, optionally protecting structural rows.
 *
 * Rules (Issue #1172, unchanged; the predicate is the only #2049 addition):
 * 1. Line visibility is judged on `stripAnsi(line).trim()`.
 * 2. Leading and trailing blank runs are removed (trimmed to 0 rows).
 * 3. An internal blank run of 1–2 rows is kept verbatim.
 * 4. An internal blank run of 3+ rows collapses to exactly ONE blank row that
 *    carries the run's ANSI escape sequences (in order) so colour/reset state
 *    spanning the gap still applies to subsequent rows.
 * 5. Non-blank lines are never altered.
 * 6. No artificial "N rows omitted" marker is inserted.
 * 7. **(#2049)** A row accepted by `isStructuralRow` counts as content for every
 *    rule above — it is never dropped, never collapsed, and it stops a leading /
 *    trailing trim the same way a glyph row does.
 */
export function compactBlankRuns(
  output: string,
  options: CompactBlankRunsOptions = {}
): string {
  if (output === '') return '';
  const { isStructuralRow } = options;

  const lines = output.split('\n');
  const result: string[] = [];
  let seenContent = false;
  let i = 0;

  const isCollapsible = (line: string): boolean =>
    isVisuallyBlank(line) && !(isStructuralRow?.(line) ?? false);

  while (i < lines.length) {
    if (!isCollapsible(lines[i])) {
      result.push(lines[i]);
      seenContent = true;
      i++;
      continue;
    }

    // Consume the full run of consecutive collapsible blank lines starting at i.
    let j = i;
    while (j < lines.length && isCollapsible(lines[j])) j++;
    const runLength = j - i;
    const isLeading = !seenContent;
    const isTrailing = j >= lines.length;

    if (!isLeading && !isTrailing) {
      if (runLength <= 2) {
        for (let k = i; k < j; k++) result.push(lines[k]);
      } else {
        // Collapse to a single blank row, preserving any ANSI state transitions.
        result.push(extractAnsiSequences(lines.slice(i, j).join('')));
      }
    }
    // Leading/trailing blank runs are dropped entirely (trimmed to 0 rows).

    i = j;
  }

  return result.join('\n');
}

/**
 * Normalize an opencode frame for display: compact layout padding the way Issue
 * #1172 does for claude/codex, but keep background-painted panel rows.
 *
 * Wired in through `TerminalDisplay`'s `preservePaintedPanelRows` prop, which
 * `src/config/terminal-display-compaction.ts` turns on for `opencode` only, so
 * claude / codex / copilot render byte-for-byte as before.
 */
export function normalizeOpencodeTerminalOutputForDisplay(output: string): string {
  return compactBlankRuns(output, { isStructuralRow: isPaintedPanelRow });
}
