/**
 * Issue #4288 (3, review P1): the default exec hands spawnSync a whole-millisecond
 * timeout. A fractional one makes Node throw ERR_OUT_OF_RANGE, which aborted the
 * automatic request after /clear. child_process is mocked (nothing is spawned);
 * state lives under os.tmpdir() and is removed after each test.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ ls: [] as Array<number | undefined>, nonInteger: false }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawnSync: (command: string, args: string[], options: { timeout?: number }) => {
      // what Node does with a fractional timeout
      if (options?.timeout !== undefined && !Number.isInteger(options.timeout)) {
        calls.nonInteger = true;
        throw new RangeError('ERR_OUT_OF_RANGE: timeout must be an integer');
      }
      const ok = (stdout: string) => ({ status: 0, stdout, error: undefined });
      const state = (status: Record<string, unknown>) =>
        JSON.stringify([
          { id: 'mycodebranchdesk', agentInstances: [{ id: 'claude-3', cliTool: 'claude' }], sessionStatusByInstance: { 'claude-3': status } },
        ]);
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return ok(JSON.stringify([{ number: 1, title: 't', author: { login: 'Kewton' }, labels: [{ name: 'agent-health' }], createdAt: 'a' }]));
      }
      if (command === 'gh' && args[0] === 'label') {
        return ok(JSON.stringify(['agent-health', 'metrics', 'security', 'catalog-drift', 'auto-dispatched', 'bug'].map((name) => ({ name }))));
      }
      if (command === 'commandmate' && args[0] === 'ls') {
        calls.ls.push(options?.timeout);
        const ready = calls.ls.length === 1;
        return ok(state({ isRunning: true, isProcessing: !ready, isWaitingForResponse: false, sessionStatusReason: 'thinking_indicator' }));
      }
      return ok('');
    },
  };
});

import { main, READY_TIMEOUT_MS } from '../../../../scripts/agent-health/dispatch-main';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dispatch-spawn-'));
  calls.ls = [];
  calls.nonInteger = false;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('dispatch default exec: spawnSync gets a whole-ms timeout (#4288)', () => {
  it('a fractional monotonic difference (84999.5 ms left) reaches spawnSync as an integer and the run ends with the normal timeout exit', async () => {
    let clock = 1_000_000.5;
    const lines: string[] = [];
    const code = await main(['--state-dir', path.join(root, 'state')], {
      sleep: async (ms) => {
        clock += ms + 0.25;
      },
      now: () => new Date(Date.parse('2026-10-01T00:30:00Z')),
      monotonic: () => clock,
      // send is not under test: never spawn the real CLI
      spawnExec: async () => ({ status: 0, stdout: '' }),
      env: {} as NodeJS.ProcessEnv,
      homedir: path.join(root, 'home'),
      repoRoot: path.join(root, 'repo'),
      reservationDir: path.join(root, 'reservation'),
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(l),
    });
    expect(calls.nonInteger).toBe(false);
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('/clear の後 90 秒で Claude 3 が入力待ちに戻らなかった');
    const waits = calls.ls.slice(1) as number[];
    expect(waits.length).toBeGreaterThan(1);
    for (const t of waits) {
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(READY_TIMEOUT_MS);
    }
    // negative control: the first state check (no explicit timeout) keeps the 300 s default
    // the final window had under 1 ms left and was handed exactly 1 (not 0)
    expect(waits.at(-1)).toBe(1);
    expect(calls.ls[0]).toBe(300_000);
  });
});
