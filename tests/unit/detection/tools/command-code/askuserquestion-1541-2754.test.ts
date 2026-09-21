/**
 * Command Code **1.54.1**'s `AskUserQuestion`, read off live captures (Issue #2754).
 *
 * `fixtures.test.ts` sweeps the directories it names — `command-code-live-2250`
 * and `chat-dialog-card-2254` — and nothing else. A capture added anywhere else
 * is therefore green by absence: that suite passes without ever opening it. This
 * file exists to read `tests/fixtures/command-code-askuserquestion-2754/`
 * **explicitly**, one row per capture, so the frames #2754 measured are
 * asserted rather than merely committed.
 *
 * ## What is pinned here is TODAY's reading
 *
 * #2754 measured and recorded; it changed no rule of its own, so the table
 * below opened as the chain's verdict **after #2753** with nine rows marked as
 * defects #2755 would have to close. **#2755 then closed all nine**, and the
 * table is what it closed them to. `changedIn2755` marks the twenty-three rows
 * whose verdict moved.
 *
 * What moved, in three families:
 *
 *  - **six frames published `ready` / `input_prompt`** — a live, unanswered
 *    question read as a finished turn, with `commandmate wait` exiting 0 on
 *    every one. It happened whenever the `❯` had left the option list: on
 *    `❯ Submit`, on `❯ Next`, and on the `❯ notes:` row that `n` opens. They
 *    are now recognised and declined (`cursor-outside-options`), which is
 *    #2521's manual-operation fallback rather than a payload — a digit sent
 *    while the cursor is off the list is measured to do nothing;
 *  - **the review page handed `1. Submit` / `2. Cancel` to the answer path**
 *    with the default on `Submit`, so answering the default COMMITTED whatever
 *    the human had ticked. Both review captures are now recognised as what they
 *    are and declined, which takes them away from Auto-Yes entirely;
 *  - **thirteen checkbox screens were declined outright and both readable
 *    single-selects carried the new footer inside their last option's label.**
 *    The checkbox screens are now read — `multiSelect: true`, a `checked` flag
 *    per row, the box stripped off the label — and the footer, with the
 *    `Submit` row above it, is no longer folded into anything.
 *
 * The three `not-applicable-*` rows are the control: the question is genuinely
 * gone on all three and none of their verdicts moved.
 *
 * ## What decides whether a frame is recognised at all
 *
 * Twenty-three of the twenty-six are recognised as this screen: everything but
 * the three captures taken after the question was cancelled or sent as chat.
 * Being recognised and being ANSWERABLE are two questions now — thirteen
 * checkbox screens and two single-selects are read in full, the six with the
 * cursor off the list and the two review pages are recognised and declined —
 * and keeping them apart is what stops a live question reaching the composer
 * check that publishes `ready`.
 *
 * It used to be one condition, and before #2753 two. The first was **no `✔` on
 * the tab strip**: 1.54.1 marks an ANSWERED tab with U+2714, which was in
 * neither `COMMAND_CODE_TAB_SELECTED_MARKERS` (`●◉⦿`) nor
 * `COMMAND_CODE_TAB_UNSELECTED_MARKERS` (`◯○◌⚪`), so one answered question
 * anywhere in the call took the whole strip out of `isCommandCodeQuestionTabRow`.
 * #2753 added `COMMAND_CODE_TAB_ANSWERED_MARKERS`. The second was **the `❯` has
 * to be on a numbered row**, which #2755 removed — see the case below, which
 * asserts both halves of what replaced it.
 *
 * Provenance, the keys that were sent and what each one did:
 * `tests/fixtures/command-code-askuserquestion-2754/README.md` and
 * `docs/design/command-code-1541-askuserquestion.md`.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDLE_EVIDENCE_ENV_VAR } from '@/config/detection-evidence-config';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import {
  extractCommandCodeSelectionListFrame,
  readCommandCodeReviewPage,
} from '@/lib/detection/selection-shape';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { readCommandCodeQuestionDialog } from '@/lib/detection/tools/command-code/dialog';
import { isMultipleChoicePrompt } from '../../../../helpers/prompt-type-guards';

const DIR = path.resolve(__dirname, '../../../../fixtures/command-code-askuserquestion-2754');

const frame = (name: string): string => readFileSync(path.join(DIR, `${name}.txt`), 'utf8');

/** Rows as the tool drew them: a single trailing newline is not a row. */
function rowsOf(raw: string): string[] {
  const rows = raw.split('\n');
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/** The pane's width, in columns, read the way a rule reads the frame. */
function columnsOf(raw: string): number {
  let widest = 0;
  for (const row of rowsOf(raw)) {
    widest = Math.max(widest, stripAnsi(row).replace(/\r$/, '').length);
  }
  return widest;
}

interface Expectation {
  /** Fixture basename, without `.txt`. */
  frame: string;
  status: 'idle' | 'ready' | 'running' | 'waiting';
  reason: string;
  hasActivePrompt: boolean;
  /** What `readCommandCodeQuestionDialog` answers today. */
  dialog: 'none' | 'unsupported' | 'prompt';
  /** Set only when `dialog === 'unsupported'`. */
  dialogReason?: string;
  /** Does `extractCommandCodeSelectionListFrame` crop this frame? */
  crop: boolean;
  /** The screen, and what this capture is here to state. */
  pins: string;
  /** True when Issue #2755 moved what the chain publishes for this frame. */
  changedIn2755: boolean;
}

/**
 * Every capture in the directory and the verdict it publishes **today**.
 *
 * The keystroke that produced each frame is in the directory's README; `pins`
 * says what the frame IS, not how it was reached.
 */
const EXPECTATIONS: readonly Expectation[] = [
  // ---- single-select: read in full, and #2755 unfolded the footer ---------
  {
    frame: 'singleselect-initial-unanswered-tabs',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'the positive control: a SINGLE-select question with nothing answered yet, read in full by the #2522 reader (`submitMode: answer_only`). #2755 took the 1.54.1 hint bar back OUT of option 4\'s label, where the tail walk had folded it',
    changedIn2755: true,
  },
  {
    frame: 'singleselect-answered-tabs',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'the same question one tab later, under `✔ Party size | ● Rental car | …`. #2753 taught the strip the `✔` so this reads in full too, and #2755 unfolded the same footer from option 3',
    changedIn2755: true,
  },

  // ---- multi-select: #2755 turned the decline into a reading --------------
  // Every row here answered `unsupported` / `multi-select` before this Issue —
  // #2521's manual-operation fallback, correct while nothing could answer a
  // checkbox screen and wrong the moment something could. They now carry
  // `multiSelect: true`, a `checked` flag per row and labels with the box
  // stripped off.
  {
    frame: 'tabs-single-question',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'ONE question, so the strip is `● Update scope | ◯ Review` — TWO cells, which is what settles #2754\'s open question about `segments.length < 2` — and the screen carries NO footer, because 1.54.1 only draws one when the call has more than one question. A checkbox list with a `Submit` row, so #2755 reads it',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-next-row-not-last-question',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'the confirm row of a multi-select that is NOT the last question reads `Next`, not `Submit`. #2755 accepts either: what the row does is commit this question, and which of the two words it uses is what tells the send arm whether a Review page follows',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-cursor-on-option-1-after-nav',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'the `❯` back on option 1 after three `↑`. Byte-identical to the frame before any arrow key was pressed, which is the point: the pane does NOT show whether the list has reported a highlight, and `Space` behaves differently in the two states — the measurement that keeps `Space` out of the send arm',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-cursor-on-option-3-nothing-checked',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'the `❯` on the last option with NO box ticked — the frame `d` was pressed on, so it is the before-side of the undocumented finish key. Every `checked` is false here, which is the empty end of the symmetric difference',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-up-from-option-1-wraps-to-last',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'the FIRST `↑` on a fresh screen wraps inside the option list to the last option — it does NOT jump to `Submit`. The second `↑` from option 1 does. Two presses of the same key, two destinations, which is why the send arm walks DOWN to the confirm row and never up',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-enter-toggled-option-1',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'one `Enter` on a multi-select option row TOGGLED it (`❯ 1. [✔] Shallow`) and left the question up. Enter is not a confirm on this screen — the single most load-bearing fact for #2755\'s send arm, and the reason it uses digits for the toggles',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-initial',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'a multi-select under TWO answered tabs, every box empty. Five options and the `❯` on option 1. The reported bug: before #2753 this published a five-option single-select whose labels read `[ ] calc.js`',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-two-checked',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'the same screen after the digits `2` and `4`: two `[✔]` boxes and the `❯` still on option 1, because a digit toggles without moving the cursor. `checked` is true for exactly 2 and 4',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-cursor-on-option-2',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'the `❯` moved onto an ALREADY TICKED box. The old payload called it the default, so answering the default would have UNticked it; #2755 reports it as `isDefault` AND `checked`, and refuses `--default` on the payload outright',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-space-untoggled-cursor-row',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'one `Space` later: option 2 is `[ ]` again. `Space` toggles the cursor row — but only once the list has reported a highlight (see the byte-identity note on `multiselect-cursor-on-option-1-after-nav`)',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-free-text-focused',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'the `❯` on `5. [ ] Type something...`, the TextInput row. The free-text row is NUMBERED and carries a checkbox of its own in a multi-select, so it reads as an option with both `requiresTextInput` and `checked`',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-free-text-typed',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'text typed into that row: the placeholder is gone AND the row\'s own box ticks ITSELF (`[✔] docs/api.md`) while the characters arrive. No Enter was pressed, and Enter there changes nothing at all',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-free-text-digit-appended',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'a `1` sent while that row has focus lands IN THE TEXT (`docs/api.md1`) and toggles nothing. Quick-select is dead the moment the cursor leaves the list — which is why #2755 refuses to send free text unless the cursor is already on the field (#2584\'s guard, kept)',
    changedIn2755: true,
  },

  // ---- the review page: recognised and declined (#2755 §7) ----------------
  {
    frame: 'review-page-submit-cancel',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'review-page',
    crop: false,
    pins: 'Enter on `❯ Submit` does NOT submit: it opens a Review page — the answers, then `❯ 1. Submit` / `  2. Cancel` and `← to go back and edit`. The generic parser used to read that two-option list as the prompt with the default on `Submit`, so answering a default COMMITTED instead of choosing. #2755 recognises the page and declines it, which takes it away from Auto-Yes entirely',
    changedIn2755: true,
  },
  {
    frame: 'review-page-unanswered-warning',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'review-page',
    crop: false,
    pins: 'the same Review page reached by the UNDOCUMENTED `d`, which ends a multi-select from any row: `⚠ You have not answered all questions` over a `No answer`. It declined for a numbering reason before (`1.` is drawn twice); #2755 names it for what it is, and the send arm refuses to confirm a page carrying this warning',
    changedIn2755: true,
  },

  // ---- the `❯` has left the list: no longer a finished turn ---------------
  // All six published `ready` / `input_prompt` before #2755 — a live question
  // read as a finished turn, `commandmate wait` exiting 0 on every one. The
  // condition is the cursor's POSITION, not the word it rests on, which is why
  // `Next` and `notes:` are in this group alongside `Submit`.
  {
    frame: 'multiselect-cursor-on-submit',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'cursor-outside-options',
    crop: true,
    pins: 'THE frame #2754 was raised for: `❯ Submit` — U+276F, one space, the word, no number and nothing else on the row. The option list has no cursor left, and before #2755 the composer check answered on `❯ Submit` itself',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-cursor-on-submit-no-footer',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'cursor-outside-options',
    crop: true,
    pins: 'the same `❯ Submit` on a ONE-question screen, where 1.54.1 draws no footer either. The worst shape on the tool, and the reason the footer is not used as evidence that this screen is up',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-up-from-option-1-lands-on-submit',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'cursor-outside-options',
    crop: true,
    pins: 'one `↑` from option 1 jumps straight to `❯ Submit`, skipping the free-text row — the shortest deterministic route to the confirm, and a third frame that used to read `ready`',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-cursor-on-next',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'cursor-outside-options',
    crop: true,
    pins: '`❯ Next` — the same row on a question that is not the last one. Proof that the false completion was about the cursor leaving the list and not about the word `Submit`, which is what #2755 generalised the condition to',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-notes-row-open',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'cursor-outside-options',
    crop: true,
    pins: '`n` opened `❯ notes: Add notes on this design…` between the free-text row and `Submit`. The question is still up and the cursor has left the list — a third label for the same condition, and the one that makes a word list untenable',
    changedIn2755: true,
  },
  {
    frame: 'multiselect-submit-row-space-ticked-option-1',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'cursor-outside-options',
    crop: true,
    pins: 'one `Space` sent with the `❯` resting on `Submit` ticked OPTION 1 — a row the cursor is nowhere near. The visible cursor does not say which row `Space` will hit, which is why #2755 never sends it',
    changedIn2755: true,
  },

  // ---- the question is genuinely gone --------------------------------------
  {
    frame: 'not-applicable-question-cancelled',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    hasActivePrompt: false,
    dialog: 'none',
    crop: false,
    pins: 'one `Esc` on an option row took the whole tool call down — `└ User declined to answer questions` and a fresh composer. `ready` is CORRECT here, and that is what says the six rows above were not',
    changedIn2755: false,
  },
  {
    frame: 'not-applicable-chat-disposition',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    hasActivePrompt: false,
    dialog: 'none',
    crop: false,
    pins: 'one `c` closed the dialog with the answers given so far — `└ User wants to discuss the questions instead of answering`. `ready` is correct here too, and the key that got there is a bare letter with no confirmation',
    changedIn2755: false,
  },
  {
    frame: 'not-applicable-cancelled-from-notes-row',
    status: 'running',
    reason: STATUS_REASON.THINKING_INDICATOR,
    hasActivePrompt: false,
    dialog: 'none',
    crop: false,
    pins: 'one `Esc` sent with the `notes:` input open took the whole tool call down, not just the notes row. Caught mid-turn, so this one reads `running` — a correct verdict, and the record of a key that removed a question while it was being measured',
    changedIn2755: false,
  },
];

describe('[#2754] the 1.54.1 capture directory', () => {
  it('is covered by the table exactly', () => {
    // A capture nobody asserts on proves nothing, and an expectation with no
    // capture is a rule nobody measured — the invariant `fixtures.test.ts`
    // states for its own directory, restated for this one.
    const onDisk = readdirSync(DIR)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => f.replace(/\.txt$/, ''))
      .sort();

    expect([...EXPECTATIONS].map((e) => e.frame).sort()).toEqual(onDisk);
    expect(onDisk.length).toBe(26);
  });

  it('holds verbatim captures at the production 200x1000 geometry', () => {
    for (const { frame: name } of EXPECTATIONS) {
      const raw = frame(name);
      expect(raw, `${name} lost its escape sequences`).toContain('\x1b[');
      expect(rowsOf(raw).length, `${name} is not a 1000-row capture`).toBe(1000);
      expect(columnsOf(raw), `${name} is not a 200-column capture`).toBe(200);
    }
  });

  it('carries no trace of the machine it was captured on', () => {
    // The probe ran in a throwaway repo under the session's scratchpad, and the
    // cwd row is the one place that path reached the frame. The README records
    // that substitution as the ONLY edit made to any of these captures, so a
    // capture added later without it has a test that says so.
    for (const { frame: name } of EXPECTATIONS) {
      const clean = stripAnsi(frame(name));
      expect(clean, `${name} still names a home directory`).not.toMatch(/\/Users\//);
      expect(clean, `${name} still names the session scratchpad`).not.toContain('scratchpad');
    }
  });

  it('says what every capture is for', () => {
    for (const { frame: name, pins } of EXPECTATIONS) {
      expect(pins.length, `${name} says nothing about what it pins`).toBeGreaterThan(20);
    }
  });

  it('was captured on a build that still says 1.54.1 on every frame', () => {
    // The banner row is the only in-frame evidence of the build, and it is the
    // reason the README can name a version at all. Command Code auto-updated the
    // globally installed package to 1.58.0 DURING the probe (its own
    // `[update-notice]` row is visible in these captures); the process being
    // read stayed on the build it was launched from, and this is what says so.
    for (const { frame: name } of EXPECTATIONS) {
      expect(stripAnsi(frame(name)), `${name} does not name the build`).toContain(
        '# Command Code v1.54.1',
      );
    }
  });
});

describe('[#2754] what the chain publishes for each 1.54.1 frame TODAY', () => {
  // The sweep runs the RULE, not the rollout table (#2011): Command Code ships
  // `legacy`, under which `resolveIdleEvidence` short-circuits before a tool
  // rule is consulted.
  beforeEach(() => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'command-code=enforce';
  });
  afterEach(() => {
    delete process.env[IDLE_EVIDENCE_ENV_VAR];
  });

  it.each(EXPECTATIONS)(
    '$frame → $status/$reason (active: $hasActivePrompt, dialog: $dialog)',
    ({ frame: name, status, reason, hasActivePrompt, dialog, dialogReason, crop }) => {
      const raw = frame(name);
      const result = detectSessionStatus(raw, 'command-code');
      expect({
        status: result.status,
        reason: result.reason,
        hasActivePrompt: result.hasActivePrompt,
      }).toEqual({ status, reason, hasActivePrompt });

      const reading = readCommandCodeQuestionDialog(raw);
      expect(reading.kind).toBe(dialog);
      if (reading.kind === 'unsupported') expect(reading.reason).toBe(dialogReason);

      expect(extractCommandCodeSelectionListFrame(raw) !== null).toBe(crop);
    },
  );

  it('publishes `positive` completion evidence on all twenty-six', () => {
    // Not a per-frame column, because it does not vary: Command Code's module
    // declares no `readIdleEvidence`, so §4 D1's "absence is not evidence" is
    // still open for this tool. Stated once, so the table stays about what does
    // vary.
    for (const { frame: name } of EXPECTATIONS) {
      expect(detectSessionStatus(frame(name), 'command-code').evidence).toBe('positive');
    }
  });

  it('recognises a `✔` tab strip, and declines only where the `❯` left the list', () => {
    // #2753 inverted this case. It used to assert that NOTHING with a `✔` on
    // its strip was recognised, because U+2714 was in neither tab-marker family
    // and one answered question took the whole strip out of
    // `isCommandCodeQuestionTabRow`. `COMMAND_CODE_TAB_ANSWERED_MARKERS` closed
    // that, so the invariant this directory can state now is the OTHER half of
    // the old pair, and it is the one #2755 still has to close: a frame is
    // declined exactly when its `❯` is not on an option row.
    const tabRowOf = (raw: string): string | undefined =>
      stripAnsi(raw)
        .split('\n')
        .find((row) => row.includes('|') && /[●◯]/.test(row));

    const withTick: string[] = [];
    const recognised: string[] = [];
    for (const { frame: name } of EXPECTATIONS) {
      const raw = frame(name);
      const tabRow = tabRowOf(raw);
      if (tabRow !== undefined && tabRow.includes('✔')) withTick.push(name);
      if (readCommandCodeQuestionDialog(raw).kind !== 'none') recognised.push(name);
    }

    // Twelve frames carry an answered tab, and every one of them is recognised.
    expect(withTick.length).toBe(12);
    const tickedAndDeclined = withTick.filter(
      (name) => readCommandCodeQuestionDialog(frame(name)).kind === 'none',
    );
    expect(tickedAndDeclined).toEqual([]);

    // The condition #2755 replaced it with, stated both ways: a frame is
    // recognised exactly when the question UI is on it, and the `❯` being off
    // the option list is now a PROPERTY of a recognised frame rather than a
    // reason to decline one. `cursorRowOf` reads the LAST `❯` row, which on
    // this screen is the cursor (the composer's own `❯` is not drawn while a
    // question is up).
    const cursorRowOf = (raw: string): string | undefined =>
      stripAnsi(raw)
        .split('\n')
        .map((row) => row.replace(/\s+$/, ''))
        .filter((row) => row.startsWith('❯'))
        .pop();
    const isOptionRow = (row: string | undefined): boolean => /^❯\s+\d+\.\s/.test(row ?? '');

    // Read in full ⇔ the cursor is on a numbered row. The frames where it is
    // not are recognised and declined with `cursor-outside-options`, which is
    // the whole of #2755 §8 in one assertion.
    for (const { frame: name, dialog, dialogReason } of EXPECTATIONS) {
      if (dialog === 'prompt') {
        expect(isOptionRow(cursorRowOf(frame(name))), `${name} has no cursor in the list`).toBe(true);
      }
      if (dialogReason === 'cursor-outside-options') {
        expect(isOptionRow(cursorRowOf(frame(name))), `${name} has a cursor in the list`).toBe(false);
      }
    }

    // Twenty-three frames are RECOGNISED as this screen — everything but the
    // three where the question is genuinely gone. Twenty-one are also CROPPED;
    // the two that are not are the review pages, which have no option list to
    // crop to (`readCommandCodeQuestionRegion` declines their doubled `1.`)
    // and are recognised by their own reading instead.
    expect(recognised).toHaveLength(23);
    const cropped = EXPECTATIONS.filter(
      (e) => extractCommandCodeSelectionListFrame(frame(e.frame)) !== null,
    ).map((e) => e.frame);
    expect(cropped).toHaveLength(21);
    expect(recognised.filter((name) => !cropped.includes(name)).sort()).toEqual([
      'review-page-submit-cancel',
      'review-page-unanswered-warning',
    ]);
  });
});

describe('[#2755] what this directory publishes now that the rules were re-read', () => {
  beforeEach(() => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'command-code=enforce';
  });
  afterEach(() => {
    delete process.env[IDLE_EVIDENCE_ENV_VAR];
  });

  it('no longer calls six live question screens finished turns', () => {
    // The `wait` consequence, said once rather than read out of the table. On
    // each of these a human is looking at an unanswered question, and until
    // #2755 `commandmate wait` exited 0 on every one of them.
    const cursorOutside = EXPECTATIONS.filter(
      (e) => e.dialogReason === 'cursor-outside-options',
    ).map((e) => e.frame);

    expect(cursorOutside.sort()).toEqual([
      'multiselect-cursor-on-next',
      'multiselect-cursor-on-submit',
      'multiselect-cursor-on-submit-no-footer',
      'multiselect-notes-row-open',
      'multiselect-submit-row-space-ticked-option-1',
      'multiselect-up-from-option-1-lands-on-submit',
    ]);

    for (const name of cursorOutside) {
      const result = detectSessionStatus(frame(name), 'command-code');
      expect(result.status, name).toBe('waiting');
      expect(result.reason, name).toBe(STATUS_REASON.COMMAND_CODE_SELECTION_LIST);
      // Not answerable — a digit is measured to do nothing while the `❯` is off
      // the list — so there is no payload, and the operator gets the
      // arrow-driven card instead of a session that looks finished.
      expect(result.hasActivePrompt, name).toBe(false);
      expect(result.promptDetection?.promptData, name).toBeUndefined();
    }
  });

  it('reads every checkbox screen as a multi-select payload, box off the label', () => {
    // The inversion of #2754's `no longer hands a checkbox list to the
    // single-select answer path`. That case pinned the DECLINE #2753 restored;
    // this one pins the reading #2755 replaced it with, and keeps the half that
    // still matters: a `[ ]` or `[✔]` must never reach a payload, from any
    // frame in the directory.
    const multiSelect: string[] = [];
    for (const { frame: name } of EXPECTATIONS) {
      const data = detectSessionStatus(frame(name), 'command-code').promptDetection?.promptData;
      if (!isMultipleChoicePrompt(data)) continue;
      for (const option of data.options) {
        expect(option.label, `${name} carries a checkbox into its payload`).not.toMatch(
          /^\[[ ✔x]\]/,
        );
      }
      if (data.multiSelect === true) multiSelect.push(name);
    }
    expect(multiSelect).toHaveLength(13);

    // And the frame the bug was reported from is answerable, with the state the
    // pane shows carried as `checked` rather than as text in the label.
    const reading = readCommandCodeQuestionDialog(frame('multiselect-two-checked'));
    expect(reading.kind).toBe('prompt');
    if (reading.kind !== 'prompt') return;
    const data = reading.prompt.promptData;
    expect(isMultipleChoicePrompt(data)).toBe(true);
    if (!isMultipleChoicePrompt(data)) return;
    expect(data.multiSelect).toBe(true);
    expect(data.options.map((o) => o.label)).toEqual([
      'calc.js Update calc.js.',
      'README.md Update README.md.',
      'docs Update the docs directory.',
      'tests Update the tests.',
      'Type something...',
    ]);
    expect(data.options.filter((o) => o.checked === true).map((o) => o.number)).toEqual([2, 4]);
    // The `❯` is still option 1 — a digit toggles without moving the cursor —
    // and that is `isDefault`, which on this screen means "the row a key would
    // toggle" and not "the answer".
    expect(data.options.find((o) => o.isDefault)?.number).toBe(1);
  });

  it('no longer makes the default answer a SUBMIT on the review page', () => {
    // The defect one screen later, and the one #2753 did not reach: the Review
    // page is a real numbered list, so the generic parser answered it with a
    // two-option `multiple_choice` whose default was `Submit`. Answering that
    // default did not pick anything — it COMMITTED whatever the human had
    // ticked, from a payload nobody meant to expose, with Auto-Yes free to fire
    // on it. #2755 recognises the page and declines it.
    for (const name of ['review-page-submit-cancel', 'review-page-unanswered-warning']) {
      const result = detectSessionStatus(frame(name), 'command-code');
      expect(result.hasActivePrompt, name).toBe(false);
      expect(result.promptDetection?.promptData, name).toBeUndefined();

      const reading = readCommandCodeQuestionDialog(frame(name));
      expect(reading.kind, name).toBe('unsupported');
      if (reading.kind === 'unsupported') expect(reading.reason, name).toBe('review-page');
    }

    // Read as what they are, including the half that must never be taken for an
    // answered page.
    expect(readCommandCodeReviewPage(frame('review-page-submit-cancel'))).toEqual({
      hasUnansweredWarning: false,
      cursorOnSubmit: true,
    });
    expect(readCommandCodeReviewPage(frame('review-page-unanswered-warning'))).toEqual({
      hasUnansweredWarning: true,
      cursorOnSubmit: true,
    });
    // Not a review page: the question screens it sits between.
    expect(readCommandCodeReviewPage(frame('multiselect-cursor-on-submit'))).toBeNull();
    expect(readCommandCodeReviewPage(frame('singleselect-answered-tabs'))).toBeNull();
  });

  it('no longer folds the new 1.54.1 footer into the last option', () => {
    // The failure that was easiest to miss, because the reading "worked":
    // 1.53.0 drew nothing under the last option, so the tail walk had nothing
    // to fold. 1.54.1 draws the hint bar there — and, on a multi-select, the
    // `Submit` row above it — and both landed in the label.
    const unfolded = [
      ['singleselect-initial-unanswered-tabs', 4, 'Type something...'],
      ['singleselect-answered-tabs', 3, 'Type something...'],
      ['multiselect-initial', 5, 'Type something...'],
    ] as const;

    for (const [name, count, label] of unfolded) {
      const reading = readCommandCodeQuestionDialog(frame(name));
      expect(reading.kind, name).toBe('prompt');
      if (reading.kind !== 'prompt') continue;

      const data = reading.prompt.promptData;
      expect(isMultipleChoicePrompt(data), name).toBe(true);
      if (!isMultipleChoicePrompt(data)) continue;

      expect(data.options, name).toHaveLength(count);
      const last = data.options[count - 1];
      expect(last?.label, name).toBe(label);
      expect(last?.label, name).not.toContain('Submit');
      expect(last?.label, name).not.toContain('Enter to select');
      // Still the free-text row, which is the flag the fold used to carry along
      // with the footer.
      expect(last?.requiresTextInput, name).toBe(true);
    }
  });

  it('still declines a checkbox list with no confirm row', () => {
    // The half of #2522's decline that #2755 kept. `tabs-single-question` DOES
    // draw a `Submit`, so it is read; the 1.53.0-shaped synthetic frame in the
    // #2522 directory draws none, and without one nothing measured says how the
    // question is committed — ticking boxes there would leave the operator
    // exactly where #2522 found them.
    const reading = readCommandCodeQuestionDialog(frame('tabs-single-question'));
    expect(reading.kind).toBe('prompt');

    const noConfirmRow = readFileSync(
      path.resolve(
        __dirname,
        '../../../../fixtures/command-code-askuserquestion-2522/unsupported-multi-select-checkboxes.txt',
      ),
      'utf8',
    );
    const declined = readCommandCodeQuestionDialog(noConfirmRow);
    expect(declined.kind).toBe('unsupported');
    if (declined.kind === 'unsupported') expect(declined.reason).toBe('multi-select');
  });
});
