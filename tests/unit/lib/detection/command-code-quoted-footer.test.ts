/**
 * Command Code の返答が画面のフッタ文言を引用しても、選択リスト・パネル・プラン確認と読まない (Issue #2846)
 *
 * `commandCodeStatusDetector` は 3 つのフッタ（`/model` ピッカー / `/usage` パネルの
 * `Press Esc to close` / プラン確認の `Approve ctrl+a` + `Cancel esc`）を、末尾 15 行
 * （`frame.lastLines`）のどこかに一致すれば「開いている」と読んでいた。返答がそのフッタを
 * 引用すると、画面の一番下は入力欄で待っているのに `waiting` になった。
 *
 * 直し方は「フッタが画面の下端にあるときだけ」。ピッカーとパネルは空行を除いた最後の 1 行、
 * プラン確認は下端の 5 行（フッタの 2 行 + ヒントバーなど 3 行）。プラン確認は最後の 2 行では
 * 足りない: 実機の画面は `Cancel esc` の下にヒントバーを 1〜3 行描く。入力欄は最短でも 4 行
 * （罫線・`❯`・罫線・状態行）なので、引用の下には必ずそれ以上ある。
 *
 * 再現の画面は `command-code-live-2250/idle-after-interrupt-1490.txt`（入力欄で待っている実機の画面）の
 * 入力欄の直上に、フッタを返答として 2 字下げで差し込んだもの。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { stripAnsi } from '@/lib/detection/ansi';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import {
  COMMAND_CODE_PLAN_REVIEW_FOOTER,
  COMMAND_CODE_SELECTION_LIST_FOOTER,
  DISMISSABLE_PANEL_FOOTER_PATTERN,
} from '@/lib/detection/selection-shape';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');
const verdictOf = (frame: string): string => {
  const { status, reason } = detectSessionStatus(frame, 'command-code');
  return `${status} ${reason}`;
};

// --- 実機の画面から取る材料 --------------------------------------------------------------

const IDLE = 'command-code-live-2250/idle-after-interrupt-1490.txt';
const idleRows = read(IDLE).split('\n');
const composerRow = idleRows.findIndex((row) => stripAnsi(row).startsWith('❯ Ask your question'));
/** 入力欄の上の罫線。この行より上が会話、下が入力欄（罫線・`❯`・罫線・状態行の 4 行）。 */
const ruleRow = composerRow - 1;

/** ピッカーのフッタは、実機の `/model`（1.40.1）の最終行をそのまま使う。 */
const pickerRows = stripAnsi(read('chat-dialog-card-2254/command-code-model-1-40-1.txt'))
  .split('\n')
  .filter((row) => row.trim() !== '');
const pickerFooter = pickerRows[pickerRows.length - 1].trim();
/** プラン確認のフッタは、実機（1.58.0）の 2 行と、その下のヒントバー。 */
const planRows = stripAnsi(read('command-code-plan-review-2761/plan-review-1-58-0.txt'))
  .split('\n')
  .filter((row) => row.trim() !== '');
const approveAt = planRows.findIndex((row) => row.startsWith('Approve ctrl+a'));
const planFooter = planRows.slice(approveAt, approveAt + 2);
const planHintBar = planRows[approveAt + 2];
/** `/usage` パネルの最終行。実機の採取は無く、Issue #2369 の記録どおり（dismissable-panel-2369.test.ts と同じ）。 */
const usageFooter = 'Press Esc to close';

/** 会話の一部として描かれた行。SGR を付け、2 字下げにする。 */
const reply = (row: string): string => `\x1b[38;5;250m  ${row}\x1b[39m`;

/** 画面の高さ（採取と同じ行数）に、末尾の空行で揃える。 */
function padToHeight(rows: string[]): string {
  const extra = rows.length - idleRows.length;
  if (extra > 0) {
    const dropped = rows.splice(rows.length - extra, extra);
    if (dropped.some((row) => row.trim() !== '')) throw new Error('padToHeight: dropped a content row');
  }
  return rows.join('\n');
}

/** 返答が `quoted` を引用し、その下に入力欄がある画面。 */
function quotedAboveComposer(quoted: string[]): string {
  return padToHeight([
    ...idleRows.slice(0, ruleRow),
    ...quoted.map(reply),
    '',
    ...idleRows.slice(ruleRow),
  ]);
}

/** 入力欄の代わりにオーバーレイが下端に描かれた画面（入力欄の罫線は描かれない）。 */
function overlayAtBottom(overlay: string[]): string {
  return padToHeight([...idleRows.slice(0, ruleRow), ...overlay]);
}

const both = (frame: string): Array<[string, string]> => [
  ['ANSI 付き', frame],
  ['stripAnsi 後', stripAnsi(frame)],
];

// --- 1. 再現 ------------------------------------------------------------------------------

const QUOTES = [
  {
    name: '/model ピッカーのフッタ',
    rows: [pickerFooter],
    pattern: COMMAND_CODE_SELECTION_LIST_FOOTER,
    reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
  },
  {
    name: '/usage パネルの Press Esc to close',
    rows: [usageFooter],
    pattern: DISMISSABLE_PANEL_FOOTER_PATTERN,
    reason: STATUS_REASON.COMMAND_CODE_DISMISSABLE_PANEL,
  },
  {
    name: 'プラン確認の 2 行フッタ',
    rows: planFooter,
    pattern: COMMAND_CODE_PLAN_REVIEW_FOOTER,
    reason: STATUS_REASON.COMMAND_CODE_PLAN_REVIEW,
  },
];

describe('返答が引用したフッタを、開いている画面と読まない (Issue #2846)', () => {
  it('材料の確認: 入力欄の罫線は 1 行、その直下が `❯` の行', () => {
    expect(stripAnsi(idleRows[ruleRow])).toMatch(/^─{100,}$/);
    expect(stripAnsi(idleRows[composerRow])).toBe('❯ Ask your question...');
    expect(pickerFooter).toContain('enter to select · esc to cancel');
    expect(planFooter).toEqual(['Approve ctrl+a   executes the plan', 'Cancel esc']);
  });

  describe.each(QUOTES)('$name', ({ rows, pattern, reason }) => {
    it.each(both(quotedAboveComposer([...rows])))(
      '%s: 入力欄で待っている画面は waiting にならず、ready で答える',
      (_label, frame) => {
        // 罠になっていること: 引用は末尾 15 行の中にあり、正規表現は位置を見なければ一致する
        expect(pattern.test(normalizeFrame(frame).lastLines)).toBe(true);

        const verdict = detectSessionStatus(frame, 'command-code');
        expect(verdict.status).not.toBe('waiting');
        expect(verdict.reason).not.toBe(reason);
        expect(verdictOf(frame)).toBe(`ready ${STATUS_REASON.INPUT_PROMPT}`);
      },
    );
  });

  it.each(both(read('tui-frame-footer-2776/command-code-1.58.0-idle-quoted-footers.txt')))(
    '実機の待機画面（引用フッタあり, 1.58.0）: %s で waiting にならない',
    (_label, frame) => {
      expect(detectSessionStatus(frame, 'command-code').status).not.toBe('waiting');
    },
  );

  it('返答が 3 つとも引用していても、入力欄で待っている画面は waiting にならない', () => {
    const frame = quotedAboveComposer([pickerFooter, '', usageFooter, '', ...planFooter]);
    for (const [, f] of both(frame)) {
      expect(verdictOf(f)).toBe(`ready ${STATUS_REASON.INPUT_PROMPT}`);
    }
  });
});

// --- 2. 本物のフッタは従来どおり ------------------------------------------------------------

describe('フッタが画面の下端にあるときは、従来どおり waiting (Issue #2846)', () => {
  it.each(both(overlayAtBottom(['', pickerFooter])))(
    '/model ピッカー: 最終行がフッタ (%s)',
    (_label, frame) => {
      expect(verdictOf(frame)).toBe(`waiting ${STATUS_REASON.COMMAND_CODE_SELECTION_LIST}`);
    },
  );

  it.each(both(overlayAtBottom(['', usageFooter])))(
    '/usage パネル: 最終行が Press Esc to close (%s)',
    (_label, frame) => {
      expect(verdictOf(frame)).toBe(`waiting ${STATUS_REASON.COMMAND_CODE_DISMISSABLE_PANEL}`);
    },
  );

  it('/usage パネル: 行末の空白・ピリオドがあっても最終行なら waiting', () => {
    expect(verdictOf(overlayAtBottom(['', `${usageFooter}.   `]))).toBe(
      `waiting ${STATUS_REASON.COMMAND_CODE_DISMISSABLE_PANEL}`,
    );
  });

  // プラン確認: `Cancel esc` の下に描かれる内容行の数ごとに、実機で測った形
  it.each([
    ['ヒントバー 1 行（実機 14 画面）', ['', planHintBar]],
    [
      '`Editor exited with code 127` + ヒントバー（実機 1 画面）',
      ['Editor exited with code 127', '', planHintBar],
    ],
    [
      '`Editor exited` + 折り返したヒントバー（内容 3 行, editor-killed-staircase.txt）',
      ['Editor exited with code null', '', 'type + enter to comment ·', 'rl+g $EDITOR'],
    ],
  ])('プラン確認: フッタの下が %s', (_name, below) => {
    for (const [, frame] of both(overlayAtBottom(['', ...planFooter, ...below]))) {
      expect(verdictOf(frame)).toBe(`waiting ${STATUS_REASON.COMMAND_CODE_PLAN_REVIEW}`);
    }
  });

  it('プラン確認: フッタの下に内容が 4 行あれば（入力欄の大きさ）オーバーレイとは読まない', () => {
    const below = ['一行目', '二行目', '三行目', '四行目'];
    expect(verdictOf(overlayAtBottom(['', ...planFooter, ...below]))).not.toBe(
      `waiting ${STATUS_REASON.COMMAND_CODE_PLAN_REVIEW}`,
    );
  });

  it('引用がオーバーレイの上にあっても、下端のフッタは読める', () => {
    const frame = padToHeight([
      ...idleRows.slice(0, ruleRow),
      ...planFooter.map(reply),
      '',
      '─'.repeat(150),
      '',
      ' REVIEW ',
      ...planFooter,
      '',
      planHintBar,
    ]);
    expect(verdictOf(frame)).toBe(`waiting ${STATUS_REASON.COMMAND_CODE_PLAN_REVIEW}`);
  });
});

// --- 3. 陰性対照: 実機の画面すべて -----------------------------------------------------------

/**
 * 修正前（develop `0cb83417`）の判定。`<status> <reason>`。
 *
 * 対象は `tests/fixtures/command-code-*` の各ディレクトリと `tests/fixtures/tui-frame-footer-2776/command-code-*` の
 * 実機の画面すべて。これに、Command Code の実機の画面が入っている他の 3 か所を足した:
 * `chat-dialog-card-2254`（`/model` ピッカーの実機はここだけ）、`agent-mode-2592`、`long-body-2464`。
 * ANSI 付きと stripAnsi 後の両方で、この表と同じでなければならない。
 * 表は修正前のソースで採取し、修正後も 100 画面すべてが同じ判定であることを確かめた。
 */
const PRE_FIX_VERDICTS: Record<string, string> = {
  // agent-mode-2592
  'agent-mode-2592/command-code-accept-edits.txt': 'ready input_prompt',
  'agent-mode-2592/command-code-bypass-1490.txt': 'ready input_prompt',
  'agent-mode-2592/command-code-default.txt': 'ready input_prompt',
  'agent-mode-2592/command-code-plan.txt': 'ready input_prompt',

  // chat-dialog-card-2254
  'chat-dialog-card-2254/command-code-model-1-40-1.txt': 'waiting command_code_selection_list',
  'chat-dialog-card-2254/command-code-model-1-47-1-bottom.txt': 'waiting command_code_selection_list',
  'chat-dialog-card-2254/command-code-model-1-47-1-closed.txt': 'ready input_prompt',
  'chat-dialog-card-2254/command-code-model-1-47-1-middle.txt': 'waiting command_code_selection_list',
  'chat-dialog-card-2254/command-code-model-1-47-1-open.txt': 'waiting command_code_selection_list',
  'chat-dialog-card-2254/command-code-model-1-49-0-boot-effort-max.txt': 'ready input_prompt',
  'chat-dialog-card-2254/command-code-model-1-49-0-switch-banner-scrolled.txt': 'ready input_prompt',
  'chat-dialog-card-2254/command-code-model-1-49-0-switch-kimi-low.txt': 'ready input_prompt',
  'chat-dialog-card-2254/command-code-model-1-49-0-switch-pro-high.txt': 'ready input_prompt',

  // command-code-askuserquestion-2521
  'command-code-askuserquestion-2521/askuserquestion-wrapped-1530-200x1000.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2521/askuserquestion-wrapped-minimal.txt': 'waiting prompt_detected',

  // command-code-askuserquestion-2522
  'command-code-askuserquestion-2522/not-applicable-answered-then-composer.txt': 'ready input_prompt',
  'command-code-askuserquestion-2522/not-applicable-numbered-answer.txt': 'ready input_prompt',
  'command-code-askuserquestion-2522/not-applicable-review-tab.txt': 'running default',
  'command-code-askuserquestion-2522/question-default-on-free-text.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2522/question-description-indent-0-1-2.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2522/question-description-on-last-option.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2522/question-flat-short-ansi-crlf.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2522/question-flat-short.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2522/question-japanese-fullwidth.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2522/question-taller-than-detection-windows.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2522/question-wrapped-no-question-mark.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2522/unsupported-duplicate-number.txt': 'waiting command_code_selection_list',
  'command-code-askuserquestion-2522/unsupported-last-option-tail-too-long.txt': 'waiting command_code_selection_list',
  'command-code-askuserquestion-2522/unsupported-missing-number.txt': 'waiting command_code_selection_list',
  'command-code-askuserquestion-2522/unsupported-multi-select-checkboxes.txt': 'waiting command_code_selection_list',
  'command-code-askuserquestion-2522/unsupported-region-too-tall.txt': 'waiting command_code_selection_list',

  // command-code-askuserquestion-2753
  'command-code-askuserquestion-2753/multiselect-answered-tabs.txt': 'waiting prompt_detected',

  // command-code-askuserquestion-2754
  'command-code-askuserquestion-2754/multiselect-cursor-on-next.txt': 'waiting command_code_selection_list',
  'command-code-askuserquestion-2754/multiselect-cursor-on-option-1-after-nav.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/multiselect-cursor-on-option-2.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/multiselect-cursor-on-option-3-nothing-checked.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/multiselect-cursor-on-submit-no-footer.txt': 'waiting command_code_selection_list',
  'command-code-askuserquestion-2754/multiselect-cursor-on-submit.txt': 'waiting command_code_selection_list',
  'command-code-askuserquestion-2754/multiselect-enter-toggled-option-1.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/multiselect-free-text-digit-appended.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/multiselect-free-text-focused.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/multiselect-free-text-typed.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/multiselect-initial.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/multiselect-next-row-not-last-question.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/multiselect-notes-row-open.txt': 'waiting command_code_selection_list',
  'command-code-askuserquestion-2754/multiselect-space-untoggled-cursor-row.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/multiselect-submit-row-space-ticked-option-1.txt': 'waiting command_code_selection_list',
  'command-code-askuserquestion-2754/multiselect-two-checked.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/multiselect-up-from-option-1-lands-on-submit.txt': 'waiting command_code_selection_list',
  'command-code-askuserquestion-2754/multiselect-up-from-option-1-wraps-to-last.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/not-applicable-cancelled-from-notes-row.txt': 'running thinking_indicator',
  'command-code-askuserquestion-2754/not-applicable-chat-disposition.txt': 'ready input_prompt',
  'command-code-askuserquestion-2754/not-applicable-question-cancelled.txt': 'ready input_prompt',
  'command-code-askuserquestion-2754/review-page-submit-cancel.txt': 'waiting command_code_selection_list',
  'command-code-askuserquestion-2754/review-page-unanswered-warning.txt': 'waiting command_code_selection_list',
  'command-code-askuserquestion-2754/singleselect-answered-tabs.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/singleselect-initial-unanswered-tabs.txt': 'waiting prompt_detected',
  'command-code-askuserquestion-2754/tabs-single-question.txt': 'waiting prompt_detected',

  // command-code-live-2250
  'command-code-live-2250/boot-idle-1490.txt': 'ready input_prompt',
  'command-code-live-2250/boot-idle.txt': 'ready input_prompt',
  'command-code-live-2250/dialog-create-file.txt': 'waiting prompt_detected',
  'command-code-live-2250/dialog-kill-task-1490.txt': 'waiting prompt_detected',
  'command-code-live-2250/dialog-shell-1490.txt': 'waiting prompt_detected',
  'command-code-live-2250/dialog-shell-command.txt': 'waiting prompt_detected',
  'command-code-live-2250/idle-after-interrupt-1490.txt': 'ready input_prompt',
  'command-code-live-2250/turn-done-1490.txt': 'ready input_prompt',
  'command-code-live-2250/turn-shell-running-1490.txt': 'running thinking_indicator',
  'command-code-live-2250/turn-thinking-1490.txt': 'running thinking_indicator',
  'command-code-live-2250/turn-thinking.txt': 'running thinking_indicator',
  'command-code-live-2250/turn-tool-write.txt': 'ready input_prompt',
  'command-code-live-2250/turn-version.txt': 'ready input_prompt',

  // command-code-plan-review-2761
  'command-code-plan-review-2761/plan-review-1-58-0.txt': 'waiting command_code_plan_review',

  // command-code-plan-review-2763
  'command-code-plan-review-2763/after-approve-immediate-blank.txt': 'running default',
  'command-code-plan-review-2763/after-approve-with-comments.txt': 'running thinking_indicator',
  'command-code-plan-review-2763/after-approve.txt': 'waiting prompt_detected',
  'command-code-plan-review-2763/after-cancel-idle.txt': 'ready input_prompt',
  'command-code-plan-review-2763/after-cancel-partial-redraw.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/after-cancel.txt': 'running thinking_indicator',
  'command-code-plan-review-2763/after-enter-on-focused-approve.txt': 'waiting prompt_detected',
  'command-code-plan-review-2763/editor-killed-staircase.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/editor-took-the-pane.txt': 'running default',
  'command-code-plan-review-2763/plan-review-action-focus-approve.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-approve-choice-discard.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-approve-choice.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-comment-box-open.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-comment-pinned.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-comment-typing.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-cursor-moved.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-editor-exited.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-initial.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-long-scrolled-cancel-focused.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-long-submit-review-focused.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-long-top.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-quick-comments.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-second-plan.txt': 'waiting command_code_plan_review',
  'command-code-plan-review-2763/plan-review-short.txt': 'waiting command_code_plan_review',

  // long-body-2464
  'long-body-2464/command-code-idle.capture': 'ready input_prompt',
  'long-body-2464/command-code-pasted-60L.capture': 'ready input_prompt',

  // tui-frame-footer-2776
  'tui-frame-footer-2776/command-code-1.58.0-idle-after-turn.txt': 'ready input_prompt',
  'tui-frame-footer-2776/command-code-1.58.0-idle-quoted-footers.txt': 'ready input_prompt',
};

/** `tests/fixtures` 直下から辿った Command Code の実機の画面（`*.txt` / `*.capture`）。 */
function commandCodeCaptures(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(txt|capture)$/.test(entry.name) || entry.name.endsWith('.stderr.txt')) continue;
      const rel = path.relative(FIXTURES, full);
      if (rel.split(path.sep)[0].startsWith('command-code-') || entry.name.startsWith('command-code-')) {
        found.push(rel.split(path.sep).join('/'));
      }
    }
  };
  walk(FIXTURES);
  return found.sort();
}

describe('陰性対照: Command Code の実機の画面は、修正前と同じ判定のまま (Issue #2846)', () => {
  it('表は実機の画面と過不足なく対応する（採取を足したら、その判定を表に足す）', () => {
    expect(commandCodeCaptures()).toEqual(Object.keys(PRE_FIX_VERDICTS).sort());
  });

  it.each(Object.entries(PRE_FIX_VERDICTS))('%s → %s', (rel, expected) => {
    const raw = read(rel);
    expect(verdictOf(raw)).toBe(expected);
    expect(verdictOf(stripAnsi(raw))).toBe(expected);
  });
});
