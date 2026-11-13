/**
 * Issue #4304 F1-a (the contract after §6-6, §3.3-3 / -4): the answer's
 * context (`PaneAnswerContext`) and the one entry through which an answer acts
 * on the current state (`applyWhilePaneIsCurrent`).
 *
 * The type negatives at the end are checked by `tsc` (`tests/**` is in the
 * project): an unused `@ts-expect-error` fails it.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const { checkThrows } = vi.hoisted(() => ({ checkThrows: { on: false } }));

vi.mock('@/lib/session/cli-session', async () => {
  const helper = await import('@tests/unit/session/bound-frame-test-helper');
  const module = helper.withBoundCaptureCliSessionDoubles({});
  const check = module.checkPaneGeneration;
  return {
    ...module,
    checkPaneGeneration: async (...args: Parameters<typeof check>) => {
      if (checkThrows.on) throw new Error('tmux gone');
      return check(...args);
    },
  };
});

import {
  applyWhilePaneIsCurrent,
  paneAnswerContextOf,
  type PaneAnswerContext,
} from '@/lib/session/pane-answer-context';
import { settleStrictAnswer, type StrictAnswerTarget } from '@/lib/session/strict-prompt-answer-io';
import type { StrictRespondResult } from '@/lib/prompt-observation/types';
import {
  TEST_PANE_GENERATION,
  resetTestPaneGenerations,
  setTestPaneGeneration,
  testBoundFrame,
} from '@tests/unit/session/bound-frame-test-helper';

const S = 'mcbd-claude-wt-4304-ctx';
const H = { ...TEST_PANE_GENERATION, paneId: '%99' };

function context(): PaneAnswerContext {
  return paneAnswerContextOf(testBoundFrame('frame of G', { sessionName: S }));
}

beforeEach(() => {
  resetTestPaneGenerations();
  checkThrows.on = false;
});

describe('[#4304 F1-a] applyWhilePaneIsCurrent — the current state only while the session shows G', () => {
  it('negative: G alive and owned — the effect runs, once', async () => {
    const effect = vi.fn(() => undefined);
    expect(await applyWhilePaneIsCurrent(context(), { allowDead: false, owned: () => true }, effect)).toBe('applied');
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('positive: another pane H (the epoch unchanged) — nothing runs', async () => {
    const ctx = context();
    setTestPaneGeneration(S, { generation: H, dead: false });
    const effect = vi.fn(() => undefined);
    expect(await applyWhilePaneIsCurrent(ctx, { allowDead: true, owned: () => true }, effect)).toBe('pane-moved');
    expect(effect).not.toHaveBeenCalled();
  });

  it('positive: the pane cannot be read, or the look throws — nothing runs', async () => {
    const effect = vi.fn(() => undefined);
    setTestPaneGeneration(S, null);
    expect(await applyWhilePaneIsCurrent(context(), { allowDead: true, owned: () => true }, effect)).toBe('pane-moved');
    resetTestPaneGenerations();
    checkThrows.on = true;
    expect(await applyWhilePaneIsCurrent(context(), { allowDead: true, owned: () => true }, effect)).toBe('pane-moved');
    expect(effect).not.toHaveBeenCalled();
  });

  it('G dead: only where the caller allows it (an answer that ended the agent)', async () => {
    const ctx = context();
    setTestPaneGeneration(S, { generation: TEST_PANE_GENERATION, dead: true });
    const effect = vi.fn(() => undefined);
    expect(await applyWhilePaneIsCurrent(ctx, { allowDead: false, owned: () => true }, effect)).toBe('pane-moved');
    expect(await applyWhilePaneIsCurrent(ctx, { allowDead: true, owned: () => true }, effect)).toBe('applied');
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('positive: the caller no longer owns it (its tick, grant or epoch) — the pane look does not replace that', async () => {
    const effect = vi.fn(() => undefined);
    expect(await applyWhilePaneIsCurrent(context(), { allowDead: false, owned: () => false }, effect)).toBe('not-owned');
    expect(effect).not.toHaveBeenCalled();
  });

  it('the ownership is asked after the pane look, not before it', async () => {
    const order: string[] = [];
    let owned = true;
    const ctx = context();
    const pending = applyWhilePaneIsCurrent(
      ctx,
      {
        allowDead: false,
        owned: () => {
          order.push('owned');
          return owned;
        },
      },
      () => {
        order.push('effect');
        return undefined;
      },
    );
    // The look is in flight: the owner changes before it comes back.
    owned = false;
    expect(await pending).toBe('not-owned');
    expect(order).toEqual(['owned']);
  });
});

describe('[#4304 F1-a] type negatives', () => {
  it('a context is made from a bound frame only, and the entry takes no verdict, no raw frame, no async effect', () => {
    const ctx = context();
    const options = { allowDead: false, owned: () => true };
    const db = {} as Database.Database;
    const target = {} as StrictAnswerTarget;
    const result = {} as StrictRespondResult;
    const unreached = (): void => {
      // @ts-expect-error a context is not spelled by hand
      const forged: PaneAnswerContext = { sessionName: S, generation: TEST_PANE_GENERATION, frame: ctx.frame };
      void forged;
      // @ts-expect-error a raw bound frame is not the answer's context
      void applyWhilePaneIsCurrent(ctx.frame, options, () => undefined);
      // @ts-expect-error a bool verdict is not a context
      void applyWhilePaneIsCurrent(true, options, () => undefined);
      // @ts-expect-error an async effect could await after the look
      void applyWhilePaneIsCurrent(ctx, options, async () => undefined);
      // @ts-expect-error a strict answer is not settled without the pane it was decided for
      void settleStrictAnswer(db, target, result, 'cli', () => undefined);
      // @ts-expect-error nor resumed asynchronously
      void settleStrictAnswer(db, target, result, 'cli', { kind: 'pane', context: ctx }, async () => undefined);
    };
    expect(typeof unreached).toBe('function');
  });
});
