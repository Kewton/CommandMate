/**
 * Command Code's `/usage` panel: read it, and stop answering it with 18 keys
 * (Issue #2369).
 *
 * `/usage` opens a read-only overlay — a plan header, two meters, a breakdown
 * URL — whose last row is `Press Esc to close`. Before this Issue no rule
 * anywhere matched it, so it reached the chain's `default` floor as
 * `running` / `default`, which is `isUnclassifiedActive`, which the chat surface
 * answers with `TerminalEscapeHatch` (◀▲▼▶ ↵ Esc) plus `PromptAnswerKeys`
 * (`1`-`9` `y` `n` ↵). Eighteen buttons; the screen accepts one.
 *
 * ## Why the frame is written here rather than committed as a capture
 *
 * There is no live 200x1000 capture of this panel in the repository, and
 * `tests/unit/detection/tools/command-code/fixtures.test.ts` pins
 * `tests/fixtures/command-code-live-2250/` to exactly the thirteen frames that
 * WERE captured at that geometry, asserting the row and column counts of every
 * one. Padding a reconstruction out to 1000x200 to slip it into that directory
 * would make it indistinguishable from a measured capture, which is the one
 * thing a fixture directory must not allow.
 *
 * So the rows below are the panel as Issue #2369 records it, verbatim, with the
 * OSC 8 hyperlink the tool wraps the breakdown URL in — and the property under
 * test is about the FRAME (a footer row that offers a dismiss and nothing else),
 * not about the capture. The same file precedent exists in
 * `ChatSurface-selection-keys-2297.test.tsx`, which writes antigravity's
 * `Switch Model` out by hand for the same reason.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import { DISMISSABLE_PANEL_FOOTER_PATTERN } from '@/lib/detection/selection-shape';
import { isUnclassifiedFrame } from '@/lib/session/status-evidence';

const ESC = '\x1b';
const ST = `${ESC}\\`;

/** The breakdown URL as Command Code emits it: an OSC 8 pair around the label. */
const BREAKDOWN_LINK =
  `${ESC}]8;;https://commandcode.ai/Kewton/settings/usage${ST}` +
  'commandcode.ai/Kewton/settings/usage' +
  `${ESC}]8;;${ST}`;

/**
 * The `/usage` panel, ANSI intact.
 *
 * `transcriptRows` puts conversation above it, because that is what an inline
 * tool actually draws: Command Code does not clear the pane, so the panel is
 * painted under whatever the session already printed. A rule that only worked
 * on a panel alone would not fire in production.
 */
function usagePanelFrame(transcriptRows: readonly string[] = []): string {
  return [
    ...transcriptRows,
    '',
    ' USAGE  Go Plan · active',
    '█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 4% used',
    'Cycle: $9.61 left · 259 requests · 26 days to renewal',
    'Usage limits',
    '5-hour  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0%',
    `Weekly  ${ESC}[33m██${ESC}[0m░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 7% · resets in 2d 23h`,
    `Full breakdown at ${BREAKDOWN_LINK}`,
    'Press Esc to close',
    '',
    '',
  ].join('\n');
}

const TRANSCRIPT = [
  '> what is my usage',
  '',
  '  ⏺ Here is a summary of the repository layout, with 1. the CLI, 2. the app',
  '    and 3. the tests.',
  '',
  '  ✻ Worked for 4s',
];

describe('[#2369] the /usage panel reads as a dismiss-only panel', () => {
  it('answers waiting / command_code_dismissable_panel with positive evidence', () => {
    const result = detectSessionStatus(usagePanelFrame(TRANSCRIPT), 'command-code');

    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.COMMAND_CODE_DISMISSABLE_PANEL);
    expect(result.evidence).toBe('positive');
    // No dialog was parsed, so nothing downstream may try to answer one.
    expect(result.hasActivePrompt).toBe(false);
  });

  it('is therefore NOT an unclassified frame', () => {
    // The whole defect, in one assertion. `isUnclassifiedFrame` is
    // `status === 'running' && <floor reason>`, so a `waiting` verdict takes the
    // flag down with it — and with the flag goes the 18-button card.
    const result = detectSessionStatus(usagePanelFrame(TRANSCRIPT), 'command-code');

    expect(isUnclassifiedFrame(result.status, result.reason)).toBe(false);
  });

  it('is NOT a selection list, so no arrow pad is drawn for it', () => {
    // `isSelectionListActive` is derived from this set. The panel has no
    // highlight to move, so membership here would be as wrong as the answer keys.
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.COMMAND_CODE_DISMISSABLE_PANEL)).toBe(false);
  });

  it('goes back to the floor once the footer row is taken away (mutation)', () => {
    // Non-vacuity: the verdict above has to rest on the footer and on nothing
    // else about this frame. Reworded rather than deleted, so the panel keeps its
    // shape and only the sentence the rule reads is gone.
    const defused = usagePanelFrame(TRANSCRIPT).replace(
      'Press Esc to close',
      'Usage refreshed a moment ago',
    );

    const result = detectSessionStatus(defused, 'command-code');

    expect(result.reason).not.toBe(STATUS_REASON.COMMAND_CODE_DISMISSABLE_PANEL);
    expect(isUnclassifiedFrame(result.status, result.reason)).toBe(true);
  });
});

describe('[#2369] DISMISSABLE_PANEL_FOOTER_PATTERN', () => {
  it.each([
    'Press Esc to close',
    '  press esc to close  ',
    'Esc to close',
    'Hit Escape to dismiss',
    'esc to exit',
    'Press Esc to close.',
  ])('matches the dismiss-only footer %j', (row) => {
    expect(DISMISSABLE_PANEL_FOOTER_PATTERN.test(row)).toBe(true);
  });

  it.each([
    // Every one of these belongs to a screen with a highlight, and each would
    // cost that screen its arrows if this predicate said yes.
    'type to search · ↑/↓ navigate · enter to select · esc to cancel',
    'Enter to set as default · s to use this session only · Esc to cancel',
    'Press enter to confirm or esc to go back',
    '↑/↓ navigate · enter to select · esc to close',
    'Press Esc to close the file and go back to the list',
    'the docs say to press esc to close it',
  ])('refuses %j', (row) => {
    expect(DISMISSABLE_PANEL_FOOTER_PATTERN.test(row)).toBe(false);
  });
});

describe('[#2369] the screens that must not change', () => {
  const CARD_DIR = path.resolve(__dirname, '../../../../fixtures/chat-dialog-card-2254');
  const LIVE_DIR = path.resolve(__dirname, '../../../../fixtures/command-code-live-2250');
  const frame = (dir: string, name: string): string =>
    fs.readFileSync(path.join(dir, name), 'utf8');

  it('leaves the /model picker a selection list (#2297 regression)', () => {
    for (const name of [
      'command-code-model-1-40-1.txt',
      'command-code-model-1-47-1-open.txt',
      'command-code-model-1-47-1-middle.txt',
      'command-code-model-1-47-1-bottom.txt',
    ]) {
      const result = detectSessionStatus(frame(CARD_DIR, name), 'command-code');
      expect(result.reason, name).toBe(STATUS_REASON.COMMAND_CODE_SELECTION_LIST);
    }
  });

  it('leaves every committed Command Code capture off the new branch', () => {
    // The new rule must not have widened onto a frame somebody already measured.
    for (const name of fs.readdirSync(LIVE_DIR).filter((f) => f.endsWith('.txt'))) {
      const result = detectSessionStatus(frame(LIVE_DIR, name), 'command-code');
      expect(result.reason, name).not.toBe(STATUS_REASON.COMMAND_CODE_DISMISSABLE_PANEL);
    }
  });
});
