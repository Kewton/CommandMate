/**
 * What a selection-list frame offers (Issue #2297).
 *
 * Issue #2254 gave every selection list the same three controls — ▲▼ Enter Esc —
 * on the theory that a moving highlight is a moving highlight. The six agents
 * disagree, and two of them disagree with THEMSELVES between screens, so the
 * card has to read the frame rather than the tool id. This suite is that reading,
 * pinned against the live captures rather than against synthetic strings:
 * every assertion below runs on a real `capture-pane -p -e` of a real dialog at
 * the production 200x1000 geometry.
 *
 * The three properties worth pinning, in the order they can hurt someone:
 *
 *  1. **claude's `/model` gets no number row.** MEASURED on 2.1.260: pressing
 *     `4` on that overlay answered `Set model to Sonnet 5 and saved as your
 *     default for new sessions` and rewrote `~/.claude/settings.json` in ONE
 *     keystroke. A number button there is an unlabelled version of exactly the
 *     write Issue #2297 exists to stop. `offersSessionScope` is what refuses it.
 *  2. **A picker with a search box gets no number row either**, because a `4`
 *     typed there is a character of a query. copilot's `/model` and Command
 *     Code's picker both have one.
 *  3. **Everything else numbered keeps its numbers**, sized to the options the
 *     dialog is actually offering — including codex's 7-model picker on a launch
 *     frame that ALSO carries the `Update available!` box the Issue names as a
 *     trap.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  COMMAND_CODE_SELECTION_LIST_FOOTER,
  MAX_OPTION_NUMBER,
  SELECTION_SHAPE_TAIL_LINE_COUNT,
  readSelectionListShape,
  shouldOfferOptionNumbers,
} from '@/lib/detection/selection-shape';

const CARD_DIR = path.resolve(__dirname, '../../../fixtures/chat-dialog-card-2254');
const COPILOT_DIR = path.resolve(__dirname, 'fixtures/copilot-picker-1895');

const card = (name: string): string => fs.readFileSync(path.join(CARD_DIR, name), 'utf-8');
const copilot = (name: string): string => fs.readFileSync(path.join(COPILOT_DIR, name), 'utf-8');

// ---------------------------------------------------------------------------
// The live captures, read as shapes
// ---------------------------------------------------------------------------

describe('[#2297] every measured dialog, read off its own capture', () => {
  it('claude /model: five options, a session scope, and Enter that writes a default', () => {
    const shape = readSelectionListShape(card('claude-model-2-1-259.txt'));

    expect(shape.optionCount).toBe(5);
    expect(shape.offersSessionScope).toBe(true);
    expect(shape.commitsDefaultOnEnter).toBe(true);
    expect(shape.hasFilterInput).toBe(false);
  });

  it('claude /model reads the same on 2.1.260 — the build the number key was probed on', () => {
    // Two builds, one reading. The 2.1.260 capture is the frame that was live
    // when `4` was measured to commit-and-save, so it is the one that has to
    // keep refusing the number row.
    const shape = readSelectionListShape(card('claude-model-2-1-260.txt'));

    expect(shape).toEqual(readSelectionListShape(card('claude-model-2-1-259.txt')));
    expect(shouldOfferOptionNumbers(shape)).toBe(false);
  });

  it('claude folder-trust: an arrow list with no numbers at all', () => {
    const shape = readSelectionListShape(card('claude-trust-2-1-259.txt'));

    expect(shape.optionCount).toBe(0);
    expect(shape.offersSessionScope).toBe(false);
  });

  it('codex /model: seven options, no session scope, numbers offered', () => {
    const shape = readSelectionListShape(card('codex-model-0-151-0.txt'));

    expect(shape.optionCount).toBe(7);
    expect(shape.offersSessionScope).toBe(false);
    expect(shouldOfferOptionNumbers(shape)).toBe(true);
  });

  it('codex directory-trust: two options', () => {
    expect(readSelectionListShape(card('codex-trust-0-151-0.txt')).optionCount).toBe(2);
  });

  it('Command Code /model: a name list behind a search box, so no numbers', () => {
    // Measured live on v1.40.1 for this Issue. The list is grouped by provider
    // and carries no option numbers at all, and the `› Type to search models...`
    // row takes every character typed at it.
    const shape = readSelectionListShape(card('command-code-model-1-40-1.txt'));

    expect(shape.optionCount).toBe(0);
    expect(shape.hasFilterInput).toBe(true);
    expect(shape.offersSessionScope).toBe(false);
    expect(shouldOfferOptionNumbers(shape)).toBe(false);
  });

  it('opencode agent overlay: nothing numbered, nothing to commit', () => {
    const shape = readSelectionListShape(card('opencode-agent-overlay-1-18-27.txt'));

    expect(shape.optionCount).toBe(0);
    expect(shape.offersSessionScope).toBe(false);
  });

  it('copilot /permissions: two options inside a panel border', () => {
    // `│    1. Manual ✓` — the option rows are drawn INSIDE a box, so a pattern
    // anchored on whitespace alone would count nothing here.
    const shape = readSelectionListShape(copilot('picker-permissions.txt'));

    expect(shape.optionCount).toBe(2);
    expect(shouldOfferOptionNumbers(shape)).toBe(true);
  });

  it('copilot /theme: five options, and the diff gutter beside them counts for nothing', () => {
    // The right-hand preview column carries `1 -   function getUser(...)` and
    // `5 +   export default …` on the SAME rows as the options. A digit with no
    // `.`/`)` after it is not an option row.
    expect(readSelectionListShape(copilot('picker-theme.txt')).optionCount).toBe(5);
  });

  it.each([
    'picker-agent.txt',
    'picker-mcp.txt',
    'picker-skills.txt',
    'picker-statusline.txt',
    'picker-subagents.txt',
  ])('copilot %s: an unnumbered picker stays unnumbered', (name) => {
    expect(readSelectionListShape(copilot(name)).optionCount).toBe(0);
  });

  it('copilot answer text that QUOTES picker vocabulary is not read as a dialog', () => {
    // `picker-vocabulary-in-response.txt` is the live frame #1895 captured of
    // copilot's own reply containing footer wording. Nothing here may be counted.
    const shape = readSelectionListShape(copilot('picker-vocabulary-in-response.txt'));

    expect(shape.optionCount).toBe(0);
    expect(shape.offersSessionScope).toBe(false);
    expect(shape.commitsDefaultOnEnter).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The counting rule
// ---------------------------------------------------------------------------

describe('[#2297] the option count is the LAST ascending run, not every number on the pane', () => {
  it('ignores a numbered box ABOVE the picker — the codex launch trap', () => {
    // Issue #2297 names this by name: codex's startup `Update available!` box
    // sits above the picker on a real launch frame, and a key aimed at the
    // picker that lands on that box runs `npm install -g @openai/codex`.
    const frame = [
      '╭──────────────────────────────╮',
      '│ ✨ Update available!         │',
      '│ 1. Update now                │',
      '│ 2. Later                     │',
      '╰──────────────────────────────╯',
      '',
      '  Select Model and Effort',
      '› 1. gpt-5.6-sol (current)',
      '  2. gpt-5.6-terra',
      '  3. gpt-5.6-luna',
      '',
      '  Press enter to confirm or esc to go back',
    ].join('\n');

    expect(readSelectionListShape(frame).optionCount).toBe(3);
  });

  it('stops at a gap rather than counting a later stray number', () => {
    const frame = ['  1. one', '  2. two', '  7. seven', '  footer'].join('\n');

    expect(readSelectionListShape(frame).optionCount).toBe(2);
  });

  it('caps at nine, because a single keystroke cannot deliver `10`', () => {
    // copilot's session picker numbers past nine. The transport sends one key
    // per array entry and has no chord handling for two-character numbers.
    const rows = Array.from({ length: 12 }, (_v, i) => `  ${i + 1}. session ${i + 1}`);
    const shape = readSelectionListShape(rows.join('\n'));

    expect(shape.optionCount).toBe(MAX_OPTION_NUMBER);
    expect(MAX_OPTION_NUMBER).toBe(9);
  });

  it('does not reach past the tail window into the transcript', () => {
    // A markdown answer with a numbered list sits hundreds of rows above the
    // dialog on a 200x1000 pane. Bounding the window is what keeps it out.
    const frame = [
      '  1. a step in an assistant reply',
      '  2. another step',
      ...Array.from({ length: SELECTION_SHAPE_TAIL_LINE_COUNT + 5 }, (_v, i) => `row ${i}`),
      '  Enter to confirm · Esc to cancel',
    ].join('\n');

    expect(readSelectionListShape(frame).optionCount).toBe(0);
  });

  it('reads through the ANSI a real capture is taken with', () => {
    // The card is handed `capture-pane -p -e` output, escapes intact, because
    // the highlight is SGR. Every fixture above proves this in passing; this
    // states it.
    const plain = '  1. one\n  2. two\n  Enter to confirm · Esc to cancel';
    const painted =
      '\x1b[38;5;153m  1. one\x1b[39m\n\x1b[1m  2. two\x1b[22m\n  Enter to confirm \u00b7 Esc to cancel';

    expect(readSelectionListShape(painted)).toEqual(readSelectionListShape(plain));
  });

  it('answers the empty shape for a blank or missing frame', () => {
    for (const frame of [undefined, null, '', '\n\n   \n']) {
      const shape = readSelectionListShape(frame);
      expect(shape.optionCount).toBe(0);
      expect(shape.offersSessionScope).toBe(false);
      expect(shape.hasFilterInput).toBe(false);
      expect(shouldOfferOptionNumbers(shape)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The two refusals
// ---------------------------------------------------------------------------

describe('[#2297] shouldOfferOptionNumbers refuses the two measured traps', () => {
  it('refuses a numbered list whose footer offers a session scope', () => {
    // Mutation guard: drop the `offersSessionScope` clause and this goes red
    // while every "numbers appear" assertion above stays green — which is the
    // shape of the bug (a working button that writes the user's global default).
    const shape = readSelectionListShape(card('claude-model-2-1-259.txt'));

    expect(shape.optionCount).toBeGreaterThan(0);
    expect(shouldOfferOptionNumbers(shape)).toBe(false);
  });

  it('refuses a numbered list drawn over a search box', () => {
    const frame = [
      '  Select model',
      '❯  Search models…',
      '  1. one',
      '  2. two',
      '  ↑/↓ to navigate · enter to select · esc to cancel',
    ].join('\n');
    const shape = readSelectionListShape(frame);

    expect(shape.optionCount).toBe(2);
    expect(shape.hasFilterInput).toBe(true);
    expect(shouldOfferOptionNumbers(shape)).toBe(false);
  });

  it('offers numbers when neither trap is present', () => {
    expect(shouldOfferOptionNumbers(readSelectionListShape(card('codex-trust-0-151-0.txt')))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Command Code's footer, which nothing matched before this Issue
// ---------------------------------------------------------------------------

describe("[#2297] COMMAND_CODE_SELECTION_LIST_FOOTER matches the picker and not the transcript", () => {
  it('matches the measured v1.40.1 footer verbatim', () => {
    expect(
      COMMAND_CODE_SELECTION_LIST_FOOTER.test(
        'type to search · ↑/↓ navigate · shift+↑/↓ jump provider · enter to select · esc to cancel',
      ),
    ).toBe(true);
  });

  it('matches inside the real capture', () => {
    expect(COMMAND_CODE_SELECTION_LIST_FOOTER.test(card('command-code-model-1-40-1.txt'))).toBe(
      true,
    );
  });

  it('stays off prose that merely contains the words', () => {
    // The `·` separator is the narrowing: a sentence is not a hint bar.
    for (const line of [
      'press enter to select the option you want, then esc to cancel',
      'Enter to set as default · s to use this session only · Esc to cancel',
      'Press enter to confirm or esc to go back',
    ]) {
      expect(COMMAND_CODE_SELECTION_LIST_FOOTER.test(line), line).toBe(false);
    }
  });
});
