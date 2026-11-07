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
  EXIT_AUTO_YES_UNCONFIRMED,
  EXIT_ROLE_CHANGED,
  EXIT_ROLE_CONFLICT,
  EXIT_ROLE_NOT_SENT,
  EXIT_STOP_UNCONFIRMED,
  main,
  roleEvidenceRequired,
  rolePinArgs,
  rolePinOf,
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
  /** What `instances --json` says about roles, for a server that has them. */
  role?: Record<string, unknown>;
  /** How `instances --json --require-roles` fails. */
  rolesRead?: 'failed' | 'old-server' | 'old-cli';
  /** What the grant reads as after the contract's send. */
  autoYesAfter?: boolean;
}

function fakeCli({ capture, contractExit = 0, stuck = false, role, rolesRead, autoYesAfter = false }: FakeOptions) {
  const calls: string[][] = [];
  let running = false;
  let contractSent = false;
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (command === 'git') return ok();
    // `reply --json` resolves --instance through the server (resolve-instance.mjs, #4238 review): the id names itself.
    if (args[0] === 'reply') return ok(JSON.stringify({ instanceId: args[args.indexOf('--instance') + 1], cliToolId: 'claude', reply: null }));
    if (args[0] === 'capture') return ok(JSON.stringify({ model: 'claude-opus-5-5', sessionStatus: 'ready', ...capture }));
    if (args[0] === 'instances') {
      if (args[2] === 'kill') {
        running = stuck;
        return ok();
      }
      if (args.includes('--require-roles')) {
        if (rolesRead === 'failed') return { status: 99, stdout: JSON.stringify({ success: false, error: 'internal_error' }), stderr: 'Error: x' };
        if (rolesRead === 'old-server') return { status: 99, stdout: JSON.stringify({ success: false, error: 'role_api_unavailable' }), stderr: 'Error: x' };
        if (rolesRead === 'old-cli') return { status: 1, stdout: '', stderr: "error: unknown option '--require-roles'" };
      }
      return ok(JSON.stringify([{ instanceId: 'claude', running, autoYes: contractSent && autoYesAfter, ...(role ? { role } : {}) }]));
    }
    if (args[0] === 'send') {
      running = true;
      if (args.includes('--contract')) {
        contractSent = true;
        return { status: contractExit, stdout: 'task-1\n', stderr: '' };
      }
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

  it('stopped and 44, with the task id still reported, and no grant of anyone\'s cut here', () => {
    const fake = fakeCli({ capture: { roleLaunch: PIN }, contractExit: EXIT_ROLE_NOT_SENT });
    const result = go(fake);
    expect(result.code).toBe(EXIT_ROLE_CHANGED);
    expect(result.out).toEqual(['task-1']);
    expect(result.log.join('\n')).toMatch(/role changed: .*contract not sent/);
    const afterContract = fake.calls.slice(fake.calls.indexOf(contractCall(fake) as string[]));
    expect(afterContract.some((call) => call[1] === 'auto-yes')).toBe(false);
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

describe('no role read: nothing to pin, or nothing known', () => {
  const ROLES = { stored: { state: 'inherit' }, effectiveNext: { kind: 'none', source: 'fallback' } };

  it('a server with roles that does not know the process (it restarted): no contract, stopped, 44', () => {
    const fake = fakeCli({ capture: {}, role: ROLES });
    const result = go(fake);
    expect(result.code).toBe(EXIT_ROLE_CHANGED);
    expect(contractCall(fake)).toBeUndefined();
    expect(result.log.join('\n')).toMatch(/role unknown: .*contract not sent/);
    expect(fake.calls.some((call) => call[1] === 'instances' && call[3] === 'kill')).toBe(true);
  });

  it('that stop not confirmed says so', () => {
    expect(go(fakeCli({ capture: {}, role: ROLES, stuck: true })).code).toBe(EXIT_STOP_UNCONFIRMED);
  });

  it('a process started with no role is evidence, and goes (negative control)', () => {
    const fake = fakeCli({ capture: { roleLaunch: { sessionGeneration: 'g1', injectionFingerprint: null } }, role: ROLES });
    expect(go(fake).code).toBe(0);
    expect(contractCall(fake)).toEqual(expect.arrayContaining(['--expect-no-role']));
  });

  it('a tool outside the feature goes with no pin (negative control)', () => {
    const fake = fakeCli({ capture: {}, role: { effectiveNext: { kind: 'none', source: 'unsupported' } } });
    expect(go(fake).code).toBe(0);
    expect(contractCall(fake)?.some((arg) => arg.startsWith('--expect'))).toBe(false);
  });

  it('a server with no role layer goes with no pin (negative control)', () => {
    const fake = fakeCli({ capture: {} });
    expect(go(fake).code).toBe(0);
  });

  it('roleEvidenceRequired reads the row', () => {
    expect(roleEvidenceRequired({ role: ROLES })).toBe(true);
    expect(roleEvidenceRequired({ role: { effectiveNext: { source: 'unsupported' } } })).toBe(false);
    expect(roleEvidenceRequired({ instanceId: 'claude' })).toBe(false);
    expect(roleEvidenceRequired(undefined)).toBe(false);
  });

  it('a fingerprint that is neither text nor null is not read as no role', () => {
    expect(rolePinOf({ roleLaunch: { sessionGeneration: 'g1' } })).toBeNull();
    expect(rolePinOf({ roleLaunch: { sessionGeneration: 'g1', injectionFingerprint: null } })).not.toBeNull();
  });
});

describe('a roster that moved under the contract', () => {
  it('exit 31: not stopped, no grant cut, and the code passed on', () => {
    const fake = fakeCli({ capture: { roleLaunch: PIN }, contractExit: EXIT_ROLE_CONFLICT });
    const result = go(fake);
    expect(result.code).toBe(EXIT_ROLE_CONFLICT);
    const afterContract = fake.calls.slice(fake.calls.indexOf(contractCall(fake) as string[]));
    expect(afterContract.some((call) => call[1] === 'auto-yes')).toBe(false);
    expect(afterContract.some((call) => call[1] === 'instances' && call[3] === 'kill')).toBe(false);
    expect(result.log.join('\n')).not.toContain('still on');
  });

  it('a grant still on is reported, and left', () => {
    const fake = fakeCli({ capture: { roleLaunch: PIN }, contractExit: EXIT_ROLE_CONFLICT, autoYesAfter: true });
    const result = go(fake);
    expect(result.log.join('\n')).toContain('still on');
    expect(fake.calls.filter((call) => call[1] === 'auto-yes' && call.indexOf('--disable') > 0)).toHaveLength(1); // before the start only
  });

  it('uses the exit code the CLI defines', () => {
    expect(EXIT_ROLE_CONFLICT).toBe(RoleExitCode.CONFLICT);
  });
});

describe('the role read failing is not a server with no roles', () => {
  it('that read failed: nothing is sent, even with a pin', () => {
    const fake = fakeCli({ capture: { roleLaunch: PIN }, rolesRead: 'failed' });
    const result = go(fake);
    expect(result.code).toBe(EXIT_AUTO_YES_UNCONFIRMED);
    expect(fake.calls.some((call) => call[1] === 'send')).toBe(false);
    expect(result.log.join('\n')).toContain('roles unreadable');
  });

  it('a server without the route goes as before, on the plain list (negative control)', () => {
    const fake = fakeCli({ capture: {}, rolesRead: 'old-server' });
    expect(go(fake).code).toBe(0);
    expect(contractCall(fake)?.some((arg) => arg.startsWith('--expect'))).toBe(false);
  });

  it('a CLI without the flag goes as before (negative control)', () => {
    const fake = fakeCli({ capture: {}, rolesRead: 'old-cli' });
    expect(go(fake).code).toBe(0);
    expect(contractCall(fake)).toBeDefined();
  });

  it('the read asks for it', () => {
    const fake = fakeCli({ capture: { roleLaunch: PIN } });
    go(fake);
    expect(fake.calls.some((call) => call.includes('--require-roles'))).toBe(true);
  });
});
