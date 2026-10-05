/**
 * 「まだ何も届いていない」の一覧（Issue #3304）
 *
 * `PANE_GATE_NOTHING_ARRIVED` は、PC の pane のフックとスマホのコントローラーが、
 * 最初の値にも、対象が変わったときに戻す値にも使う。ここで確かめるのは値そのもの:
 * この一覧のままでは、モードのボタンは押せず、チップも出ない。
 */

import { describe, it, expect } from 'vitest';
import {
  PANE_GATE_NOTHING_ARRIVED,
  isSamePaneGateState,
  type PaneGateState,
} from '@/lib/session/pane-gate-state';
import { canCycleAgentMode } from '@/components/worktree/AgentModeControl';
import { isReadableAgentMode } from '@/lib/detection/agent-mode';

describe('[#3304] PANE_GATE_NOTHING_ARRIVED', () => {
  it('モードのボタンは押せない（ほかに何も画面に出ていなくても）', () => {
    expect(canCycleAgentMode({ ...PANE_GATE_NOTHING_ARRIVED, isPromptWaiting: false })).toBe(false);
  });

  it('モードは「不明」で、チップに出せる値ではない', () => {
    expect(PANE_GATE_NOTHING_ARRIVED.agentMode).toBe('unknown');
    expect(isReadableAgentMode(PANE_GATE_NOTHING_ARRIVED.agentMode)).toBe(false);
  });

  it('どのフラグも立っておらず、起動中でもない', () => {
    expect(PANE_GATE_NOTHING_ARRIVED).toEqual({
      sessionStatus: '',
      agentMode: 'unknown',
      isSelectionListActive: false,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      startingSince: null,
    });
  });

  it('書き換えられない（2 つのフックが同じ物を共有する）', () => {
    expect(Object.isFrozen(PANE_GATE_NOTHING_ARRIVED)).toBe(true);
  });
});

describe('[#3304] isSamePaneGateState', () => {
  const ready: PaneGateState = { ...PANE_GATE_NOTHING_ARRIVED, sessionStatus: 'ready', agentMode: 'plan' };

  it('すべての欄が同じなら true（別の object でも）', () => {
    expect(isSamePaneGateState(ready, { ...ready })).toBe(true);
  });

  it.each(Object.keys(PANE_GATE_NOTHING_ARRIVED) as Array<keyof PaneGateState>)(
    '`%s` だけが違えば false',
    (key) => {
      const moved: Record<keyof PaneGateState, PaneGateState[keyof PaneGateState]> = {
        sessionStatus: 'running',
        agentMode: 'auto',
        isSelectionListActive: true,
        isPagerActive: true,
        isDismissablePanelActive: true,
        isUnclassifiedActive: true,
        startingSince: 1_700_000_000_000,
      };
      expect(isSamePaneGateState(ready, { ...ready, [key]: moved[key] })).toBe(false);
    },
  );

  it('一覧に無い欄（コントローラーの `offersPlanApprove`）も比べる', () => {
    const a = { ...ready, offersPlanApprove: false };
    expect(isSamePaneGateState(a, { ...a, offersPlanApprove: true })).toBe(false);
  });
});
