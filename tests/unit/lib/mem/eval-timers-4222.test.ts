/**
 * The evaluation leaves no timer and no child behind (Issue #4222, design §7 G3〜G5,
 * P2-5): a caller stops waiting at its own deadline; the shared child lives by its own
 * timeout and `abort`, and the last caller to leave takes it with it.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { withDeadline } from '@/lib/mem/eval-deadline';
import { QueryPlan, sharedQueryCount, DEFAULT_QUERY_LIMITS, type MemExec, type ExecResult } from '@/lib/mem/query-plan';

const done = (stdout = '{}'): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false, aborted: false, missing: false, overflow: false });

/** An exec that answers after `ms` (fake timers), or ends `aborted` when its signal fires. */
function slowExec(ms: number | null, counters: { started: number; finished: number; aborted: number }): MemExec {
  return (_file, _args, options) =>
    new Promise<ExecResult>((resolve) => {
      counters.started += 1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: ExecResult) => {
        if (timer !== undefined) clearTimeout(timer);
        counters.finished += 1;
        resolve(result);
      };
      if (ms !== null) timer = setTimeout(() => finish(done('{"ok":1}')), ms);
      options.signal.addEventListener('abort', () => {
        counters.aborted += 1;
        finish({ ...done(''), code: null, aborted: true });
      });
    });
}

const spec = { class: 'external' as const, key: 'gh-issue:github.com/a/b#1', file: 'gh' as const, args: ['api', 'x'] };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('timers (G3)', () => {
  it('withDeadline leaves no timer whichever way it ends', async () => {
    await withDeadline(Promise.resolve(1), 1000);
    expect(vi.getTimerCount()).toBe(0);
    const late = withDeadline(new Promise<number>(() => undefined), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await late).toEqual({ ok: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('(positive control) a deadline helper without clearTimeout leaves one: the count catches it', async () => {
    const leaky = <T>(promise: Promise<T>, ms: number) =>
      Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
    await leaky(Promise.resolve(1), 1000);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    vi.clearAllTimers();
  });

  it('evaluations run at once leave no timer when all are done, also when a query timed out or a deadline cut it', async () => {
    const counters = { started: 0, finished: 0, aborted: 0 };
    const exec = slowExec(4000, counters);
    const now = () => Date.now();
    const quick = new QueryPlan(exec, now, Date.now() + 3000);
    const slow = new QueryPlan(exec, now, Date.now() + 10_000);
    const a = quick.run(spec);
    const b = slow.run(spec);
    const c = slow.run({ ...spec, key: 'gh-issue:github.com/a/b#2' });
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([a, b, c]);
    expect(vi.getTimerCount()).toBe(0);
    expect(sharedQueryCount()).toBe(0);
    expect(counters.started).toBe(counters.finished);
  });
});

describe('children (G4・G5)', () => {
  it('G4: one caller, a child that never answers → the caller leaves at its deadline, the child is aborted, the table is empty', async () => {
    const counters = { started: 0, finished: 0, aborted: 0 };
    const plan = new QueryPlan(slowExec(null, counters), () => Date.now(), Date.now() + 3000);
    const outcome = plan.run(spec);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await outcome).toEqual({ ok: false, reason: 'deadline_exceeded' });
    expect(counters).toEqual({ started: 1, finished: 1, aborted: 1 });
    expect(sharedQueryCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('G5: a 3 s brief and a 10 s check share a 4 s query: the brief leaves, the child lives, the check gets the answer', async () => {
    const counters = { started: 0, finished: 0, aborted: 0 };
    const exec = slowExec(4000, counters);
    const brief = new QueryPlan(exec, () => Date.now(), Date.now() + 3000);
    const check = new QueryPlan(exec, () => Date.now(), Date.now() + 10_000);
    const a = brief.run(spec);
    const b = check.run(spec);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await a).toEqual({ ok: false, reason: 'deadline_exceeded' });
    expect(counters.aborted).toBe(0);
    expect(sharedQueryCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    const answer = await b;
    expect(answer.ok && answer.result.stdout).toBe('{"ok":1}');
    expect(counters).toEqual({ started: 1, finished: 1, aborted: 0 });
    expect(sharedQueryCount()).toBe(0);
  });

  it('(control) both leave before the answer → the child is aborted, no timer, an empty table', async () => {
    const counters = { started: 0, finished: 0, aborted: 0 };
    const exec = slowExec(8000, counters);
    const one = new QueryPlan(exec, () => Date.now(), Date.now() + 2000);
    const two = new QueryPlan(exec, () => Date.now(), Date.now() + 3000);
    const a = one.run(spec);
    const b = two.run(spec);
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([a, b]);
    expect(counters.aborted).toBe(1);
    expect(sharedQueryCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a budget of 1 asks once and answers the rest as exhausted without a child', async () => {
    const counters = { started: 0, finished: 0, aborted: 0 };
    const plan = new QueryPlan(slowExec(10, counters), () => Date.now(), Date.now() + 3000, { ...DEFAULT_QUERY_LIMITS, externalPerEvaluation: 1 });
    const first = plan.run(spec);
    const second = plan.run({ ...spec, key: 'other' });
    await vi.advanceTimersByTimeAsync(10);
    expect((await first).ok).toBe(true);
    expect(await second).toEqual({ ok: false, reason: 'query_budget_exhausted' });
    expect(counters.started).toBe(1);
  });
});
