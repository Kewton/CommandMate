/**
 * Issue #4436 (I4, design §5-6): a headless run started by a Schedule or the
 * daily summary carries `CM_RUN_ORIGIN=schedule` in its child environment, so a
 * `commandmate send` made from inside that run can say where it came from. The
 * server's own `CM_RUN_ORIGIN` (inherited from whatever started it) never
 * reaches a child: `env-sanitizer` strips it, and the executor writes the value
 * last so a role's env cannot replace it.
 *
 * `execFile` is a mock: nothing is spawned (no `agy`, no credential read).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('@/lib/cli-tools/opencode-executable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cli-tools/opencode-executable')>();
  return {
    ...actual,
    resolveOpencodeV2Executable: vi.fn(async () => ({ executable: { path: '/fake/bin/opencode2' } })),
  };
});

import { execFile } from 'child_process';
import { executeClaudeCommand } from '@/lib/session/claude-executor';
import {
  isStrippedChildProcessEnvKey,
  RUN_ORIGIN_ENV_KEYS,
  sanitizeEnvForChildProcess,
} from '@/lib/security/env-sanitizer';
import { RUN_ORIGIN_ENV } from '@/lib/tool-policy/policy';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

const mockedExecFile = vi.mocked(execFile);

function childEnvOfNextRun(): () => NodeJS.ProcessEnv | undefined {
  let captured: NodeJS.ProcessEnv | undefined;
  mockedExecFile.mockImplementationOnce(((
    _cmd: string,
    _args: readonly string[],
    options: { env?: NodeJS.ProcessEnv },
    cb: (err: Error | null, out: string, err2: string) => void
  ) => {
    captured = options.env;
    queueMicrotask(() => cb(null, 'ok', ''));
    return { stdin: { end: vi.fn() }, on: vi.fn(), pid: undefined } as unknown as ChildProcess;
  }) as unknown as typeof execFile);
  return () => captured;
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[RUN_ORIGIN_ENV];
  mockedExecFile.mockReset();
});
afterEach(() => {
  if (saved === undefined) delete process.env[RUN_ORIGIN_ENV];
  else process.env[RUN_ORIGIN_ENV] = saved;
});

describe('Issue #4436 I4: CM_RUN_ORIGIN on the headless run', () => {
  it.each([...CLI_TOOL_IDS])('4436: a %s run gets CM_RUN_ORIGIN=schedule', async (tool) => {
    delete process.env[RUN_ORIGIN_ENV];
    const env = childEnvOfNextRun();
    const result = await executeClaudeCommand('hello', '/tmp/wt-4436-not-real', tool);
    expect(result.status).toBe('completed');
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(env()?.[RUN_ORIGIN_ENV]).toBe('schedule');
  });

  it('4436: the server environment\'s own CM_RUN_ORIGIN is replaced, not inherited', async () => {
    process.env[RUN_ORIGIN_ENV] = 'agent';
    const env = childEnvOfNextRun();
    await executeClaudeCommand('hello', '/tmp/wt-4436-not-real', 'claude');
    expect(env()?.[RUN_ORIGIN_ENV]).toBe('schedule');
  });

  it('4436: a role env cannot replace the origin', async () => {
    const env = childEnvOfNextRun();
    await executeClaudeCommand('hello', '/tmp/wt-4436-not-real', 'claude', undefined, {
      role: { args: [], headlessPosition: 'trailing', env: { [RUN_ORIGIN_ENV]: 'terminal', CM_ROLE_X: '1' } },
    });
    expect(env()?.[RUN_ORIGIN_ENV]).toBe('schedule');
    expect(env()?.CM_ROLE_X).toBe('1');
  });
});

describe('Issue #4436 I4: env-sanitizer strips CM_RUN_ORIGIN', () => {
  it('4436: lists it and strips it from a child environment', () => {
    expect(RUN_ORIGIN_ENV_KEYS).toEqual([RUN_ORIGIN_ENV]);
    expect(isStrippedChildProcessEnvKey(RUN_ORIGIN_ENV)).toBe(true);
    process.env[RUN_ORIGIN_ENV] = 'schedule';
    expect(sanitizeEnvForChildProcess()).not.toHaveProperty(RUN_ORIGIN_ENV);
  });

  it('4436 (negative control): a look-alike name and PATH are kept', () => {
    expect(isStrippedChildProcessEnvKey('CM_RUN_ORIGIN_X')).toBe(false);
    expect(isStrippedChildProcessEnvKey('PATH')).toBe(false);
    expect(sanitizeEnvForChildProcess().PATH).toBe(process.env.PATH);
  });
});
