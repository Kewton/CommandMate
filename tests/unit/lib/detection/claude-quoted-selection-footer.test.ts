/** @vitest-environment node */

/**
 * Issue #2847: 返答の本文が選択画面のフッタ文言を引用しただけの idle 画面を、
 * claude の検出器が `waiting` / `claude_selection_list` と読んでいた。
 *
 * 原因は `tools/claude/detect.ts` の `afterPrompt` が、末尾 15 行
 * （`frame.lastLines`）にフッタの文言があるだけで選択リストと判定していたこと。
 * 同じファイルの `readIdleEvidence` / `detectClaudeDialog` は
 * `findClaudeTranscriptTail` を経由して会話の本文と画面の部品を分けているが、
 * この 1 か所だけが経由していなかった。
 *
 * 直し方: 入力欄が見つかる画面では、フッタの判定を入力欄の上端
 * （`openingSeparator`）以降の行だけに当てる。入力欄が無い画面（選択画面が
 * 入力欄と入れ替わっている画面）は従来どおり末尾 15 行を読む。
 *
 * 入力の `claude-2.1.278-idle-quoted-footers.txt` は実機の採取
 * （`tests/fixtures/tui-frame-footer-2776/README.md`）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_SELECTION_LIST_FOOTER } from '@/lib/detection/cli-patterns';
import { stripAnsi } from '@/lib/detection/ansi';
import { findClaudeInputBox } from '@/lib/detection/composer-text';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { normalizeFrame } from '@/lib/detection/tools/frame';

const ROOT = process.cwd();
const FOOTERS_2776 = 'tests/fixtures/tui-frame-footer-2776';
const IDLE_QUOTED = `${FOOTERS_2776}/claude-2.1.278-idle-quoted-footers.txt`;

const capture = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** 検出器に渡る 2 つの形: 採取そのまま（ANSI 付き）と `stripAnsi` 後。 */
const FORMS = [
  ['ANSI 付き', (raw: string): string => raw],
  ['stripAnsi 後', stripAnsi],
] as const;

describe('引用されたフッタ文言は選択リストではない（実機の idle 画面, claude 2.1.278）', () => {
  it.each(FORMS)('%s: waiting にならず、入力待ち（ready）と読む', (_form, toForm) => {
    const result = detectSessionStatus(toForm(capture(IDLE_QUOTED)), 'claude');

    expect(result.status).not.toBe('waiting');
    expect(result.reason).not.toBe(STATUS_REASON.CLAUDE_SELECTION_LIST);
    expect(result).toMatchObject({
      status: 'ready',
      reason: STATUS_REASON.INPUT_PROMPT,
      hasActivePrompt: false,
      evidence: 'positive',
    });
  });

  it('この画面は修正前の判定が当たる位置にある: 引用は末尾 15 行の中、ただし入力欄より上', () => {
    const frame = normalizeFrame(capture(IDLE_QUOTED));
    const box = findClaudeInputBox(frame.contentLines as string[]);
    expect(box).not.toBeNull();

    // 修正前の規則（末尾 15 行のどこかに当たれば選択リスト）はこの画面で当たる。
    expect(CLAUDE_SELECTION_LIST_FOOTER.test(frame.lastLines)).toBe(true);

    // 当たる行はすべて入力欄の上端より上（会話の本文）にあり、入力欄以降には無い。
    const quotedRows = frame.contentLines.flatMap((row, i) =>
      CLAUDE_SELECTION_LIST_FOOTER.test(row) ? [i] : [],
    );
    expect(quotedRows.length).toBeGreaterThan(0);
    expect(Math.max(...quotedRows)).toBeLessThan(box!.openingSeparator);
    expect(CLAUDE_SELECTION_LIST_FOOTER.test(frame.contentLines.slice(box!.openingSeparator).join('\n'))).toBe(false);
  });
});

describe('入力欄が見えていても、フッタが入力欄以降にあれば選択リストのまま', () => {
  // 実機の採取ではない。上の idle 画面の最下行（ステータスバー）1 行だけを
  // 本物のフッタ文言に差し替えた派生フレームで、「入力欄より上だけを外す」が
  // 「入力欄の下まで外す」に広がっていないことを押さえる。
  const swapStatusBar = (footer: string): string => {
    const rows = capture(IDLE_QUOTED).split('\n');
    const last = rows.map(row => row.trim() !== '').lastIndexOf(true);
    rows[last] = footer;
    return rows.join('\n');
  };

  it.each([
    ['Enter to select', '  Enter to select · ↑/↓ to navigate · Esc to cancel'],
    ['Enter to set as default', '  Enter to set as default · s to use this session only · Esc to cancel'],
  ])('ステータスバーの位置の「%s」フッタ', (_name, footer) => {
    const raw = swapStatusBar(footer);
    expect(findClaudeInputBox(normalizeFrame(raw).contentLines as string[])).not.toBeNull();

    for (const [, toForm] of FORMS) {
      expect(detectSessionStatus(toForm(raw), 'claude')).toMatchObject({
        status: 'waiting',
        reason: STATUS_REASON.CLAUDE_SELECTION_LIST,
      });
    }
  });
});

/**
 * 陰性対照: 実機の選択画面・承認画面。判定は修正前（develop 0cb83417）で採った値で、
 * 修正後も同じでなければならない。
 *
 * `prompt_detected` の行は共有の prompt 検出（`afterPrompt` より前）で決まるので、
 * この変更が届く手前にある。この変更で結果が動きうるのは `claude_selection_list` の
 * 2 行（どちらも入力欄が無く、選択画面が入力欄と入れ替わっている画面）。
 */
describe('陰性対照: 実機の選択画面・承認画面は修正前と同じ判定', () => {
  const PROMPT = STATUS_REASON.PROMPT_DETECTED;
  const SELECTION_LIST = STATUS_REASON.CLAUDE_SELECTION_LIST;

  const BEFORE_2847: ReadonlyArray<readonly [string, 'waiting', string]> = [
    // tui-frame-footer-2776（claude 2.1.278）
    [`${FOOTERS_2776}/claude-2.1.278-picker-below-quoted-footers.txt`, 'waiting', PROMPT],
    [`${FOOTERS_2776}/claude-2.1.278-approval-below-quoted-footers.txt`, 'waiting', PROMPT],
    [`${FOOTERS_2776}/claude-2.1.278-askuserquestion-picker.txt`, 'waiting', PROMPT],
    [`${FOOTERS_2776}/claude-2.1.278-askuserquestion-task-panel.txt`, 'waiting', PROMPT],
    [`${FOOTERS_2776}/claude-2.1.278-bash-approval.txt`, 'waiting', PROMPT],
    [`${FOOTERS_2776}/claude-2.1.278-bash-approval-task-panel.txt`, 'waiting', PROMPT],
    [`${FOOTERS_2776}/claude-2.1.278-edit-approval.txt`, 'waiting', PROMPT],
    // /model の選択画面（入力欄が無い）
    ['tests/fixtures/claude-model-switch-2361/fullscreen-picker-open.txt', 'waiting', SELECTION_LIST],
    ['tests/fixtures/canary/model-overlay.raw.txt', 'waiting', SELECTION_LIST],
    // AskUserQuestion（2486: preview / タブ、2468: 送信確認）
    ['tests/fixtures/claude-live-2486/preview-q1.txt', 'waiting', PROMPT],
    ['tests/fixtures/claude-live-2486/preview-q1-cursor-on-2.txt', 'waiting', PROMPT],
    ['tests/fixtures/claude-live-2486/preview-numbered-q1.txt', 'waiting', PROMPT],
    ['tests/fixtures/claude-live-2486/preview-numbered-q1-cursor-on-2.txt', 'waiting', PROMPT],
    ['tests/fixtures/claude-live-2486/tabs-q1.txt', 'waiting', PROMPT],
    ['tests/fixtures/claude-live-2486/tabs-preview-q1.txt', 'waiting', PROMPT],
    ['tests/fixtures/claude-live-2486/tabs-preview-q2.txt', 'waiting', PROMPT],
    ['tests/fixtures/claude-live-2486/tabs-preview-review.txt', 'waiting', PROMPT],
    ['tests/fixtures/claude-live-2468/askuserquestion-submit-files-edited-panel.txt', 'waiting', PROMPT],
    ['tests/fixtures/claude-live-2468/askuserquestion-submit-files-edited-panel.control-no-panel.txt', 'waiting', PROMPT],
    // task panel つき（1708）と canary の承認画面
    ['tests/unit/lib/detection/fixtures/claude-live-1708/askuserquestion-submit-taskpanel.txt', 'waiting', PROMPT],
    ['tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt', 'waiting', PROMPT],
    ['tests/fixtures/canary/permission-dialog.raw.txt', 'waiting', PROMPT],
  ];

  describe.each(FORMS)('%s', (_form, toForm) => {
    it.each(BEFORE_2847)('%s → %s / %s', (fixture, status, reason) => {
      const result = detectSessionStatus(toForm(capture(fixture)), 'claude');
      expect(result.status).toBe(status);
      expect(result.reason).toBe(reason);
    });
  });

  it('入力欄が無い /model の選択画面は、末尾 15 行を読む従来の判定のまま', () => {
    for (const fixture of [
      'tests/fixtures/claude-model-switch-2361/fullscreen-picker-open.txt',
      'tests/fixtures/canary/model-overlay.raw.txt',
    ]) {
      const frame = normalizeFrame(capture(fixture));
      expect(findClaudeInputBox(frame.contentLines as string[])).toBeNull();
      expect(CLAUDE_SELECTION_LIST_FOOTER.test(frame.lastLines)).toBe(true);
    }
  });
});
