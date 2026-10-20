/**
 * 信頼の確認かどうかを、画面側がフレームから読む（Issue #3758）
 *
 * `isTrustConfirmationFrame` は、検出器の述語（`isAntigravityTrustScreen`）を、検出器と
 * 同じ行数の末尾に当てるだけのもの。新しい検出の写しではないことを、ここで固定する:
 *
 *  - 末尾の行数が検出器の `STATUS_CHECK_LINE_COUNT` と同じ
 *  - 実フレーム（`tests/fixtures/antigravity-live-2364/`）すべてで、検出器が
 *    `normalizeFrame(…).lastLines` に当てた答えと一致する
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isTrustConfirmationFrame,
  TRUST_CONFIRMATION_TAIL_LINE_COUNT,
} from '@/lib/detection/selection-shape';
import { isAntigravityTrustScreen } from '@/lib/detection/tools/antigravity/patterns';
import { normalizeFrame, STATUS_CHECK_LINE_COUNT } from '@/lib/detection/tools/frame';

const LIVE_2364 = path.resolve(__dirname, '../../../fixtures/antigravity-live-2364');
const frame = (name: string): string => readFileSync(path.join(LIVE_2364, name), 'utf8');
const FIXTURES = readdirSync(LIVE_2364).filter((f) => f.endsWith('.txt')).sort();

describe('[#3758] isTrustConfirmationFrame', () => {
  it('陽性: agy の実フレーム（信頼の確認）を信頼の確認と読む', () => {
    expect(isTrustConfirmationFrame(frame('trust-dialog.txt'), 'antigravity')).toBe(true);
  });

  it('陰性: 同じフレームでも、agy 以外のツールでは読まない', () => {
    for (const tool of ['claude', 'codex', 'copilot', 'command-code', 'opencode']) {
      expect(isTrustConfirmationFrame(frame('trust-dialog.txt'), tool), tool).toBe(false);
    }
    expect(isTrustConfirmationFrame(frame('trust-dialog.txt'), null)).toBe(false);
  });

  it('陰性: 番号の付かない別の選択（Switch Model・スラッシュのポップアップ）と、番号付きの dialog は読まない', () => {
    for (const name of [
      'picker-switch-model.txt',
      'popup-slash-commands.txt',
      'dialog-bash-oneline.txt',
      'dialog-create-file.txt',
      'boot-idle.txt',
    ]) {
      expect(isTrustConfirmationFrame(frame(name), 'antigravity'), name).toBe(false);
    }
  });

  it('陰性: 空・無し', () => {
    expect(isTrustConfirmationFrame('', 'antigravity')).toBe(false);
    expect(isTrustConfirmationFrame(null, 'antigravity')).toBe(false);
    expect(isTrustConfirmationFrame(undefined, 'antigravity')).toBe(false);
  });

  it('陰性: 答えた後、質問が末尾の窓より上に流れたら読まない', () => {
    const answered = [
      frame('trust-dialog.txt').replace(/\s+$/, ''),
      ...Array.from({ length: TRUST_CONFIRMATION_TAIL_LINE_COUNT }, (_, i) => `line ${i}`),
      '↑/↓ Navigate · enter Confirm',
    ].join('\n');
    expect(isTrustConfirmationFrame(answered, 'antigravity')).toBe(false);
  });

  it('末尾の行数は、検出器の lastLines の窓（STATUS_CHECK_LINE_COUNT）と同じ', () => {
    expect(TRUST_CONFIRMATION_TAIL_LINE_COUNT).toBe(STATUS_CHECK_LINE_COUNT);
  });

  it.each(FIXTURES)('%s: 検出器が lastLines に当てた答えと一致する', (name) => {
    const raw = frame(name);
    expect(isTrustConfirmationFrame(raw, 'antigravity')).toBe(
      isAntigravityTrustScreen(normalizeFrame(raw, 'antigravity').lastLines),
    );
  });
});
