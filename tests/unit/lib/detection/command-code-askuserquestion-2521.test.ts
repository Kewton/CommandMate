/**
 * Command Code's footer-less question screen (Issue #2521).
 *
 * ## The defect, stated as the reading it produced
 *
 * `AskUserQuestion` draws a rule, a tab strip, the question and a numbered list
 * — and no hint-bar footer. When an option's description wraps, the
 * continuation row starts with a SINGLE space (` answer).`), the shared
 * multiple-choice parser ends its scan there one row short of option 1, and the
 * frame reached the generic composer check. `COMMAND_CODE_PROMPT_PATTERN` is
 * `^❯(\s*$|\s+\S)`, the dialog's own cursor row is `❯ 1. Prepare worktrees …`,
 * and the pane was therefore published as:
 *
 *     ready / input_prompt / hasActivePrompt:false
 *
 * which `wait` reads as a finished turn. Measured on 2026-09-12 on a pane
 * reported as Command Code 1.53.0 at 200x1000; the anonymised capture is
 * `tests/fixtures/command-code-askuserquestion-2521/`, whose README records what
 * was replaced.
 *
 * ## What is asserted, and what would be vacuous
 *
 * Every positive case is anchored on a FRAME, and every negative case is a
 * frame that differs from the positive one in ONE respect — a missing number, a
 * second cursor, a short rule, no tab strip. A suite that only asserted the
 * positive would pass against "footer-less means crop and wait", which is the
 * reading Issue #2521 refuses: the cropper runs for every CLI with no tool id in
 * hand, so a loose rule would start trimming other tools' dialogs.
 *
 * The last block is the positive control — the pre-#2521 answer on the same
 * bytes — spelled out so the assertions above cannot pass on a fixture that
 * never reproduced the defect.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SELECTION_LIST_REASONS,
  STATUS_REASON,
  detectSessionStatus,
} from '@/lib/detection/status-detector';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import {
  extractCommandCodeSelectionListFrame,
  readCommandCodeQuestionRegion,
  readSelectionListShape,
  shouldOfferOptionNumbers,
} from '@/lib/detection/selection-shape';
import { stripAnsi } from '@/lib/detection/ansi';
import { isUnclassifiedFrame } from '@/lib/session/status-evidence';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/command-code-askuserquestion-2521');
const LIVE_DIR = path.resolve(__dirname, '../../../fixtures/command-code-live-2250');
const CARD_DIR = path.resolve(__dirname, '../../../fixtures/chat-dialog-card-2254');

const read = (dir: string, name: string): string =>
  fs.readFileSync(path.join(dir, name), 'utf-8');

/** The Issue's minimal example: the same rows, no ANSI, 24 rows of pane. */
const MINIMAL = read(FIXTURES, 'askuserquestion-wrapped-minimal.txt');
/** The 200x1000 capture: 409 rows of transcript, the dialog, 577 rows of padding. */
const LIVE_200X1000 = read(FIXTURES, 'askuserquestion-wrapped-1530-200x1000.txt');

const POSITIVES: readonly [string, string][] = [
  ['minimal', MINIMAL],
  ['200x1000', LIVE_200X1000],
];

/** The rule row Command Code draws above a dialog: 200 columns of U+2500. */
const RULE = '─'.repeat(200);

/**
 * The dialog's own rows, as plain text, for the derived cases below.
 *
 * Built here rather than read from the fixture so a mutation is one edited
 * entry, visible at the call site, rather than a regex over a capture.
 */
function questionScreen(
  options: {
    tabs?: string;
    question?: string;
    rows?: readonly string[];
    rule?: string;
    transcript?: readonly string[];
    padding?: number;
  } = {},
): string {
  const lines = [
    ...(options.transcript ?? [
      '# Command Code v1.53.0',
      '',
      '⠶ Here is the plan. I will wait for your decision.',
      '',
    ]),
    options.rule ?? RULE,
    '',
    options.tabs ?? '● Dispatch | ◯ Review',
    '',
    options.question ?? 'Approve proceeding from the plan into worktree creation and dispatch?',
    '',
    ...(options.rows ?? [
      '❯ 1. Prepare worktrees + dispatch (Recommended)',
      '     I create the worktrees and pause for you to',
      ' answer).',
      '  2. Worktrees only, then pause',
      '     I create the worktrees and stop for inspection.',
      '  3. Stop at the plan',
      '     No worktrees, no workers.',
      '  4. Type something...',
    ]),
  ];
  for (let i = 0; i < (options.padding ?? 0); i += 1) lines.push('');
  return lines.join('\n');
}

// ===========================================================================
// A. The region reading
// ===========================================================================

describe('[#2521] A. the region is read from the last rule to the last content row', () => {
  it.each(POSITIVES)('%s: the rule bounds it above and is not part of it', (_name, frame) => {
    const region = readCommandCodeQuestionRegion(frame);
    expect(region).not.toBeNull();
    const lines = stripAnsi(frame).split('\n');
    expect(lines[region!.ruleLineIndex].trim()).toBe(RULE);
    expect(region!.firstLineIndex).toBe(region!.ruleLineIndex + 1);
  });

  it.each(POSITIVES)('%s: the bottom edge is the last row with content', (_name, frame) => {
    const region = readCommandCodeQuestionRegion(frame);
    const lines = stripAnsi(frame).split('\n');
    expect(lines[region!.lastLineIndex].trim()).toBe('4. Type something...');
    // Everything after it is the pane's padding, and none of it is in the region.
    expect(lines.slice(region!.lastLineIndex + 1).every((line) => line.trim() === '')).toBe(true);
  });

  it.each(POSITIVES)('%s: the tab strip opens it and the cursor is on option 1', (_name, frame) => {
    const region = readCommandCodeQuestionRegion(frame);
    const lines = stripAnsi(frame).split('\n');
    expect(lines[region!.tabLineIndex].trim()).toBe('● Dispatch | ◯ Review');
    expect(lines[region!.cursorLineIndex]).toContain('❯ 1. Prepare worktrees');
    expect(region!.optionCount).toBe(4);
  });

  it('the 200x1000 capture is the production geometry', () => {
    // The whole defect is about where the dialog sits on a pane that is mostly
    // padding, so a fixture that was not captured at 200x1000 would not be
    // reproducing it.
    const lines = LIVE_200X1000.replace(/\n$/, '').split('\n');
    expect(lines).toHaveLength(1000);
    const region = readCommandCodeQuestionRegion(LIVE_200X1000)!;
    expect(region.ruleLineIndex).toBe(409); // 0-based: row 410 of the pane
    expect(region.lastLineIndex).toBe(422);
  });

  it('reads the same region through ANSI and through CRLF', () => {
    // The live capture carries per-row SGR and the rule row is `ESC[38;2;…m`
    // followed by 200 glyphs with no reset; a reading that stripped nothing
    // would measure the escape into the rule's width.
    const crlf = LIVE_200X1000.replace(/\n/g, '\r\n');
    expect(readCommandCodeQuestionRegion(crlf)).toEqual(
      readCommandCodeQuestionRegion(LIVE_200X1000),
    );
  });

  it('reads a description that is taller than both detection windows', () => {
    // `lastLines` is 15 rows and `SELECTION_SHAPE_TAIL_LINE_COUNT` is 40. A
    // description long enough to push the tab strip past either one is the case
    // the region — which runs from the rule, not from the tail — exists for.
    const wrapped = Array.from({ length: 45 }, (_, i) => `     description row ${i + 1}`);
    const frame = questionScreen({
      rows: [
        '❯ 1. Prepare worktrees + dispatch (Recommended)',
        ...wrapped,
        ' answer).',
        '  2. Worktrees only, then pause',
        '  3. Stop at the plan',
        '  4. Type something...',
      ],
      padding: 600,
    });

    const region = readCommandCodeQuestionRegion(frame);
    expect(region).not.toBeNull();
    expect(region!.optionCount).toBe(4);
  });

  it('reads a top-anchored pane whose content ends 30 rows in', () => {
    const frame = questionScreen({ padding: 970 });
    expect(readCommandCodeQuestionRegion(frame)?.optionCount).toBe(4);
  });
});

// ===========================================================================
// B. What the reading must decline
// ===========================================================================

describe('[#2521] B. the reading declines everything it was not measured on', () => {
  it('declines an ordinary numbered answer with no tab strip', () => {
    // The reason `optionCount >= 2` is not the test: an assistant answering in
    // a numbered list draws exactly that, under the same rule row.
    const frame = questionScreen({
      tabs: '● first point',
      question: 'Here are the three things I changed:',
      rows: ['  1. renamed the field', '  2. updated the test', '  3. rebuilt the CLI'],
    });
    expect(readCommandCodeQuestionRegion(frame)).toBeNull();
  });

  it('declines a bullet list that happens to carry a pipe', () => {
    expect(readCommandCodeQuestionRegion(questionScreen({ tabs: '● one | ● two' }))).toBeNull();
  });

  it('declines a tab strip with nothing between it and the options', () => {
    const frame = [
      RULE,
      '● Dispatch | ◯ Review',
      '❯ 1. Prepare worktrees',
      '  2. Stop at the plan',
    ].join('\n');
    expect(readCommandCodeQuestionRegion(frame)).toBeNull();
  });

  it('declines a missing number, a repeat and a list that starts at 2', () => {
    const cases = [
      ['❯ 1. one', '  2. two', '  4. four'],
      ['❯ 1. one', '  2. two', '  2. two again'],
      ['❯ 2. two', '  3. three'],
    ];
    for (const rows of cases) {
      expect(readCommandCodeQuestionRegion(questionScreen({ rows })), rows.join('/')).toBeNull();
    }
  });

  it('declines a single option', () => {
    expect(readCommandCodeQuestionRegion(questionScreen({ rows: ['❯ 1. only one'] }))).toBeNull();
  });

  it('reads a screen with more than nine options as its first nine', () => {
    // `MAX_OPTION_NUMBER` is the ceiling, and it is the option pattern's single
    // captured digit rather than a length check: `  10. option 10` is not an
    // option row at all. Under-counting such a screen is the deliberate failure —
    // the count draws nothing on this frame (Issue #2521 suppresses the number
    // row), while declining the screen would hand the pane back its `ready`.
    const ten = Array.from({ length: 10 }, (_, i) => `  ${i + 1}. option ${i + 1}`);
    ten[0] = '❯ 1. option 1';
    expect(readCommandCodeQuestionRegion(questionScreen({ rows: ten }))?.optionCount).toBe(9);
  });

  it('declines no cursor and two cursors', () => {
    expect(
      readCommandCodeQuestionRegion(
        questionScreen({ rows: ['  1. one', '  2. two', '  3. three'] }),
      ),
    ).toBeNull();
    expect(
      readCommandCodeQuestionRegion(
        questionScreen({ rows: ['❯ 1. one', '  2. two', '❯ 3. three'] }),
      ),
    ).toBeNull();
  });

  it('declines a cursor that is not on an option row', () => {
    // An idle composer redrawn under the dialog is the shape this covers.
    expect(
      readCommandCodeQuestionRegion(
        questionScreen({ rows: ['  1. one', '  2. two', '', '❯ Ask your question...'] }),
      ),
    ).toBeNull();
  });

  it('declines a rule too short to be the seam', () => {
    expect(readCommandCodeQuestionRegion(questionScreen({ rule: '─'.repeat(39) }))).toBeNull();
    expect(readCommandCodeQuestionRegion(questionScreen({ rule: '─'.repeat(40) }))).not.toBeNull();
  });

  it('declines options that live only above the rule', () => {
    const frame = [
      '● Dispatch | ◯ Review',
      '',
      'Approve proceeding?',
      '',
      '❯ 1. Prepare worktrees',
      '  2. Stop at the plan',
      '',
      RULE,
      '❯ Ask your question...',
      RULE,
      '  ? for shortcuts · taste on',
    ].join('\n');
    expect(readCommandCodeQuestionRegion(frame)).toBeNull();
  });

  it('declines the old question once a new composer is painted under it', () => {
    // The LAST qualifying rule is the composer's lower one, so the region is the
    // hint row — which is why a dialog that has already been answered cannot be
    // resurrected by this reading.
    const answered = [
      questionScreen(),
      '',
      RULE,
      '❯ Ask your question...',
      RULE,
      '  ? for shortcuts · taste on',
      '',
    ].join('\n');
    expect(readCommandCodeQuestionRegion(answered)).toBeNull();
  });

  it('declines a region that carries another turn’s generating or done UI', () => {
    for (const row of [' ⌘ Planning…  esc to interrupt • 4s', '✻ Worked for 4s']) {
      const frame = questionScreen({ rows: ['❯ 1. one', '  2. two', row] });
      expect(readCommandCodeQuestionRegion(frame), row).toBeNull();
    }
  });

  it('declines the search and picker screens the other branches own', () => {
    for (const footer of [
      '› Type to search models...',
      'type to search · ↑/↓ navigate · enter to select · esc to cancel',
      'Press Esc to close',
    ]) {
      const frame = questionScreen({
        rows: ['❯ 1. one', '  2. two', '  3. three', footer],
      });
      expect(readCommandCodeQuestionRegion(frame), footer).toBeNull();
    }
  });

  it('declines an empty frame and one with no content at all', () => {
    expect(readCommandCodeQuestionRegion('')).toBeNull();
    expect(readCommandCodeQuestionRegion(null)).toBeNull();
    expect(readCommandCodeQuestionRegion(undefined)).toBeNull();
    expect(readCommandCodeQuestionRegion(`${RULE}\n\n\n`)).toBeNull();
  });

  it('declines every committed Command Code frame that is not this screen', () => {
    // The four permission dialogs have the same rule-title-question-`❯ 1.` shape
    // and no tab strip, which is the single condition that separates them. The
    // idle, thinking and done frames end in the composer's own rules.
    const others = [
      [LIVE_DIR, 'dialog-create-file.txt'],
      [LIVE_DIR, 'dialog-kill-task-1490.txt'],
      [LIVE_DIR, 'dialog-shell-1490.txt'],
      [LIVE_DIR, 'dialog-shell-command.txt'],
      [LIVE_DIR, 'boot-idle-1490.txt'],
      [LIVE_DIR, 'turn-done-1490.txt'],
      [LIVE_DIR, 'turn-thinking-1490.txt'],
      [LIVE_DIR, 'idle-after-interrupt-1490.txt'],
      [CARD_DIR, 'command-code-model-1-40-1.txt'],
      [CARD_DIR, 'command-code-model-1-47-1-open.txt'],
      [CARD_DIR, 'command-code-model-1-47-1-closed.txt'],
    ] as const;
    for (const [dir, name] of others) {
      expect(readCommandCodeQuestionRegion(read(dir, name)), name).toBeNull();
    }
  });
});

// ===========================================================================
// C. The status the region produces
// ===========================================================================

describe('[#2521] C. the screen is published as a selection list, with no promptData', () => {
  it.each(POSITIVES)('%s: waiting / command_code_selection_list / positive', (_name, frame) => {
    const result = detectSessionStatus(frame, 'command-code');

    expect(result.status).toBe('waiting');
    expect(result.confidence).toBe('high');
    expect(result.reason).toBe(STATUS_REASON.COMMAND_CODE_SELECTION_LIST);
    expect(result.evidence).toBe('positive');
  });

  it.each(POSITIVES)('%s: claims no answerable prompt and invents no payload', (_name, frame) => {
    // #2522's half. `respond <id> N` and Auto-Yes key off `hasActivePrompt`, and
    // nothing here parsed the options — the last of them is a text input in the
    // TUI, not a fourth choice.
    const result = detectSessionStatus(frame, 'command-code');

    expect(result.hasActivePrompt).toBe(false);
    expect(result.promptDetection.isPrompt).toBe(false);
    expect(result.promptDetection.promptData).toBeUndefined();
  });

  it.each(POSITIVES)('%s: is in SELECTION_LIST_REASONS, not the floor', (_name, frame) => {
    const result = detectSessionStatus(frame, 'command-code');

    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(true);
    expect(isUnclassifiedFrame(result.status, result.reason)).toBe(false);
  });

  it('leaves every other Command Code verdict where #2250 / #2304 / #2369 left it', () => {
    const verdict = (dir: string, name: string): string => {
      const r = detectSessionStatus(read(dir, name), 'command-code');
      return `${r.status}/${r.reason}/${r.evidence}`;
    };

    expect(verdict(LIVE_DIR, 'boot-idle-1490.txt')).toBe(`ready/${STATUS_REASON.INPUT_PROMPT}/positive`);
    expect(verdict(LIVE_DIR, 'turn-done-1490.txt')).toBe(`ready/${STATUS_REASON.INPUT_PROMPT}/positive`);
    expect(verdict(LIVE_DIR, 'idle-after-interrupt-1490.txt')).toBe(
      `ready/${STATUS_REASON.INPUT_PROMPT}/positive`,
    );
    expect(verdict(LIVE_DIR, 'turn-thinking-1490.txt')).toBe(
      `running/${STATUS_REASON.THINKING_INDICATOR}/positive`,
    );
    for (const name of [
      'dialog-create-file.txt',
      'dialog-kill-task-1490.txt',
      'dialog-shell-1490.txt',
      'dialog-shell-command.txt',
    ]) {
      expect(verdict(LIVE_DIR, name), name).toBe(
        `waiting/${STATUS_REASON.PROMPT_DETECTED}/positive`,
      );
    }
    for (const name of [
      'command-code-model-1-40-1.txt',
      'command-code-model-1-47-1-open.txt',
      'command-code-model-1-47-1-middle.txt',
      'command-code-model-1-47-1-bottom.txt',
    ]) {
      expect(verdict(CARD_DIR, name), name).toBe(
        `waiting/${STATUS_REASON.COMMAND_CODE_SELECTION_LIST}/positive`,
      );
    }
    expect(verdict(CARD_DIR, 'command-code-model-1-47-1-closed.txt')).toBe(
      `ready/${STATUS_REASON.INPUT_PROMPT}/positive`,
    );
  });

  it('answers nothing new for another CLI handed the same bytes', () => {
    // The branch is the command-code module's. A claude session that somehow
    // painted this frame keeps whatever claude's rules said about it.
    expect(detectSessionStatus(MINIMAL, 'claude').reason).not.toBe(
      STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    );
  });
});

// ===========================================================================
// D. What the card is allowed to offer
// ===========================================================================

describe('[#2521] D. the numbers on this screen are not buttons', () => {
  it.each(POSITIVES)('%s: the shape alone would have drawn them', (_name, frame) => {
    // This is why the suppression is scoped to the region reading rather than
    // written into `shouldOfferOptionNumbers`: by the all-CLI rules #2297
    // measured, this frame EARNS a number row — four numbered options and no
    // filter box.
    const shape = readSelectionListShape(frame);

    expect(shape.optionCount).toBe(4);
    expect(shape.hasFilterInput).toBe(false);
    expect(shouldOfferOptionNumbers(shape)).toBe(true);
  });

  it('leaves the all-CLI rules exactly as #2297 measured them', () => {
    // The regression guard for the rule NOT widened: claude's `/model` still
    // refuses numbers for its own reason, and codex's picker still offers them.
    const claudeModel = readSelectionListShape(read(CARD_DIR, 'claude-model-2-1-259.txt'));
    expect(claudeModel.offersSessionScope).toBe(true);
    expect(shouldOfferOptionNumbers(claudeModel)).toBe(false);

    const codexModel = readSelectionListShape(read(CARD_DIR, 'codex-model-0-151-0.txt'));
    expect(shouldOfferOptionNumbers(codexModel)).toBe(true);
  });
});

// ===========================================================================
// E. The positive control
// ===========================================================================

describe('[#2521] E. without the region reading the frame is a false completion', () => {
  it.each(POSITIVES)('%s: the shared parser never reaches option 1', (_name, frame) => {
    // The defect's mechanism, pinned on the bytes: the generic multiple-choice
    // parser stops at the one-space continuation row, so nothing upstream of the
    // new branch has a prompt to report. Issue #2521 explicitly does NOT relax
    // it — `prompt-detect-multiple-choice.ts` is untouched.
    expect(detectPrompt(frame).isPrompt).toBe(false);
  });

  it.each(POSITIVES)('%s: and the composer check matches the dialog’s own cursor', (_name, frame) => {
    // `^❯(\s*$|\s+\S)` against `❯ 1. Prepare worktrees + dispatch (Recommended)`.
    // This is the row that made the pane `ready`, and it is still on the frame —
    // the branch is what is now ahead of it, not a change to this row.
    const lines = stripAnsi(frame).split('\n');
    expect(lines.some((line) => /^❯(\s*$|\s+\S)/.test(line))).toBe(true);
  });

  it('crops the dialog out of a pane that is 409 rows of transcript', () => {
    const cropped = stripAnsi(extractCommandCodeSelectionListFrame(LIVE_200X1000) ?? '');

    expect(cropped).toContain('● Dispatch | ◯ Review');
    expect(cropped).toContain('4. Type something...');
    // Neither edge comes along: not the rule row, not the transcript above it,
    // not the padding below.
    expect(cropped).not.toContain(RULE);
    expect(cropped).not.toContain('# Command Code v1.53.0');
    expect(cropped).not.toContain('Presenting dispatch decision');
    expect(cropped.split('\n')).toHaveLength(13);
  });
});
