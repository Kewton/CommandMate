/**
 * スマホ: タブが報告したフレームを、ドックの pad が読む（Issue #3305）
 *
 * スマホの選択リストの pad は composer の上にドックされていて、ターミナルのタブの外にある。
 * フレームを持っているのはタブ（`useTerminalPanePolling`）で、画面は持っていない。そこで
 * タブが `useReportSelectionListFrame` で報告し、ドックの pad が
 * `useReportedSelectionListFrame` で読む。
 *
 * この継ぎ目が間違えると起きること: 別の instance のフレーム、あるいは画面から消えた
 * タブのフレームから、番号キーや確定ボタンが決まる。番号キーは画面によってはその場で確定に
 * なる（claude の `/model` では既定のモデルを書き換える）ので、宛先の取り違えは表示の乱れ
 * では済まない。ここではその取り違えが起きないことだけを見る。
 *
 * 画面全体での配線は `selection-list-surfaces-3305.test.tsx` が見る。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useReportSelectionListFrame,
  useReportedSelectionListFrame,
  type SelectionListFrameTarget,
} from '@/components/worktree/SelectionListKeys';

const WORKTREE_ID = 'wt-3305-report';
const FRAME = ['Select model', '❯ 1. Default', '  2. Opus', 'Enter to confirm'].join('\n');

const CLAUDE: SelectionListFrameTarget = { worktreeId: WORKTREE_ID, cliToolId: 'claude' };

/** タブの側。`frame: null` は「自分の poll は選択リストと言っていない」。 */
function report(target: SelectionListFrameTarget, frame: string | null) {
  return renderHook(
    (props: { target: SelectionListFrameTarget; frame: string | null }) =>
      useReportSelectionListFrame({ ...props.target, frame: props.frame }),
    { initialProps: { target, frame } },
  );
}

/** ドックの pad の側。 */
function read(target: SelectionListFrameTarget) {
  return renderHook((props: SelectionListFrameTarget) => useReportedSelectionListFrame(props), {
    initialProps: target,
  });
}

describe('[#3305] 報告されたフレームは、同じ worktree・同じ instance の pad にだけ届く', () => {
  it('報告が無ければ null（タブが画面に無い。今までどおりの pad になる）', () => {
    expect(read(CLAUDE).result.current).toBeNull();
  });

  it('同じ宛先の pad に届く', () => {
    report(CLAUDE, FRAME);

    expect(read(CLAUDE).result.current).toBe(FRAME);
  });

  it('pad が先に描かれていても、後からの報告が届く', () => {
    const pad = read(CLAUDE);
    expect(pad.result.current).toBeNull();

    report(CLAUDE, FRAME);

    expect(pad.result.current).toBe(FRAME);
  });

  it('primary instance は、instanceId を省いても、ツールの id を渡しても同じ宛先', () => {
    report(CLAUDE, FRAME);

    expect(read({ ...CLAUDE, instanceId: 'claude' }).result.current).toBe(FRAME);
  });

  it.each<[string, SelectionListFrameTarget]>([
    ['別のツール', { worktreeId: WORKTREE_ID, cliToolId: 'codex' }],
    ['同じツールの別の instance', { worktreeId: WORKTREE_ID, cliToolId: 'claude', instanceId: 'claude-2' }],
    ['別の worktree', { worktreeId: 'wt-other', cliToolId: 'claude' }],
  ])('%s の pad には届かない', (_name, other) => {
    report(CLAUDE, FRAME);

    expect(read(other).result.current).toBeNull();
    // 陽性対照: 同じ報告が、宛先の合う pad には届いている。
    expect(read(CLAUDE).result.current).toBe(FRAME);
  });
});

describe('[#3305] 報告は、タブが言っている間だけ残る', () => {
  it('`frame: null`（タブの poll が選択リストと言っていない）は、何も報告しない', () => {
    report(CLAUDE, null);

    expect(read(CLAUDE).result.current).toBeNull();
  });

  it('フレームが変われば、pad も新しいフレームを読む', () => {
    const tab = report(CLAUDE, FRAME);
    const pad = read(CLAUDE);
    const next = FRAME.replace('❯ 1. Default', '  1. Default').replace('  2. Opus', '❯ 2. Opus');

    tab.rerender({ target: CLAUDE, frame: next });

    expect(pad.result.current).toBe(next);
  });

  it('選択リストが閉じる（`frame` が null に戻る）と、報告も消える', () => {
    const tab = report(CLAUDE, FRAME);
    const pad = read(CLAUDE);
    expect(pad.result.current).toBe(FRAME);

    tab.rerender({ target: CLAUDE, frame: null });

    expect(pad.result.current).toBeNull();
  });

  it('タブが画面から消える（別のタブへ移る）と、報告も消える', () => {
    const tab = report(CLAUDE, FRAME);
    const pad = read(CLAUDE);
    expect(pad.result.current).toBe(FRAME);

    tab.unmount();

    expect(pad.result.current).toBeNull();
  });

  it('タブが別の instance に切り替わると、前の instance の報告は残らない', () => {
    const codex: SelectionListFrameTarget = { worktreeId: WORKTREE_ID, cliToolId: 'codex' };
    const tab = report(CLAUDE, FRAME);
    const claudePad = read(CLAUDE);
    const codexPad = read(codex);

    tab.rerender({ target: codex, frame: FRAME });

    expect(claudePad.result.current).toBeNull();
    expect(codexPad.result.current).toBe(FRAME);
  });
});
