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
  it('複数選択として認識し、回答不能（unsupported）と答える', () => {
    const reading = readCommandCodeQuestionDialog(read(FRAME));
    expect(reading.kind).toBe('unsupported');
    expect(reading.kind === 'unsupported' ? reading.reason : null).toBe('multi-select');
  });

  it('検出チェーンは回答可能な promptData を publish しない', () => {
    const verdict = commandCodeStatusDetector.detect(normalizeFrame(read(FRAME)));
    expect(verdict.status).toBe('waiting');
    expect(verdict.reason).toBe(STATUS_REASON.COMMAND_CODE_SELECTION_LIST);
    expect(verdict.hasActivePrompt).toBe(false);
    expect(verdict.promptDetection?.promptData).toBeUndefined();
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
