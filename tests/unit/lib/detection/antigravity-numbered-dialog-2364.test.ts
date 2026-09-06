/**
 * Antigravity's numbered dialogs reach yes/no on both paths the Issue measured
 * (Issue #2364), pinned to live agy 1.1.27 frames.
 *
 * The frames are `tests/fixtures/antigravity-live-2364/` (see its README for
 * provenance and redaction). Two of them are the Issue:
 *
 *  - path 1, `dialog-create-file.txt`: `Allow creation of this file?` over two
 *    options. #2270's discriminator was the sentence `Do you want to proceed?`,
 *    so this resolved as `antigravity_selection_list` / `hasActivePrompt: false`
 *    and the chat surface drew an arrow pad instead of a yes/no panel.
 *  - path 2, `dialog-bash-wrapped.txt`: `Do you want to proceed?` over four
 *    options of which two wrap onto three rows. This passed the discriminator,
 *    failed in the one-row-per-option generic parser, and the `esc to cancel`
 *    status row then matched the thinking pattern: `running` /
 *    `thinking_indicator`, "generating", and `wait` never returning.
 *
 * The rest of the directory is the control group: the pickers and popups that
 * must keep the #995 reading, the idle frames, and `/feedback`'s digit menu
 * which has no `↑/↓ Navigate` footer and stays with the generic parser.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_SELECTION_LIST_PATTERN,
  ANTIGRAVITY_SURVEY_PATTERN,
  isAntigravityNumberedDialog,
  locateAntigravityDialogRegion,
  stripAnsi,
  stripBoxDrawing,
} from '@/lib/detection/cli-patterns';
import {
  detectSessionStatus,
  SELECTION_LIST_REASONS,
  STATUS_REASON,
} from '@/lib/detection/status-detector';
import {
  detectAntigravityNumberedDialogPrompt,
  readAntigravityNumberedDialog,
} from '@/lib/detection/tools/antigravity/dialog';
import { ANTIGRAVITY_VERIFIED_AGAINST } from '@/lib/detection/tools/verified-against';
import { isUnclassifiedFrame } from '@/lib/session/status-evidence';
import type { MultipleChoicePromptData } from '@/types/models';

const FIXTURE_DIR = path.resolve(__dirname, '../../../fixtures/antigravity-live-2364');

const frame = (name: string): string => readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');

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
    widest = Math.max(widest, Array.from(stripAnsi(row).replace(/\r$/, '')).length);
  }
  return widest;
}

/** The status verdict's prompt, asserted to be the numbered kind. */
function multipleChoiceOf(raw: string): MultipleChoicePromptData {
  const result = detectSessionStatus(raw, 'antigravity');
  const promptData = result.promptDetection.promptData;
  if (promptData?.type !== 'multiple_choice') {
    throw new Error(`expected multiple_choice, got ${JSON.stringify(promptData?.type ?? null)} (${result.reason})`);
  }
  return promptData;
}

/** What the response poller reads: ANSI and box drawing already removed. */
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

const NUMBERED_DIALOGS = [
  'dialog-create-file',
  'dialog-create-file-highlight-2',
  'dialog-bash-oneline',
  'dialog-bash-wrapped',
  'dialog-bash-wrapped-highlight-4',
  'dialog-bash-wrapped-six',
] as const;

const SELECTION_LISTS = ['picker-switch-model', 'trust-dialog', 'popup-slash-commands'] as const;

// ---------------------------------------------------------------------------
// The fixtures themselves
// ---------------------------------------------------------------------------

describe('[#2364] the agy 1.1.27 frames are production-geometry captures', () => {
  const names = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.txt')).sort();

  it('holds every frame the suites below read', () => {
    expect(names).toEqual([
      'boot-idle.txt',
      'dialog-bash-oneline.txt',
      'dialog-bash-wrapped-highlight-4.txt',
      'dialog-bash-wrapped-six.txt',
      'dialog-bash-wrapped.txt',
      'dialog-create-file-highlight-2.txt',
      'dialog-create-file.txt',
      'dialog-feedback-category.txt',
      'idle-after-deny.txt',
      'picker-switch-model.txt',
      'popup-slash-commands.txt',
      'survey-after-deny.reconstructed.txt',
      'trust-dialog.txt',
    ]);
  });

  it.each(names)('%s is 200 columns by 1000 rows', (name) => {
    const raw = readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
    // agy is top-anchored: the dialog sits in the first ~30 rows and the pane's
    // remaining rows are blank padding. Both numbers are what the server
    // captures (`ANTIGRAVITY_VERIFIED_AGAINST.paneGeometry`), and a fixture at
    // any other size exercises a different `lastLines` window than production.
    expect(rowsOf(raw)).toHaveLength(1000);
    // agy's status row stops one column short of the pane edge (199); only its
    // full-width rules reach 200, and two frames draw none — the trust screen
    // precedes the composer, and the survey replaces it.
    const columns = columnsOf(raw);
    expect(columns).toBeGreaterThanOrEqual(199);
    expect(columns).toBeLessThanOrEqual(200);
  });

  it.each(names.filter((name) => !name.includes('reconstructed')))('%s keeps its ANSI', (name) => {
    expect(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')).toContain('\x1b[');
  });

  it('is what the antigravity rules are stamped as measured against', () => {
    expect(ANTIGRAVITY_VERIFIED_AGAINST).toEqual({
      version: '1.1.27',
      capturedAt: '2026-09-06',
      paneGeometry: '200x1000',
    });
    // The banner on every capture names the build the stamp claims. The trust
    // screen is drawn before the banner, so it is the one frame without it.
    for (const name of names) {
      const text = stripAnsi(readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
      if (name === 'trust-dialog.txt') {
        expect(text).toContain('Antigravity CLI requires permission');
        continue;
      }
      expect(text, name).toContain('Antigravity CLI 1.1.27');
    }
  });
});

// ---------------------------------------------------------------------------
// Path 1: the file-creation menu
// ---------------------------------------------------------------------------

describe('[#2364] path 1 — `Allow creation of this file?` is an answerable prompt', () => {
  it('reads the pane as waiting on a two-option multiple_choice prompt', () => {
    const result = detectSessionStatus(frame('dialog-create-file'), 'antigravity');

    expect(result.status).toBe('waiting');
    expect(result.hasActivePrompt).toBe(true);
    expect(result.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(result.evidence).toBe('positive');
    // The reading the Issue measured: `antigravity_selection_list`, which is
    // what put an arrow pad on the chat surface instead of PromptPanel.
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(false);

    const promptData = multipleChoiceOf(frame('dialog-create-file'));
    expect(promptData.options).toHaveLength(2);
    expect(promptData.options.map((o) => o.number)).toEqual([1, 2]);
    expect(promptData.options[0].label).toBe('Yes, allow creation');
    expect(promptData.options[1].label).toBe('No, deny creation');
    expect(promptData.status).toBe('pending');
  });

  it('keeps the question to the one `?` row and moves the diff preview to instructionText', () => {
    // The generic parser joined five rows into the question:
    // `…hello-agy.txt +1 1 + hello from antigravity Allow creation of this file?`.
    // That string is what the push notification quotes and what PromptPanel
    // shows as the heading.
    const promptData = multipleChoiceOf(frame('dialog-create-file'));

    expect(promptData.question).toBe('Allow creation of this file?');
    expect(promptData.instructionText).toContain('Create file');
    expect(promptData.instructionText).toContain('hello-agy.txt  +1');
    expect(promptData.instructionText).toContain('1 +  hello from antigravity');
    expect(promptData.instructionText).toContain('Allow creation of this file?');
    // Issue #1699's deny-pattern surface sees the file the prompt is about.
    expect(promptData.approvalTarget).toContain('hello-agy.txt');
    expect(promptData.approvalTarget).toContain('No, deny creation');
  });

  it('marks the highlighted row as the default, and follows the `>` when it moves', () => {
    const initial = multipleChoiceOf(frame('dialog-create-file'));
    expect(initial.options.map((o) => o.isDefault)).toEqual([true, false]);

    // One `Down` later the gutter sits on `2. No, deny creation`. The answer
    // sender computes its arrow-key offset from this flag (Issue #999), so a
    // stale default would send the operator's "No" to "Yes".
    const moved = multipleChoiceOf(frame('dialog-create-file-highlight-2'));
    expect(moved.options.map((o) => o.isDefault)).toEqual([false, true]);
    expect(moved.question).toBe(initial.question);
    expect(moved.options.map((o) => o.label)).toEqual(initial.options.map((o) => o.label));
  });
});

// ---------------------------------------------------------------------------
// Path 2: the Bash approval whose labels wrap
// ---------------------------------------------------------------------------

describe('[#2364] path 2 — wrapped option labels are folded, never "generating"', () => {
  it('reads the pane as waiting on a four-option prompt, not running/thinking_indicator', () => {
    const result = detectSessionStatus(frame('dialog-bash-wrapped'), 'antigravity');

    // The worst outcome the Issue names: the `esc to cancel` status row is on
    // every agy dialog, and it is also the thinking pattern.
    expect(result.status).not.toBe('running');
    expect(result.reason).not.toBe(STATUS_REASON.THINKING_INDICATOR);

    expect(result.status).toBe('waiting');
    expect(result.hasActivePrompt).toBe(true);
    expect(result.reason).toBe(STATUS_REASON.PROMPT_DETECTED);

    const promptData = multipleChoiceOf(frame('dialog-bash-wrapped'));
    expect(promptData.question).toBe('Do you want to proceed?');
    expect(promptData.options).toHaveLength(4);
    expect(promptData.options.map((o) => o.number)).toEqual([1, 2, 3, 4]);
    expect(promptData.options[0].label).toBe('Yes');
    expect(promptData.options[3].label).toBe('No');
  });

  it('folds the continuation rows into labels 2 and 3', () => {
    const promptData = multipleChoiceOf(frame('dialog-bash-wrapped'));
    const [, two, three] = promptData.options;

    // The rows agy drew under `2.` and `3.`: the command's second and third
    // lines, indented under nothing, which the generic parser refused as
    // "a non-option row inside the run".
    for (const label of [two.label, three.label]) {
      expect(label).toContain("commands that start with 'python3 -c \"import platform, sys");
      expect(label).toContain('# Probe the interpreter for the report');
      expect(label).toContain("print(p...'");
    }
    expect(two.label.startsWith('Yes, and always allow in this conversation')).toBe(true);
    expect(three.label.startsWith('Yes, and always allow for commands')).toBe(true);
    expect(three.label.endsWith('(Persist to settings.json)')).toBe(true);
    // Nothing of one label leaked into the next.
    expect(two.label).not.toContain('Persist to settings.json');
    expect(promptData.options[3].label).toBe('No');
  });

  it('carries the requested command into instructionText and approvalTarget', () => {
    const promptData = multipleChoiceOf(frame('dialog-bash-wrapped'));
    expect(promptData.instructionText).toContain('Requesting permission for:');
    expect(promptData.instructionText).toContain('python3 -c "import platform, sys');
    expect(promptData.instructionText).toContain('⋯ (1 lines hidden)');
    expect(promptData.approvalTarget).toContain('Requesting permission for:');
    expect(promptData.approvalTarget).toContain('print(platform.python_version())');
  });

  it('follows the `>` to option 4 after three Downs', () => {
    const moved = multipleChoiceOf(frame('dialog-bash-wrapped-highlight-4'));
    expect(moved.options.map((o) => o.isDefault)).toEqual([false, false, false, true]);
    expect(moved.options.map((o) => o.label)).toEqual(
      multipleChoiceOf(frame('dialog-bash-wrapped')).options.map((o) => o.label),
    );
  });

  it('folds the LAST option too when it wraps (the six-option repeat-denial menu)', () => {
    // After a denial of the same command agy offers six options, and the last
    // two — `No, and always deny …` — wrap onto three rows each. The rows under
    // the bottom option sit between it and the footer, where the shared block
    // reader files them as "footer"; the agy reader hands them back to option 6.
    const promptData = multipleChoiceOf(frame('dialog-bash-wrapped-six'));
    expect(promptData.question).toBe('Do you want to proceed?');
    expect(promptData.options.map((o) => o.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(promptData.options[3].label).toBe('No');
    expect(promptData.options[4].label.startsWith('No, and always deny for commands')).toBe(true);
    expect(promptData.options[4].label.endsWith('in this conversation')).toBe(true);
    expect(promptData.options[5].label.startsWith('No, and always deny for commands')).toBe(true);
    expect(promptData.options[5].label).toContain('# Probe the interpreter for the report');
    expect(promptData.options[5].label.endsWith('(Persist to settings.json)')).toBe(true);
    // The footer is not part of any label.
    for (const option of promptData.options) {
      expect(option.label).not.toContain('Navigate');
    }
  });

  it('still reads the one-row variant #2270 measured, now on 1.1.27', () => {
    const promptData = multipleChoiceOf(frame('dialog-bash-oneline'));
    expect(promptData.question).toBe('Do you want to proceed?');
    expect(promptData.options.map((o) => o.number)).toEqual([1, 2, 3, 4]);
    expect(promptData.options[3].label).toBe('No');
    // #2270's reading joined `Command Requesting permission for: … Do you want
    // to proceed?` into the question; the panel header is context, not the ask.
    expect(promptData.question).not.toContain('Requesting permission');
  });
});

// ---------------------------------------------------------------------------
// The discriminator is structural
// ---------------------------------------------------------------------------

describe('[#2364] isAntigravityNumberedDialog keys on structure, not on the question', () => {
  it.each(NUMBERED_DIALOGS)('%s is a numbered dialog', (name) => {
    const text = asPollerSees(frame(name));
    expect(ANTIGRAVITY_SELECTION_LIST_PATTERN.test(text)).toBe(true);
    expect(isAntigravityNumberedDialog(text)).toBe(true);
    // Both spellings — the status path reads the frame with its rules intact.
    expect(isAntigravityNumberedDialog(stripAnsi(frame(name)))).toBe(true);
  });

  it.each(SELECTION_LISTS)('%s is not (unnumbered rows under the same footer)', (name) => {
    const text = asPollerSees(frame(name));
    // Every one of these matches the selection-list pattern — that is the
    // whole problem — so the assertion that matters is the discriminator.
    expect(ANTIGRAVITY_SELECTION_LIST_PATTERN.test(text)).toBe(true);
    expect(isAntigravityNumberedDialog(text)).toBe(false);
    expect(readAntigravityNumberedDialog(text.split('\n'))).toBeNull();
  });

  it('is not `/feedback`, whose numbered rows sit under a `1-6 Select` footer with no `↑/↓ Navigate`', () => {
    const text = asPollerSees(frame('dialog-feedback-category'));
    expect(isAntigravityNumberedDialog(text)).toBe(false);
    expect(detectAntigravityNumberedDialogPrompt(text)).toBeNull();
    // Which leaves it with the generic parser, exactly as before this Issue.
    const result = detectSessionStatus(frame('dialog-feedback-category'), 'antigravity');
    expect(result.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(result.promptDetection.promptData?.type).toBe('multiple_choice');
  });

  it('does not count a numbered list in the transcript above an open popup', () => {
    // The model's own reply ends in `1. / 2.`, then the user opens the slash
    // popup. The popup rows start with `>` and are not numbered, so they bound
    // the block: nothing above them can be its options.
    const text = [
      '> what are my options',
      '',
      '  Two ways forward:',
      '  1. Keep the branch',
      '  2. Rebase onto develop',
      '',
      '────────────────────────────────────────',
      '> /',
      '────────────────────────────────────────',
      '> /add-dir              Add a directory to the workspace',
      '  /agents               List available custom agents',
      '  ↑/↓ Navigate · enter Select · tab Complete',
      'esc to cancel',
    ].join('\n');

    expect(isAntigravityNumberedDialog(text)).toBe(false);
    expect(detectAntigravityNumberedDialogPrompt(text)).toBeNull();
    const result = detectSessionStatus(text, 'antigravity');
    expect(result.reason).toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('locates the block between the nearest boundary row and the footer', () => {
    const lines = asPollerSees(frame('dialog-create-file')).split('\n');
    const region = locateAntigravityDialogRegion(lines);
    expect(region).not.toBeNull();
    expect(lines[region!.footer]).toContain('↑/↓ Navigate');
    // The `● Create(…)` tool row is the boundary once `stripBoxDrawing` has
    // blanked the rule under `Create file`; everything below it is the panel.
    expect(lines[region!.start - 1]).toMatch(/^● Create\(/);
    expect(lines.slice(region!.start, region!.footer).join('\n')).toContain('Allow creation of this file?');
  });
});

// ---------------------------------------------------------------------------
// A numbered dialog the reader cannot parse is unclassified, never generating
// ---------------------------------------------------------------------------

describe('[#2364] an unreadable numbered dialog is published as an unclassified frame', () => {
  /** The wrapped dialog with its `> 1. Yes` row unnumbered: two+ numbered rows remain, no run to `1.`. */
  const withoutOptionOne = (): string => {
    const raw = frame('dialog-bash-wrapped');
    const mutated = raw.replace('> 1. Yes', '> Yes');
    if (mutated === raw) throw new Error('mutation did not apply — the fixture no longer draws `> 1. Yes`');
    return mutated;
  };

  it('passes the discriminator and fails the reader', () => {
    const text = asPollerSees(withoutOptionOne());
    expect(isAntigravityNumberedDialog(text)).toBe(true);
    expect(detectAntigravityNumberedDialogPrompt(text)).toBeNull();
  });

  it('is running / unknown_frame — the hatch opens and `wait` stops — not thinking_indicator', () => {
    const result = detectSessionStatus(withoutOptionOne(), 'antigravity');

    expect(result.reason).toBe(STATUS_REASON.UNKNOWN_FRAME);
    expect(result.status).toBe('running');
    expect(result.evidence).toBe('none');
    expect(result.hasActivePrompt).toBe(false);
    expect(isUnclassifiedFrame(result.status, result.reason)).toBe(true);
    // The reading the Issue forbids for any frame that passed the discriminator.
    expect(result.reason).not.toBe(STATUS_REASON.THINKING_INDICATOR);
    // And not a picker either: the arrow pad would Enter whatever is highlighted.
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The control group keeps its readings
// ---------------------------------------------------------------------------

describe('[#2364] the pickers and the idle frames read as before', () => {
  it.each(SELECTION_LISTS)('%s stays a selection list (#995)', (name) => {
    const result = detectSessionStatus(frame(name), 'antigravity');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(true);
    expect(result.promptDetection.isPrompt).toBe(false);
  });

  it.each(['boot-idle', 'idle-after-deny'] as const)('%s is ready / input_prompt', (name) => {
    const result = detectSessionStatus(frame(name), 'antigravity');
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('still reads generating from the `esc to cancel` footer when no dialog is open', () => {
    const output = [
      '  Generating a response for you',
      '────────────────────────────',
      '> ',
      '⠉ esc to cancel',
    ].join('\n');
    const result = detectSessionStatus(output, 'antigravity');
    expect(result.status).toBe('running');
    expect(result.reason).toBe(STATUS_REASON.THINKING_INDICATOR);
  });
});

// ---------------------------------------------------------------------------
// The post-answer survey
// ---------------------------------------------------------------------------

describe('[#2364] the `[1] Good … [0] Skip` survey is waiting, not generating', () => {
  it('matches the survey row and nothing near it', () => {
    expect(ANTIGRAVITY_SURVEY_PATTERN.test(' [1] Good  [2] Fine  [3] Bad  [0] Skip')).toBe(true);
    expect(ANTIGRAVITY_SURVEY_PATTERN.test("How's the CLI experience so far? Help us improve:")).toBe(false);
    expect(ANTIGRAVITY_SURVEY_PATTERN.test('  1. Good')).toBe(false);
    // Prose that quotes the row mid-sentence is not the row.
    expect(ANTIGRAVITY_SURVEY_PATTERN.test('it showed [1] Good  [2] Fine  [3] Bad  [0] Skip and I typed 0')).toBe(false);
  });

  it('publishes the reconstructed survey pane as a selection list', () => {
    const result = detectSessionStatus(frame('survey-after-deny.reconstructed'), 'antigravity');

    // Before: `running` / `default` — the composer is gone, so nothing matched,
    // and the chat surface said "generating" over a screen waiting for `0`.
    expect(result.status).not.toBe('running');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(true);
    expect(result.hasActivePrompt).toBe(false);
    expect(result.evidence).toBe('positive');
  });

  it('does not fire on a survey row left in the scrollback once the composer is back', () => {
    // agy retains scrollback. The guard is positional: the row counts only
    // while nothing below it is the composer.
    const dismissed = [
      '  ⎿  User declined the tool call',
      '',
      " How's the CLI experience so far? Help us improve:",
      ' [1] Good  [2] Fine  [3] Bad  [0] Skip',
      '',
      '────────────────────────────────────────',
      '>',
      '────────────────────────────────────────',
      '? for shortcuts                          Gemini 3.8 Flash · high',
    ].join('\n');
    const result = detectSessionStatus(dismissed, 'antigravity');
    expect(result.reason).not.toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
    expect(result.status).toBe('ready');
  });
});
