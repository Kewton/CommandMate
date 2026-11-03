/**
 * Issue #4116: what the starting message fixed goes with the contract, so the server
 * can hold it right up to the first key. `tests/integration/cli-roles-4116.test.ts`
 * has the other half: `send --expect-*` against a process really replaced.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT_ROLE_CHANGED,
  EXIT_ROLE_NOT_SENT,
  EXIT_STOP_UNCONFIRMED,
  main,
  rolePinArgs,
} from '../../../../scripts/orchestrate/launch-worker.mjs';
import { RoleExitCode } from '@/cli/types';

const PIN = { sessionGeneration: 'g1', injectionFingerprint: 'f1' };

let tmp: string;
let worktree: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-launch-worker-pin-'));
  worktree = path.join(tmp, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface FakeOptions {
  capture: Record<string, unknown>;
  /** The contract send's exit code. */
  contractExit?: number;
  /** The kill does not take. */
  stuck?: boolean;
}

function fakeCli({ capture, contractExit = 0, stuck = false }: FakeOptions) {
  const calls: string[][] = [];
  let running = false;
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (command === 'git') return ok();
    if (args[0] === 'capture') return ok(JSON.stringify({ model: 'claude-opus-5-5', sessionStatus: 'ready', ...capture }));
    if (args[0] === 'instances') {
      if (args[2] === 'kill') {
        running = stuck;
        return ok();
      }
      return ok(JSON.stringify([{ instanceId: 'claude', running, autoYes: false }]));
    }
    if (args[0] === 'send') {
      running = true;
      if (args.includes('--contract')) return { status: contractExit, stdout: 'task-1\n', stderr: '' };
      return ok('sent\n');
    }
    return ok();
  };
  return { run, calls };
}

function go(fake: ReturnType<typeof fakeCli>, model = 'opus') {
  const log: string[] = [];
  const out: string[] = [];
  const code = main(
    [
      'send',
      '--run-dir', path.join(tmp, 'run'),
      '--issue', '4116',
      '--wt', 'wt-1',
      '--worktree', worktree,
      '--instance', 'claude',
      '--contract', '.commandmate/tasks/issue-4116.yaml',
      '--model', model,
    ],
    { run: fake.run, sleep: () => {}, out: (line: string) => out.push(line), log: (line: string) => log.push(line), error: (line: string) => log.push(line) }
  );
  return { code, out, log };
}

const contractCall = (fake: ReturnType<typeof fakeCli>) => fake.calls.find((call) => call.includes('--contract'));

describe('rolePinArgs', () => {
  it('a role, no role, and nothing read', () => {
    expect(rolePinArgs(PIN)).toEqual(['--expect-role-generation', 'g1', '--expect-role-fingerprint', 'f1']);
    expect(rolePinArgs({ sessionGeneration: 'g1', injectionFingerprint: null })).toEqual(['--expect-role-generation', 'g1', '--expect-no-role']);
    expect(rolePinArgs(null)).toEqual([]);
  });
});

describe('the contract carries the pin', () => {
  it('what was read goes with it', () => {
    const fake = fakeCli({ capture: { roleLaunch: PIN } });
    expect(go(fake).code).toBe(0);
    expect(contractCall(fake)).toEqual(expect.arrayContaining(['--expect-role-generation', 'g1', '--expect-role-fingerprint', 'f1']));
  });

  it('a process with no role is pinned as that', () => {
    const fake = fakeCli({ capture: { roleLaunch: { sessionGeneration: 'g1', injectionFingerprint: null } } });
    expect(go(fake).code).toBe(0);
    expect(contractCall(fake)).toEqual(expect.arrayContaining(['--expect-role-generation', 'g1', '--expect-no-role']));
  });

  it('a server reporting no role: the contract is the send it always was', () => {
    const fake = fakeCli({ capture: {} });
    expect(go(fake).code).toBe(0);
    expect(contractCall(fake)?.some((arg) => arg.startsWith('--expect'))).toBe(false);
  });

  it('with no model to pin, nothing was read, and nothing is added', () => {
    const fake = fakeCli({ capture: { roleLaunch: PIN } });
    expect(go(fake, '-').code).toBe(0);
    expect(contractCall(fake)?.some((arg) => arg.startsWith('--expect'))).toBe(false);
  });
});

describe('the server refuses the pin', () => {
  it('uses the exit code the CLI defines', () => {
    expect(EXIT_ROLE_NOT_SENT).toBe(RoleExitCode.NOT_SENT);
  });

  it('stopped, disarmed and 44, with the task id still reported', () => {
    const fake = fakeCli({ capture: { roleLaunch: PIN }, contractExit: EXIT_ROLE_NOT_SENT });
    const result = go(fake);
    expect(result.code).toBe(EXIT_ROLE_CHANGED);
    expect(result.out).toEqual(['task-1']);
    expect(result.log.join('\n')).toMatch(/role changed: .*contract not sent/);
    const afterContract = fake.calls.slice(fake.calls.indexOf(contractCall(fake) as string[]));
    expect(afterContract.some((call) => call[1] === 'auto-yes' && call.includes('--disable'))).toBe(true);
    expect(afterContract.some((call) => call[1] === 'instances' && call[3] === 'kill')).toBe(true);
  });

  it('a stop that cannot be confirmed says that instead', () => {
    const fake = fakeCli({ capture: { roleLaunch: PIN }, contractExit: EXIT_ROLE_NOT_SENT, stuck: true });
    expect(go(fake).code).toBe(EXIT_STOP_UNCONFIRMED);
  });

  it('any other failure of the send is its own exit code, as before', () => {
    const fake = fakeCli({ capture: { roleLaunch: PIN }, contractExit: 99 });
    expect(go(fake).code).toBe(99);
  });

  it('with no pin, a 32 has nothing to do with this script: passed on', () => {
    const fake = fakeCli({ capture: {}, contractExit: EXIT_ROLE_NOT_SENT });
    expect(go(fake).code).toBe(EXIT_ROLE_NOT_SENT);
  });
});
