/** @vitest-environment node */

/**
 * Issue #2486: `commandmate respond` could not answer Claude Code 2.1.268's
 * AskUserQuestion picker when an option carried a `preview`.
 *
 * The frames are live claude-cli 2.1.268 captures
 * (`tests/fixtures/claude-live-2486/`, see the README there): the Issue's own
 * AskUserQuestion input, varied one element at a time — tab row only, preview
 * only, both — plus the screens the Issue walked through (question 2, the review
 * screen, the answered transcript) and one stress case whose preview holds a
 * numbered list.
 *
 * What was broken, measured on those frames before the fix: the preview pane put
 * ~20 rows between the options and the footer, `findNumberedOptionBlock`'s
 * footer scan ran out before it reached an option, `detectClaudeDialog` vouched
 * for nothing, and `/prompt-response` refused the open picker as
 * `prompt_no_longer_active`. The tab row refused nothing; it — and the transcript
 * row above it — led the `question` / `approvalTarget` the prompt was published
 * with.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { stripAskUserQuestionTabs } from '@/lib/chat/chat-tool-approvals';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { findClaudeChrome, maskClaudeChrome } from '@/lib/detection/prompt-detect-multiple-choice';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { findClaudeTranscriptTail } from '@/lib/detection/tools/claude/detect';
import {
  findAskUserQuestionTabRow,
  findClaudePreviewPanes,
  isAskUserQuestionTabRow,
} from '@/lib/detection/tools/claude/picker-chrome';
import { detectClaudeDialog } from '@/lib/detection/tools/claude/prompt';
import { findNumberedOptionBlock } from '@/lib/detection/tools/dialog-block';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { evaluateAutoYesDialogGate, evaluateDialogPresence } from '@/lib/polling/auto-yes-dialog-gate';
import { resolveAutoAnswer } from '@/lib/polling/auto-yes-resolver';
import type { MultipleChoicePromptData } from '@/types/models';
import { CANARY_ASKUSERQUESTION_TASK_PANEL } from '@tests/fixtures/canary/askuserquestion-task-panel';

const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/claude-live-2486/', import.meta.url));

function frame(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}.txt`, 'utf8');
}

/** The Issue's two questions, verbatim from its AskUserQuestion input. */
const Q1 =
  'cmate-workspace-research の preflight（run の作成前・子への送信前）です。子 2 つはどちらも解決済み（claude-2 = Claude 2 / command-code = Command Code、どちらもこの worktree・running・Auto-Yes ON。自分 = claude は含まれていません）。調査中に子が read-only コマンド（git log / npm ls など）を使うときの権限をどう扱いますか？ 右のプレビューに子ごとの権限表があります。';
const Q2 =
  'brief.md に書く Research Goal の 1 行案です:「このリポジトリ（harness-pack-uat-sandbox）の実行・テスト・CI の Node.js を 22 系から 24 系へ上げたとき、壊れるもの（blocker）・要修正箇所・未確認事項があるかを判断可能にする（移行手順の作成・実装は対象外）」。対象範囲はどうしますか？';

const Q1_OPTIONS = ['整えた状態で続行 (Recommended)', 'ファイル読取のみで続行'];
const PICKER_META = ['Type something.', 'Chat about this'];
const Q2_OPTIONS = ['この Goal・repo 全体 (Recommended)', 'この Goal・アプリ部分のみ', ...PICKER_META];

/** Text that exists only inside question 1's previews. */
const PREVIEW_TEXT = ['子の権限表', 'files_only のとき', 'cliTool', '失うもの'];
/** The pane's outline, which no label or question may carry. */
const PANE_OUTLINE = /[┌┐└┘│]/;

/** `detectPrompt` as `/prompt-response` and the Auto-Yes poller call it. */
function multipleChoice(raw: string): MultipleChoicePromptData {
  const { promptData } = detectPrompt(stripBoxDrawing(stripAnsi(raw)), buildDetectPromptOptions('claude'));
  if (promptData?.type !== 'multiple_choice') {
    throw new Error(`expected a multiple_choice, got ${promptData?.type ?? 'no prompt'}`);
  }
  return promptData;
}

/** `detectClaudeDialog` as the claude detector calls it. */
function dialogOf(raw: string) {
  const normalized = normalizeFrame(raw);
  return detectClaudeDialog(normalized, {
    transcriptTail: findClaudeTranscriptTail(normalized.contentLines),
  });
}

/** The rows `detectClaudeDialog` reads, and the end of its region. */
function dialogRegion(raw: string): { lines: string[]; end: number } {
  const normalized = normalizeFrame(raw);
  return {
    lines: stripBoxDrawing(normalized.clean).split('\n'),
    end: findClaudeTranscriptTail(normalized.contentLines) + 1,
  };
}

function rows(raw: string): string[] {
  return raw.split('\n');
}

function rowIndex(all: readonly string[], match: RegExp, from = 0): number {
  const index = all.findIndex((row, i) => i >= from && match.test(stripAnsi(row)));
  if (index < 0) throw new Error(`no row matched ${match}`);
  return index;
}

/** The live capture with the rows matching `match` removed; every other byte kept. */
function withoutRows(raw: string, match: RegExp): string {
  const all = rows(raw);
  const kept = all.filter(row => !match.test(stripAnsi(row)));
  if (kept.length === all.length) throw new Error(`no row matched ${match}`);
  return kept.join('\n');
}

/** Question 1's options through the pane's notes row, verbatim — a quoted picker. */
function quotedPreviewPicker(): string[] {
  const all = rows(frame('tabs-preview-q1'));
  const from = rowIndex(all, /^❯ 1\. 整えた状態で続行/);
  return all.slice(from, rowIndex(all, /Notes: press n to add notes/, from) + 1);
}

function insertBefore(raw: string, match: RegExp, inserted: readonly string[]): string {
  const all = rows(raw);
  all.splice(rowIndex(all, match), 0, ...inserted);
  return all.join('\n');
}

describe('Issue #2486: what refused the picker', () => {
  it('was the preview pane: the block reader found no options on either preview frame', () => {
    for (const name of ['preview-q1', 'tabs-preview-q1']) {
      const { lines, end } = dialogRegion(frame(name));
      // The reading before the fix: the footer scan runs out on pane rows.
      expect(findNumberedOptionBlock(lines, end), name).toBeNull();
      // The same region with Claude's chrome masked out reads the options.
      const visible = maskClaudeChrome(lines, findClaudeChrome(lines, 0, end));
      expect(findNumberedOptionBlock(visible, end)?.options, name).toEqual(Q1_OPTIONS);
    }
  });

  it('was not the tab row: two questions without a preview were always a dialog', () => {
    const { lines, end } = dialogRegion(frame('tabs-q1'));
    expect(findNumberedOptionBlock(lines, end)?.selectedGlyph).toBe('❯');
    expect(evaluateDialogPresence('claude', 'multiple_choice', frame('tabs-q1')).present).toBe(true);
  });
});

describe('Issue #2486: every question screen is an answerable dialog', () => {
  it.each([
    ['tabs-q1', Q1, [...Q1_OPTIONS, ...PICKER_META], 1],
    ['preview-q1', Q1, Q1_OPTIONS, 1],
    ['preview-q1-cursor-on-2', Q1, Q1_OPTIONS, 2],
    ['tabs-preview-q1', Q1, Q1_OPTIONS, 1],
    ['tabs-preview-q2', Q2, Q2_OPTIONS, 1],
  ] as const)('%s', (name, question, options, cursor) => {
    const raw = frame(name);

    // detectClaudeDialog vouches — the gate /prompt-response and Auto-Yes read.
    const dialog = dialogOf(raw);
    expect(dialog?.answerMode).toBe('numbered');
    expect(dialog?.options).toHaveLength(options.length);
    // The block reader folds descriptions into a label; the label leads.
    dialog?.options.forEach((label, i) => expect(label.startsWith(options[i]), label).toBe(true));
    expect(evaluateDialogPresence('claude', 'multiple_choice', raw).present).toBe(true);

    // detectPrompt publishes the picker's own options and question.
    const prompt = multipleChoice(raw);
    expect(prompt.options.map(option => option.label)).toEqual(options);
    expect(prompt.options.find(option => option.isDefault)?.number).toBe(cursor);
    expect(prompt.isAskUserQuestion).toBe(true);
    expect(prompt.question).toBe(question);

    // The status path — what `wait --on-prompt agent` exits 10 on — agrees.
    expect(detectSessionStatus(raw, 'claude')).toMatchObject({
      status: 'waiting',
      reason: 'prompt_detected',
      hasActivePrompt: true,
    });
  });

  it.each(['tabs-q1', 'preview-q1', 'tabs-preview-q1', 'tabs-preview-q2'])(
    '%s: neither question nor approvalTarget carries the tab row or the previous tool',
    name => {
      const prompt = multipleChoice(frame(name));
      for (const text of [prompt.question, prompt.approvalTarget ?? '']) {
        expect(text).not.toMatch(/[←☐☒]|✔ Submit/);
        expect(text).not.toContain('Read 1 file');
        expect(text).not.toContain('do not run any other tool'); // the user's prompt, above that
      }
      // approvalTarget is still the whole panel: the question through the options.
      expect(prompt.approvalTarget?.startsWith(prompt.question.slice(0, 20))).toBe(true);
      expect(prompt.approvalTarget).toMatch(/1\. (?:整えた状態で続行|この Goal・repo 全体)/);
    },
  );

  it.each(['preview-q1', 'preview-q1-cursor-on-2', 'tabs-preview-q1'])(
    '%s: no option label carries the pane',
    name => {
      const raw = frame(name);
      for (const label of [
        ...multipleChoice(raw).options.map(option => option.label),
        ...(dialogOf(raw)?.options ?? []),
      ]) {
        expect(label).not.toMatch(PANE_OUTLINE);
        for (const text of PREVIEW_TEXT) expect(label).not.toContain(text);
      }
      expect(multipleChoice(raw).question).not.toMatch(PANE_OUTLINE);
    },
  );

  it('reads a numbered list INSIDE the pane as pane, not as the options', () => {
    // Beyond the Issue: an agent's preview is free text, and `1. / 2. / 3.` is
    // what a plan looks like. Before the fix the block reader took the pane's
    // list for the dialog, and detectPrompt published `Merge` / `Pray`.
    for (const [name, cursor] of [
      ['preview-numbered-q1', 1],
      ['preview-numbered-q1-cursor-on-2', 2],
    ] as const) {
      const raw = frame(name);
      expect(dialogOf(raw)?.options, name).toEqual(['Staged rollout', 'Big bang']);
      const prompt = multipleChoice(raw);
      expect(prompt.options.map(option => option.label), name).toEqual(['Staged rollout', 'Big bang']);
      expect(prompt.options.find(option => option.isDefault)?.number, name).toBe(cursor);
      expect(prompt.question, name).toBe('Which rollout plan should the canary follow?');
    }
  });
});

describe('Issue #2486: the screens around the questions', () => {
  it('the review screen is still the ask_user confirmation', () => {
    const raw = frame('tabs-preview-review');
    expect(dialogOf(raw)).toEqual({
      kind: 'ask_user',
      options: ['Submit answers', 'Cancel'],
      answerMode: 'numbered',
    });
    expect(multipleChoice(raw).options.map(option => option.label)).toEqual(['Submit answers', 'Cancel']);
  });

  it('the answered transcript is not a dialog', () => {
    // Claude's reply lists the two answers as `1. … / 2. …` — #2457's shape.
    const raw = frame('tabs-preview-answered-idle');
    expect(dialogOf(raw)).toBeNull();
    expect(evaluateDialogPresence('claude', 'multiple_choice', raw).present).toBe(false);
    expect(detectSessionStatus(raw, 'claude')).toMatchObject({ status: 'ready', hasActivePrompt: false });
  });
});

describe('Issue #2486: masking chrome does not vouch for a reply (#2457 on the new frames)', () => {
  it('a reply that quotes the preview picker, followed by prose, is not a dialog', () => {
    const raw = insertBefore(
      frame('tabs-preview-answered-idle'),
      /As you asked, I ran no other tools/,
      quotedPreviewPicker(),
    );
    expect(dialogOf(raw)).toBeNull();
    expect(evaluateDialogPresence('claude', 'multiple_choice', raw).present).toBe(false);
  });

  it('a reply that quotes it directly above the completion marker is not a dialog', () => {
    const raw = insertBefore(frame('tabs-preview-answered-idle'), /✻ Cogitated for/, quotedPreviewPicker());
    expect(dialogOf(raw)).toBeNull();
    expect(evaluateDialogPresence('claude', 'multiple_choice', raw).present).toBe(false);
  });

  it('a quoted pane with no picker footer under it is not claimed as chrome', () => {
    // The preview picker's own rows with nothing below the notes row: a quote at
    // the end of a reply, caught before the marker was drawn. Were the pane
    // claimed without its footer, the tail walk would step over it onto the
    // quoted `❯ 1.` / `2.` and vouch for them.
    const all = rows(frame('tabs-preview-q1'));
    const raw = all.slice(0, rowIndex(all, /Notes: press n to add notes/) + 1).join('\n');
    expect(dialogOf(raw)).toBeNull();
    expect(evaluateDialogPresence('claude', 'multiple_choice', raw).present).toBe(false);
  });

  it('a pane caught without its bottom border is left alone, and the frame is declined', () => {
    const raw = withoutRows(frame('tabs-preview-q1'), /^\s*└─+┘\s*$/);
    expect(dialogOf(raw)).toBeNull();
    // The generic parser still sees the picker (its footer is on screen) — the
    // combination /prompt-response now reports as `unsupported_dialog_layout`.
    expect(multipleChoice(raw).isAskUserQuestion).toBe(true);
  });
});

describe('Issue #2486: Auto-Yes treats these as it treats a single question', () => {
  // Policy unchanged: Auto-Yes has always answered a single-question
  // AskUserQuestion (the canary's 2.1.223 capture below). A tab row or a preview
  // must not change that in either direction.
  it.each([
    ['single question, 2.1.223 (baseline)', CANARY_ASKUSERQUESTION_TASK_PANEL],
    ['tabs-q1', frame('tabs-q1')],
    ['preview-q1', frame('preview-q1')],
    ['tabs-preview-q1', frame('tabs-preview-q1')],
    ['tabs-preview-q2', frame('tabs-preview-q2')],
    ['preview-numbered-q1', frame('preview-numbered-q1')],
  ])('%s: the gate allows it and the answer is the highlighted option 1', (_name, raw) => {
    // The spelling Auto-Yes hands the gate (`captureAndCleanOutput`); the explicit
    // env keeps an operator's CM_AUTOYES_DIALOG_GATE out of the verdict.
    const verdict = evaluateAutoYesDialogGate(
      'claude',
      'multiple_choice',
      stripBoxDrawing(stripAnsi(raw)),
      { NODE_ENV: 'test' },
    );
    expect(verdict).toMatchObject({ gated: true, allowed: true });
    expect(resolveAutoAnswer(multipleChoice(raw))).toBe('1');
  });
});

describe('Issue #2486: the picker chrome readers', () => {
  const liveTabRows = [
    ['tabs-q1', /^←/],
    ['tabs-preview-q2', /^←/],
    ['tabs-preview-review', /^←/],
    ['preview-q1', /^ ☐ 権限モード/],
    ['preview-numbered-q1', /^ ☐ Rollout/],
  ] as const;

  it.each(liveTabRows)('%s: its tab row is recognised', (name, match) => {
    const all = rows(frame(name)).map(stripAnsi);
    expect(isAskUserQuestionTabRow(all[rowIndex(all, match)])).toBe(true);
  });

  it('does not take transcript or option rows for a tab row', () => {
    for (const row of [
      '     ☐ Implement the parser', // TodoWrite, under ⎿
      '  ⎿  ☐ Research',
      '☐ 1. Blue', // a multi-select option
      '☐ 実行範囲 ☐ 起動場所 どこまで？', // checkboxes, no arrows
      '← back → forward ✔ Submit → done', // arrows, no checkbox
      '  ←  ☐ Color  ✔ Submit  →', // indented: a quote, not the picker
    ]) {
      expect(isAskUserQuestionTabRow(row), row).toBe(false);
    }
  });

  it('finds the tab row only above the question it caps', () => {
    const lines = ['⏺ earlier', '←  ☐ A  ☐ B  ✔ Submit  →', '', 'Which one?', '', '❯ 1. X', '  2. Y'];
    expect(findAskUserQuestionTabRow(lines, 3, 12)).toBe(1);
    expect(findAskUserQuestionTabRow(lines, 3, 1)).toBe(-1);
    expect(findAskUserQuestionTabRow(['Do you want to proceed?', '❯ 1. Yes'], 0, 12)).toBe(-1);
  });

  it('claims the pane, its notes row and the option rows it shares — in both spellings', () => {
    const raw = frame('tabs-preview-q1');
    for (const spelling of [stripAnsi(raw), stripBoxDrawing(stripAnsi(raw))]) {
      const lines = spelling.split('\n');
      const panes = findClaudePreviewPanes(lines, 0, lines.length);
      const cutRows = [...panes.cuts.keys()].map(i => lines[i].slice(0, panes.cuts.get(i)).trim());
      expect(cutRows).toEqual(['❯ 1. 整えた状態で続行', '(Recommended)', '2. ファイル読取のみで続行']);
      const claimed = [...panes.rows].map(i => lines[i].trim()).filter(Boolean);
      expect(claimed).toContain('Notes: press n to add notes');
      expect(claimed.some(row => row.includes('WebSearch が既にある'))).toBe(true);
      // The pane's first line shares its row with `(Recommended)`: cut, not claimed.
      expect(claimed.some(row => row.includes('子の権限表'))).toBe(false);
      // Nothing of the dialog: not the question, the meta option or the footer.
      expect(claimed.some(row => row.includes('Chat about this') || row.includes('Enter to select'))).toBe(false);
    }
  });

  it('claims no pane that is not all there', () => {
    const lines = stripAnsi(frame('tabs-preview-q1')).split('\n');
    const topRow = rowIndex(lines, /^❯ 1\. 整えた状態で続行/);
    const bottomRow = rowIndex(lines, /^\s*└─+┘\s*$/);
    const footerRow = rowIndex(lines, /Enter to select/);

    const unclosed = lines.filter((_, i) => i !== bottomRow);
    const narrowerBottom = lines.map((row, i) => (i === bottomRow ? row.replace('─┘', '┘') : row));
    const noFooter = lines.filter((_, i) => i !== footerRow);
    const notOnOptionOne = lines.map((row, i) => (i === topRow ? row.replace('❯ 1.', '❯ A.') : row));

    for (const [label, variant] of [
      ['unclosed', unclosed],
      ['bottom border of another width', narrowerBottom],
      ['no picker footer', noFooter],
      ['top border not on option 1', notOnOptionOne],
    ] as const) {
      const panes = findClaudePreviewPanes(variant, 0, variant.length);
      expect(panes.rows.size, label).toBe(0);
      expect(panes.cuts.size, label).toBe(0);
    }
  });

  it('the chat surface strips the same tab bar the detector stops at', () => {
    // One definition (picker-chrome), two readers: rows stored before #2486 carry
    // the bar in `question`, and #2460's display strip must still remove it.
    for (const name of ['tabs-q1', 'tabs-preview-q2', 'tabs-preview-review']) {
      const all = rows(frame(name)).map(stripAnsi);
      const tabRow = all[rowIndex(all, /^←/)];
      expect(stripAskUserQuestionTabs(`${tabRow} Which one?`), name).toBe('Which one?');
    }
  });
});
