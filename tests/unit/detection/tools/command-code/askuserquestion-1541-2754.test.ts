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
 * ## What is pinned here is TODAY's reading, not the right one
 *
 * #2754 measures and records; it changes no rule. Rows marked `changesIn2755`
 * are the defect written down, and there are three families of it:
 *
 *  - **six frames publish `ready` / `input_prompt`** — a live, unanswered
 *    question read as a finished turn. `commandmate wait` exits 0 on every one
 *    of them. It happens whenever the `❯` has left the option list: on
 *    `❯ Submit`, on `❯ Next`, and on the `❯ notes:` row that `n` opens. #2521
 *    argued the first of those from a synthetic frame; these are captures;
 *  - **seven frames hand a CHECKBOX list to the single-select answer path**,
 *    with `isAskUserQuestion: true` and a `defaultOption`. On
 *    `multiselect-cursor-on-option-2` the payload's default is option 2 — a box
 *    that is already ticked — so answering the default would UNtick it;
 *  - **the one frame the reader still reads correctly has the new footer folded
 *    into its last option's label** (`singleselect-initial-unanswered-tabs`).
 *
 * Making one of these rows go red is what #2755 looks like from here; changing
 * a rule to make one green early is what this Issue's 逸脱時の扱い forbids.
 *
 * ## Two independent conditions decide whether a frame is recognised at all
 *
 * Seven of the twenty-six reach the #2521 region reading. A frame has to clear
 * both of these to get there, and 1.54.1 breaks each one on its own:
 *
 *  - **no `✔` on the tab strip.** 1.54.1 marks an ANSWERED tab with U+2714,
 *    which is in neither `COMMAND_CODE_TAB_SELECTED_MARKERS` (`●◉⦿`) nor
 *    `COMMAND_CODE_TAB_UNSELECTED_MARKERS` (`◯○◌⚪`), so
 *    `isCommandCodeQuestionTabRow` refuses the strip and no region is found.
 *    One question answered anywhere in the call is enough;
 *  - **the `❯` on an option row.** 1.54.1 lets the cursor leave the list
 *    entirely — onto `Submit`, `Next` or the `notes:` input — and the region
 *    reading counts cursors inside the numbered run.
 *
 * Neither implies the other, and the six `ready` frames are the second
 * condition failing on frames whose strip is clean.
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
import { extractCommandCodeSelectionListFrame } from '@/lib/detection/selection-shape';
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
  /** True when #2755 is expected to publish something else for this frame. */
  changesIn2755: boolean;
}

/**
 * Every capture in the directory and the verdict it publishes **today**.
 *
 * The keystroke that produced each frame is in the directory's README; `pins`
 * says what the frame IS, not how it was reached.
 */
const EXPECTATIONS: readonly Expectation[] = [
  // ---- no `✔` on the strip: the #2521 / #2522 reading still fires ---------
  {
    frame: 'singleselect-initial-unanswered-tabs',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'prompt',
    crop: true,
    pins: 'the positive control: a SINGLE-select question with nothing answered yet, read in full by the #2522 reader (`submitMode: answer_only`) — except that 1.54.1 draws a footer under the last option and `findNumberedOptionBlock` folds it into option 4\'s LABEL',
    changesIn2755: true,
  },
  {
    frame: 'tabs-single-question',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'multi-select',
    crop: true,
    pins: 'ONE question, so the strip is `● Update scope | ◯ Review` — TWO cells, which is what settles #2754\'s open question about `segments.length < 2` — and the screen carries NO footer, because 1.54.1 only draws one when the call has more than one question',
    changesIn2755: false,
  },
  {
    frame: 'multiselect-next-row-not-last-question',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'multi-select',
    crop: true,
    pins: 'the confirm row of a multi-select that is NOT the last question reads `Next`, not `Submit`. Nothing is answered yet, so this is a multi-select the fallback still catches',
    changesIn2755: false,
  },
  {
    frame: 'multiselect-cursor-on-option-1-after-nav',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'multi-select',
    crop: true,
    pins: 'the `❯` back on option 1 after three `↑`. Byte-identical to the frame before any arrow key was pressed, which is the point: the pane does NOT show whether the list has reported a highlight, and `Space` behaves differently in the two states',
    changesIn2755: false,
  },
  {
    frame: 'multiselect-cursor-on-option-3-nothing-checked',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'multi-select',
    crop: true,
    pins: 'the `❯` on the last option with NO box ticked — the frame `d` was pressed on, so it is the before-side of the undocumented finish key',
    changesIn2755: false,
  },
  {
    frame: 'multiselect-up-from-option-1-wraps-to-last',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'multi-select',
    crop: true,
    pins: 'the FIRST `↑` on a fresh screen wraps inside the option list to the last option — it does NOT jump to `Submit`. The second `↑` from option 1 does. Two presses of the same key, two destinations, and the frames before them are byte-identical',
    changesIn2755: false,
  },
  {
    frame: 'multiselect-enter-toggled-option-1',
    status: 'waiting',
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    hasActivePrompt: false,
    dialog: 'unsupported',
    dialogReason: 'multi-select',
    crop: true,
    pins: 'one `Enter` on a multi-select option row TOGGLED it (`❯ 1. [✔] Shallow`) and left the question up. Enter is not a confirm on this screen — which is the single most load-bearing fact for #2755\'s send arm',
    changesIn2755: false,
  },

  // ---- `✔` on the strip: the reading never fires, the generic parser does --
  {
    frame: 'singleselect-answered-tabs',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'none',
    crop: false,
    pins: 'a SINGLE-select under one answered tab (`✔ Party size | ● Rental car | …`). The same question one tab earlier is read in full; with the `✔` present the reader declines and the generic parser answers with a `question` that has swallowed the transcript rows above the strip',
    changesIn2755: true,
  },
  {
    frame: 'multiselect-initial',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'none',
    crop: false,
    pins: 'a multi-select under TWO answered tabs, every box empty. Five options, the `❯` on option 1, and a payload whose labels keep their `[ ] ` prefix',
    changesIn2755: true,
  },
  {
    frame: 'multiselect-two-checked',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'none',
    crop: false,
    pins: 'the same screen after the digits `2` and `4`: two `[✔]` boxes and the `❯` still on option 1, because a digit toggles without moving the cursor',
    changesIn2755: true,
  },
  {
    frame: 'multiselect-cursor-on-option-2',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'none',
    crop: false,
    pins: 'the `❯` moved onto an ALREADY TICKED box. The payload calls option 2 the default, so answering the default here would UNtick it — the clearest single statement of why a checkbox list must not reach the single-select path',
    changesIn2755: true,
  },
  {
    frame: 'multiselect-space-untoggled-cursor-row',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'none',
    crop: false,
    pins: 'one `Space` later: option 2 is `[ ]` again. `Space` toggles the cursor row — but only once the list has reported a highlight (see the byte-identity note on `multiselect-two-checked`)',
    changesIn2755: true,
  },
  {
    frame: 'multiselect-free-text-focused',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'none',
    crop: false,
    pins: 'the `❯` on `5. [ ] Type something...`, the TextInput row. The free-text row is NUMBERED and carries a checkbox of its own in a multi-select',
    changesIn2755: true,
  },
  {
    frame: 'multiselect-free-text-typed',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'none',
    crop: false,
    pins: 'text typed into that row: the placeholder is gone AND the row\'s own box ticks ITSELF (`[✔] docs/api.md`) while the characters arrive. No Enter was pressed, and Enter there changes nothing at all',
    changesIn2755: true,
  },
  {
    frame: 'multiselect-free-text-digit-appended',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'none',
    crop: false,
    pins: 'a `1` sent while that row has focus lands IN THE TEXT (`docs/api.md1`) and toggles nothing. Quick-select is dead the moment the cursor leaves the list — the half of the free-text path #2755 has to get right',
    changesIn2755: true,
  },
  {
    frame: 'review-page-submit-cancel',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'none',
    crop: false,
    pins: 'Enter on `❯ Submit` does NOT submit: it opens a Review page — the answers, then `❯ 1. Submit` / `  2. Cancel` and `← to go back and edit`. A second confirm the send arm has to cross',
    changesIn2755: true,
  },
  {
    frame: 'review-page-unanswered-warning',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    hasActivePrompt: true,
    dialog: 'none',
    crop: false,
    pins: 'the same Review page reached by the UNDOCUMENTED `d`, which ends a multi-select from any row: `⚠ You have not answered all questions` over a `No answer`',
    changesIn2755: true,
  },

  // ---- the `❯` has left the list: the turn is published as finished -------
  {
    frame: 'multiselect-cursor-on-submit',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    hasActivePrompt: false,
    dialog: 'none',
    crop: false,
    pins: 'THE frame #2754 was raised for: `❯ Submit` — U+276F, one space, the word, no number and nothing else on the row. The option list has no cursor left, so the composer check answers on `❯ Submit` itself',
    changesIn2755: true,
  },
  {
    frame: 'multiselect-cursor-on-submit-no-footer',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    hasActivePrompt: false,
    dialog: 'none',
    crop: false,
    pins: 'the same `❯ Submit` on a ONE-question screen, where 1.54.1 draws no footer either. The worst shape on the tool: no footer, no `✔`, no cursor in the list, and a `ready` verdict',
    changesIn2755: true,
  },
  {
    frame: 'multiselect-up-from-option-1-lands-on-submit',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    hasActivePrompt: false,
    dialog: 'none',
    crop: false,
    pins: 'one `↑` from option 1 jumps straight to `❯ Submit`, skipping the free-text row — the shortest deterministic route to the confirm, and a third `ready` frame',
    changesIn2755: true,
  },
  {
    frame: 'multiselect-cursor-on-next',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    hasActivePrompt: false,
    dialog: 'none',
    crop: false,
    pins: '`❯ Next` — the same row on a question that is not the last one. The false completion is about the cursor leaving the list, not about the word `Submit`',
    changesIn2755: true,
  },
  {
    frame: 'multiselect-notes-row-open',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    hasActivePrompt: false,
    dialog: 'none',
    crop: false,
    pins: '`n` opened `❯ notes: Add notes on this design…` between the free-text row and `Submit`. The question is still up, the cursor has left the list, and the turn reads as finished — a false completion nobody had written down before this Issue',
    changesIn2755: true,
  },
  {
    frame: 'multiselect-submit-row-space-ticked-option-1',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    hasActivePrompt: false,
    dialog: 'none',
    crop: false,
    pins: 'one `Space` sent with the `❯` resting on `Submit` ticked OPTION 1 — a row the cursor is nowhere near. The visible cursor does not say which row `Space` will hit, which is why #2755 must not send it',
    changesIn2755: true,
  },

  // ---- the question is genuinely gone -------------------------------------
  {
    frame: 'not-applicable-question-cancelled',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    hasActivePrompt: false,
    dialog: 'none',
    crop: false,
    pins: 'one `Esc` on an option row took the whole tool call down — `└ User declined to answer questions` and a fresh composer. `ready` is CORRECT here, and that is what says the six `ready` rows above are not',
    changesIn2755: false,
  },
  {
    frame: 'not-applicable-chat-disposition',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    hasActivePrompt: false,
    dialog: 'none',
    crop: false,
    pins: 'one `c` closed the dialog with the answers given so far — `└ User wants to discuss the questions instead of answering`. `ready` is correct here too, and the key that got there is a bare letter with no confirmation',
    changesIn2755: false,
  },
  {
    frame: 'not-applicable-cancelled-from-notes-row',
    status: 'running',
    reason: STATUS_REASON.THINKING_INDICATOR,
    hasActivePrompt: false,
    dialog: 'none',
    crop: false,
    pins: 'one `Esc` sent with the `notes:` input open took the whole tool call down, not just the notes row. Caught mid-turn, so this one reads `running` — the third correct verdict in the directory, and the record of a key that removed a question while it was being measured',
    changesIn2755: false,
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

  it('recognises nothing whose tab strip carries a `✔`', () => {
    // The single-glyph finding, stated as an assertion rather than left in
    // prose. One direction only, and deliberately: a strip without `✔` is
    // NECESSARY for the region reading, not sufficient — the `❯` also has to be
    // on an option row, which is why the six `❯ Submit` / `❯ Next` / `❯ notes:`
    // frames below are unrecognised despite a clean strip. Those two conditions
    // are two different defects and #2755 has to close both.
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

    expect(withTick.length).toBeGreaterThan(0);
    for (const name of withTick) {
      expect(readCommandCodeQuestionDialog(frame(name)).kind, `${name} was recognised`).toBe(
        'none',
      );
    }
    // And every frame that IS recognised has a clean strip.
    for (const name of recognised) {
      expect(tabRowOf(frame(name))).not.toContain('✔');
    }
    expect(recognised).toHaveLength(7);
  });
});

describe('[#2754] the three failures #2755 has to close', () => {
  beforeEach(() => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'command-code=enforce';
  });
  afterEach(() => {
    delete process.env[IDLE_EVIDENCE_ENV_VAR];
  });

  it('calls six live question screens finished turns', () => {
    // The `wait` consequence, said once rather than read out of the table: on
    // each of these a human is looking at an unanswered question and
    // `commandmate wait` exits 0.
    const falselyFinished = EXPECTATIONS.filter((e) => e.status === 'ready' && e.changesIn2755).map(
      (e) => e.frame,
    );

    expect(falselyFinished.sort()).toEqual([
      'multiselect-cursor-on-next',
      'multiselect-cursor-on-submit',
      'multiselect-cursor-on-submit-no-footer',
      'multiselect-notes-row-open',
      'multiselect-submit-row-space-ticked-option-1',
      'multiselect-up-from-option-1-lands-on-submit',
    ]);

    for (const name of falselyFinished) {
      const result = detectSessionStatus(frame(name), 'command-code');
      expect(result.status).toBe('ready');
      expect(result.hasActivePrompt).toBe(false);
    }
  });

  it('hands a checkbox list to the single-select answer path', () => {
    // `unsupported-multi-select-checkboxes` (#2522) states that a digit TOGGLES
    // a box, so a single-select payload would report an answer that ticked
    // something and stopped. That frame is 1.53.0-shaped; this one is 1.54.1's,
    // and the guard does not reach it — the labels arrive with the box still
    // attached, which is the cheapest possible proof of where they came from.
    const result = detectSessionStatus(frame('multiselect-initial'), 'command-code');
    const data = result.promptDetection?.promptData;
    expect(isMultipleChoicePrompt(data)).toBe(true);
    if (!isMultipleChoicePrompt(data)) return;

    expect(data.options.map((o) => o.label)).toEqual([
      '[ ] calc.js',
      '[ ] README.md',
      '[ ] docs',
      '[ ] tests',
      '[ ] Type something...',
    ]);
    expect(data.options.find((o) => o.isDefault)?.number).toBe(1);
  });

  it('makes the default answer an UNtick when the cursor sits on a ticked box', () => {
    // The same payload one `↓` later. `isDefault` follows the `❯`, the `❯` is on
    // a `[✔]` row, and a digit toggles — so `respond --default` would remove an
    // answer the human had already given.
    const result = detectSessionStatus(frame('multiselect-cursor-on-option-2'), 'command-code');
    const data = result.promptDetection?.promptData;
    expect(isMultipleChoicePrompt(data)).toBe(true);
    if (!isMultipleChoicePrompt(data)) return;

    const chosen = data.options.find((o) => o.isDefault);
    expect(chosen?.number).toBe(2);
    expect(chosen?.label).toBe('[✔] README.md');
  });

  it('folds the new 1.54.1 footer into the last option of the frame it CAN read', () => {
    // The third failure, and the one that is easiest to miss because the reading
    // "works": 1.53.0 drew nothing under the last option, so the tail walk had
    // nothing to fold. 1.54.1 draws the hint bar there.
    const reading = readCommandCodeQuestionDialog(frame('singleselect-initial-unanswered-tabs'));
    expect(reading.kind).toBe('prompt');
    if (reading.kind !== 'prompt') return;

    const data = reading.prompt.promptData;
    expect(isMultipleChoicePrompt(data)).toBe(true);
    if (!isMultipleChoicePrompt(data)) return;

    expect(data.options).toHaveLength(4);
    expect(data.options[3]?.label).toBe(
      'Type something... Enter to select | Arrow keys to navigate | 1-9 quick select | n notes | c chat | Esc to cancel',
    );
  });

  it('leaves 1.53.0-shaped multi-selects on the fallback they were given', () => {
    // The half that says #2754 widened nothing: with no `✔` on the strip, the
    // #2521 / #2522 reading still declines a checkbox screen the way it was
    // written to. Only the answered-tab glyph moved.
    const reading = readCommandCodeQuestionDialog(frame('tabs-single-question'));
    expect(reading.kind).toBe('unsupported');
    if (reading.kind === 'unsupported') expect(reading.reason).toBe('multi-select');
  });
});
