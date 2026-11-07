/**
 * Issue #4115: the starting message fixes the worker's role. If the process it started
 * is not the one about to get the contract, the contract is not sent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT_ROLE_CHANGED,
  main,
  rolePinHolds,
  rolePinOf,
} from '../../../../scripts/orchestrate/launch-worker.mjs';

const PIN = { sessionGeneration: 'g1', injectionFingerprint: 'f1' };

let tmp: string;
let worktree: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-launch-worker-role-'));
  worktree = path.join(tmp, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A CLI whose `capture --json` answers come from a list, the last repeating. */
function fakeCli(captures: Array<Record<string, unknown>>) {
  const calls: string[][] = [];
  let read = 0;
  let running = false;
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (command === 'git') return ok();
    const verb = args[0];
    if (verb === 'capture') {
      const answer = captures[Math.min(read, captures.length - 1)];
      read += 1;
      return ok(JSON.stringify({ model: 'claude-opus-5-5', sessionStatus: 'ready', ...answer }));
    }
    if (verb === 'instances') {
      return ok(JSON.stringify([{ instanceId: 'claude', isRunning: running, autoYes: { enabled: false } }]));
    }
    if (verb === 'stop' || verb === 'kill') {
      running = false;
      return ok();
    }
    if (verb === 'send') {
      running = true;
      return ok(args.includes('--contract') ? 'task-1\n' : 'sent\n');
    }
    return ok();
  };
  return { run, calls };
}

function go(fake: ReturnType<typeof fakeCli>) {
  const log: string[] = [];
  const out: string[] = [];
  const code = main(
    [
      'send',
      '--run-dir', path.join(tmp, 'run'),
      '--issue', '4115',
      '--wt', 'wt-1',
      '--worktree', worktree,
      '--instance', 'claude',
      '--contract', '.commandmate/tasks/issue-4115.yaml',
      '--model', 'opus',
    ],
    { run: fake.run, sleep: () => {}, out: (line: string) => out.push(line), log: (line: string) => log.push(line), error: (line: string) => log.push(line) }
  );
  return { code, out, log };
}

const contractSent = (fake: ReturnType<typeof fakeCli>) => fake.calls.some((call) => call.includes('--contract'));

describe('rolePinOf / rolePinHolds', () => {
  it('reads what the server reports, and nothing from one that reports nothing', () => {
    expect(rolePinOf({ roleLaunch: PIN })).toEqual(PIN);
    expect(rolePinOf({ model: 'x' })).toBeNull();
    expect(rolePinOf(null)).toBeNull();
  });

  it('holds only for the same generation and fingerprint', () => {
    expect(rolePinHolds(PIN, { ...PIN })).toBe(true);
    expect(rolePinHolds(PIN, { ...PIN, sessionGeneration: 'g2' })).toBe(false);
    expect(rolePinHolds(PIN, { ...PIN, injectionFingerprint: 'f2' })).toBe(false);
    expect(rolePinHolds({ ...PIN, injectionFingerprint: null }, { ...PIN, injectionFingerprint: null })).toBe(true);
    // The process it described is no longer known.
    expect(rolePinHolds(PIN, null)).toBe(false);
    // A server with no role layer has nothing to change.
    expect(rolePinHolds(null, null)).toBe(true);
  });
});

describe('between the starting message and the contract', () => {
  it('same process, same role: the contract goes', () => {
    const fake = fakeCli([{ roleLaunch: PIN }]);
    const r = go(fake);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['task-1']);
    expect(contractSent(fake)).toBe(true);
  });

  it('a server that reports no role behaves as before', () => {
    const fake = fakeCli([{}]);
    expect(go(fake).code).toBe(0);
    expect(contractSent(fake)).toBe(true);
  });

  it('the process was replaced: stopped, and no contract', () => {
    const fake = fakeCli([{ roleLaunch: PIN }, { roleLaunch: { ...PIN, sessionGeneration: 'g2' } }]);
    const r = go(fake);
    expect(r.code).toBe(EXIT_ROLE_CHANGED);
    expect(contractSent(fake)).toBe(false);
    expect(r.log.join('\n')).toMatch(/role changed: .*contract not sent/);
  });

  it('it came back with another role: stopped, and no contract', () => {
    const fake = fakeCli([{ roleLaunch: PIN }, { roleLaunch: { ...PIN, injectionFingerprint: 'f2' } }]);
    expect(go(fake).code).toBe(EXIT_ROLE_CHANGED);
    expect(contractSent(fake)).toBe(false);
  });
});
