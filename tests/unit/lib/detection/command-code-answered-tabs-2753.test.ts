/**
 * Command Code 1.54.1: 回答済みタブ（✔）付き AskUserQuestion（Issue #2753）
 *
 * 1.53.0 の `● Dispatch | ◯ Review` しか語彙に無かったため、`✔` 付きのタブ行で
 * 専用リーダが `none` を返し、汎用パーサが複数選択を単一選択として読んでいた。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readCommandCodeQuestionDialog } from '@/lib/detection/tools/command-code/dialog';
import { readCommandCodeQuestionRegion } from '@/lib/detection/selection-shape';
import { commandCodeStatusDetector } from '@/lib/detection/tools/command-code/detect';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { STATUS_REASON } from '@/lib/detection/status-reason';

const FIXTURE_DIR = path.join(process.cwd(), 'tests/fixtures/command-code-askuserquestion-2753');
const read = (name: string): string => readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
const FRAME = 'multiselect-answered-tabs.txt';

describe('回答済みタブ（✔）付きの AskUserQuestion (Issue #2753)', () => {
  // Issue #2755 がこの 2 ケースを反転させた。#2753 の時点では複数選択に回答手段が
  // 無かったので `unsupported`（＝手動操作フォールバック）が正しい終着点だったが、
  // #2755 が検出・型・UI・送信を通したので、同じフレームは**回答可能な複数選択
  // payload** になる。#2753 が本当に固定したかったこと——`✔` 付きタブ行が
  // タブ行として読まれること、ラベルに `[ ]` / `[x]` が残らないこと——は
  // 下で引き続き固定している。
  it('複数選択として読み、checked 付きの payload を返す（#2755 で回答可能に）', () => {
    const reading = readCommandCodeQuestionDialog(read(FRAME));
    expect(reading.kind).toBe('prompt');
    if (reading.kind !== 'prompt') return;
    const data = reading.prompt.promptData;
    expect(data?.type).toBe('multiple_choice');
    if (data?.type !== 'multiple_choice') return;
    expect(data.multiSelect).toBe(true);
    expect(data.options).toHaveLength(5);
    // `3. [x] Update the desktop page too` だけがチェック済み。
    expect(data.options.map((o) => o.checked)).toEqual([false, false, true, false, false]);
    // ラベルからチェックボックスが剥がれている（#2753 が報告した「複数選べない」
    // の見た目そのもの）。
    for (const option of data.options) {
      expect(option.label).not.toMatch(/^\[[ xX✔]\]/);
    }
  });

  it('検出チェーンは複数選択 payload を publish する', () => {
    const verdict = commandCodeStatusDetector.detect(normalizeFrame(read(FRAME)));
    expect(verdict.status).toBe('waiting');
    expect(verdict.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(verdict.hasActivePrompt).toBe(true);
    const data = verdict.promptDetection?.promptData;
    expect(data?.type === 'multiple_choice' && data.multiSelect).toBe(true);
  });

  it('チャット面の番号ボタン抑止が効く（region が読める）', () => {
    expect(readCommandCodeQuestionRegion(read(FRAME))).not.toBeNull();
  });

  it('現在タブ（●）が無い行はタブ行として読まない', () => {
    const frame = read(FRAME).replace('● Update scope', '✔ Update scope');
    expect(readCommandCodeQuestionDialog(frame).kind).toBe('none');
  });

  it('#2522 の既存フィクスチャの判定は変わらない', () => {
    const q = readFileSync(
      path.join(process.cwd(), 'tests/fixtures/command-code-askuserquestion-2522/question-flat-short.txt'),
      'utf8',
    );
    expect(readCommandCodeQuestionDialog(q).kind).toBe('prompt');
  });
});
