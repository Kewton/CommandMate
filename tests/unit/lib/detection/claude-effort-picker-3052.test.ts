/** @vitest-environment node */

/**
 * Issue #3052: claude 2.1.257+ の `/effort` スライダーが選択画面と判定されなかった。
 * 案内文 `←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel` が
 * `CLAUDE_SELECTION_LIST_FOOTER` のどの枝にも合わなかった。
 *
 * fixture は実機採取（claude 2.1.286、--model haiku、私設 tmux、2026-10-01、ANSI 付き）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDetectPromptOptions, CLAUDE_SELECTION_LIST_FOOTER } from '@/lib/detection/cli-patterns';
import { stripAnsi } from '@/lib/detection/ansi';
import { findClaudeInputBox } from '@/lib/detection/composer-text';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { normalizeFrame } from '@/lib/detection/tools/frame';

const ROOT = process.cwd();
const DIR = 'tests/fixtures/claude-effort-picker-3052';
const capture = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const EFFORT = capture(`${DIR}/claude-2.1.286-effort.raw.txt`);
const MODEL = capture(`${DIR}/claude-2.1.286-model.raw.txt`);
const MODEL_FIXTURE_2361 = capture('tests/fixtures/claude-model-switch-2361/fullscreen-picker-open.txt');
const EFFORT_FOOTER = '←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel';

const FORMS = [
  ['ANSI 付き', (raw: string): string => raw],
  ['stripAnsi 後', stripAnsi],
] as const;

/** /model を開いて Esc で閉じた直後の /effort: ピッカーの上に 2 行が残る。 */
const withKeptModelAbove = (raw: string): string => {
  const rows = raw.split('\n');
  const at = rows.findIndex(row => stripAnsi(row).trim() === 'Effort');
  expect(at).toBeGreaterThan(0);
  rows.splice(at, 0, '❯ /model', '  ⎿  Kept model as Haiku 4.5', '');
  return rows.join('\n');
};

describe('Issue #3052: /effort 選択画面（実機, claude 2.1.286）', () => {
  beforeEach(() => resetDetectPromptCache());

  it('案内文は CLAUDE_SELECTION_LIST_FOOTER に合う', () => {
    expect(CLAUDE_SELECTION_LIST_FOOTER.test(EFFORT_FOOTER)).toBe(true);
  });

  it.each(FORMS)('%s: waiting / claude_selection_list / hasActivePrompt=false', (_f, toForm) => {
    expect(detectSessionStatus(toForm(EFFORT), 'claude')).toMatchObject({
      status: 'waiting',
      reason: STATUS_REASON.CLAUDE_SELECTION_LIST,
      hasActivePrompt: false,
    });
  });

  it.each(FORMS)('%s: 直前の /model を Esc で閉じた後でも同じ判定', (_f, toForm) => {
    const raw = withKeptModelAbove(EFFORT);
    expect(detectSessionStatus(toForm(raw), 'claude')).toMatchObject({
      status: 'waiting',
      reason: STATUS_REASON.CLAUDE_SELECTION_LIST,
      hasActivePrompt: false,
    });
  });

  it.each(FORMS)('%s: detectPrompt は isPrompt=false（Auto-Yes は反応しない）', (_f, toForm) => {
    for (const raw of [EFFORT, withKeptModelAbove(EFFORT)]) {
      expect(detectPrompt(toForm(raw), buildDetectPromptOptions('claude')).isPrompt).toBe(false);
    }
  });

  it('陰性対照: /model の画面は従来どおり claude_selection_list', () => {
    for (const raw of [MODEL, MODEL_FIXTURE_2361]) {
      expect(detectSessionStatus(raw, 'claude')).toMatchObject({
        status: 'waiting',
        reason: STATUS_REASON.CLAUDE_SELECTION_LIST,
      });
    }
  });

  it('陰性対照: 信頼ダイアログ・承認ダイアログの案内文は /effort の枝に合わない', () => {
    expect(CLAUDE_SELECTION_LIST_FOOTER.test('Enter to confirm · Esc to cancel')).toBe(true); // 従来の枝
    expect(CLAUDE_SELECTION_LIST_FOOTER.test('Esc to cancel · Tab to amend')).toBe(false);
    expect(CLAUDE_SELECTION_LIST_FOOTER.test('s for this session only')).toBe(false);
  });
});

describe('Issue #3052: 返答の本文で引用された /effort の案内文は選択画面ではない', () => {
  it.each(FORMS)('%s: 入力欄が出ている待機中の画面は ready のまま', (_f, toForm) => {
    const raw = capture('tests/fixtures/tui-frame-footer-2776/claude-2.1.278-idle-quoted-footers.txt');
    const rows = raw.split('\n');
    const box = findClaudeInputBox(normalizeFrame(raw).contentLines as string[]);
    expect(box).not.toBeNull();
    // 入力欄より上（会話の本文）の最後の空でない行を、引用した案内文に差し替える。
    let at = -1;
    for (let i = 0; i < box!.openingSeparator; i++) if (stripAnsi(rows[i]).trim() !== '') at = i;
    rows[at] = `  ${EFFORT_FOOTER}`;
    const quoted = rows.join('\n');
    expect(CLAUDE_SELECTION_LIST_FOOTER.test(stripAnsi(quoted).split('\n').slice(at, at + 1).join('\n'))).toBe(true);

    expect(detectSessionStatus(toForm(quoted), 'claude')).toMatchObject({
      status: 'ready',
      reason: STATUS_REASON.INPUT_PROMPT,
      hasActivePrompt: false,
    });
  });
});
