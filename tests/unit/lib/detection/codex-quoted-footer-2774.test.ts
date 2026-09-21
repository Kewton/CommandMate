/**
 * codex: 会話本文が picker フッタを引用するとフレームが切れる（Issue 2774）
 *
 * `normalizeTuiFrameForDetection` はフッタ以降を捨てるが、「もっと新しい対話が下にある」
 * ときは捨てない。その判定に使うアンカーが `[>❯]` だけで、codex の composer `›`(U+203A) を
 * 拾えなかったため、引用 1 行でエージェントの出力全部と composer が消えていた。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { normalizeTuiFrameForDetection } from '@/lib/detection/tui-detection-frame';
import { STATUS_REASON } from '@/lib/detection/status-reason';

const FIXTURE = path.join(
  process.cwd(),
  'tests/fixtures/codex-quoted-footer-2774/idle-after-quoted-picker-footer.txt',
);
const frame = (): string => readFileSync(FIXTURE, 'utf8');

describe('引用されたフッタ文言でフレームが切れない (Issue 2774)', () => {
  it('idle な codex を ready と読む', () => {
    const verdict = detectSessionStatus(frame(), 'codex');
    expect(verdict.status).toBe('ready');
    expect(verdict.reason).toBe(STATUS_REASON.INPUT_PROMPT);
  });

  it('根拠のない verdict（evidence=none）にならない', () => {
    expect(detectSessionStatus(frame(), 'codex').evidence).toBe('positive');
  });

  it('正規化がフッタ以降を捨てず、composer が残る', () => {
    const normalized = normalizeTuiFrameForDetection(frame());
    expect(normalized).toContain('Ask Codex to do anything');
  });

  it('引用行より下のエージェントの出力も残る', () => {
    // 引用行そのものは「古いフッタ」として切り捨てられる（下に新しいアンカーがあるときの既存挙動）。
    expect(normalizeTuiFrameForDetection(frame())).toContain('DONE: must 0 件 / should 2 件');
  });

  it('他ツールの composer は従来どおり拾える（陰性対照）', () => {
    const claudeFrame = frame().replace(/›/g, '❯');
    expect(normalizeTuiFrameForDetection(claudeFrame)).toContain('Ask Codex to do anything');
  });
});
