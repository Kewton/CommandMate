/**
 * Whether a vibe-local pane is ready to take a message body (Issue #4040).
 *
 * `VIBE_LOCAL_PROMPT_PATTERN` (`ctx:N% ❯` anywhere on the pane) is not that
 * test: vibe-local draws the row once per prompt and leaves it in the
 * scrollback with what was typed after it (`startup-screen.ts`), and a relaunch
 * into the same pane keeps the dead process's transcript above the new one
 * (#2070). A row somewhere above a loading screen therefore says nothing about
 * the pane now.
 *
 * Measured on vibe-local 1.3.3 (`tests/fixtures/vibe-local-readiness-4040/`),
 * the ready pane ends in the newest prompt row with nothing after the glyph,
 * followed only by vibe-local's own footer — a `─` rule, the status bar
 * (`✦ Ready │ ctx:4% │ <model>`) and `ESC: stop`. The status bar says `Ready`
 * while a turn is being generated too, so it is chrome, not evidence.
 *
 * The one exception is a turn being generated: vibe-local takes input then as
 * type-ahead (its banner says so), and the newest prompt row is the echo of the
 * running turn. It is accepted only on the detector's own generation evidence
 * (`isGeneratingStatus`) AND when output has been drawn below that row — a
 * composer still holding typed text (`ctx:4% ❯ Thinking …`) is the last row
 * itself, and is not ready whatever the detector reads in it.
 *
 * @module lib/detection/tools/vibe-local/readiness
 */

import { stripAnsi } from '../../ansi';
import { detectSessionStatus, isGeneratingStatus } from '../../status-detector';

/** The prompt row at column 0, with or without text after the glyph. */
const PROMPT_ROW = /^ctx:\d+%\s*[>❯]/;

/** The prompt row with nothing after the glyph: the input line, empty. */
const BARE_PROMPT_ROW = /^ctx:\d+%\s*[>❯]\s*$/;

/**
 * The rows vibe-local 1.3.3 draws under its prompt row: the rule, the status
 * bar and the interrupt hint. Anything else below the newest prompt row is
 * output (a banner, a loading line, a reply).
 */
const FOOTER_ROWS: readonly RegExp[] = [/^\s*─{3,}\s*$/, /^\s*✦\s.*│/, /^\s*ESC: stop\s*$/];

function isFooterRow(line: string): boolean {
  return FOOTER_ROWS.some((pattern) => pattern.test(line));
}

/**
 * @param output - Raw `capture-pane` output (ANSI escapes allowed)
 * @returns true when the newest prompt row is empty and only the footer is
 *   below it, or when a turn is being generated below the newest prompt row
 */
export function isVibeLocalComposerReady(output: string): boolean {
  const lines = stripAnsi(output).split('\n');
  let promptRow = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_ROW.test(lines[i])) {
      promptRow = i;
      break;
    }
  }
  if (promptRow < 0) return false;

  const below = lines.slice(promptRow + 1).filter((line) => line.trim() !== '');
  const outputBelow = below.some((line) => !isFooterRow(line));
  if (BARE_PROMPT_ROW.test(lines[promptRow]) && !outputBelow) return true;

  // Generation: the newest prompt row is the running turn's echo, and the
  // detector reads generation in what was drawn under it.
  if (!outputBelow) return false;
  const status = detectSessionStatus(output, 'vibe-local');
  return !status.hasActivePrompt && isGeneratingStatus(status);
}
