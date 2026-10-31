/**
 * Issue #4049 (item 2): after an `--agent`-only strict respond, the failure
 * hints' `prompt` reads that tool's instance.
 *
 * `commandmate prompt` takes `--instance` only, so before #4049 an `--agent
 * codex` request was told `commandmate prompt wt1`, which reads the worktree
 * default. The primary instance of a tool is the tool id (#868), and the server
 * resolves `--instance codex` to the session `--agent codex` alone reaches
 * (pinned in `tests/unit/session/respond-target-4049.test.ts`). Negative: a
 * strict respond that named no target keeps the hints as before.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

// `--instance` resolves through the server; here it resolves as the roster would.
vi.mock('../../../../src/cli/commands/instances', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/cli/commands/instances')>();
  return {
    ...actual,
    resolveInstanceTarget: vi.fn(async () => ({ cliToolId: 'antigravity', instanceId: 'codex-2' })),
  };
});

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const stderr = (): string => mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');

async function run(...args: string[]): Promise<void> {
  const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
  await createRespondCommand().parseAsync(['node', 'respond', 'wt1', ...args]);
}

const STRICT = ['--expect-screen', 'antigravity-trust', '--observation', 'po1.abc.def', '--expect-target', '/w'];

function serverResult(over: Record<string, unknown>): Record<string, unknown> {
  return {
    strictRespond: 1,
    code: 0,
    delivery: 'sent',
    reason: null,
    message: '',
    expectedKind: 'antigravity-trust',
    observedKind: 'antigravity-trust',
    expectedTarget: '/w',
    observedTarget: '/w',
    operationId: 'op-4031',
    answer: { position: 1, label: 'Yes' },
    keysSent: 1,
    outcome: 'advanced',
    replayed: false,
    ...over,
  };
}

const NOT_SENT = {
  code: 40,
  delivery: 'not-sent',
  reason: 'kind_mismatch',
  message: 'The screen on the pane is not the kind the answer was meant for.',
  answer: null,
  keysSent: 0,
  outcome: null,
};
const UNCONFIRMED = { code: 41, reason: 'outcome_unchanged', outcome: 'unchanged' };

describe('[#4049] strict respond hints after --agent', () => {
  it('positive: NOT_SENT after --agent codex — `commandmate prompt wt1 --instance codex`', async () => {
    mockFetchResponse(serverResult(NOT_SENT));
    await run('Yes', '--agent', 'codex', ...STRICT);

    expect(mockExit).toHaveBeenCalledWith(40);
    expect(stderr()).toContain('Observe the screen again with `commandmate prompt wt1 --instance codex` before answering.');
  });

  it('positive: keys sent, not confirmed, after --agent codex — prompt by instance, capture by agent', async () => {
    mockFetchResponse(serverResult(UNCONFIRMED));
    await run('Yes', '--agent', 'codex', ...STRICT);

    expect(mockExit).toHaveBeenCalledWith(41);
    expect(stderr()).toContain(
      'Do not send it again: look at the pane (`commandmate prompt wt1 --instance codex` / ' +
        '`commandmate capture wt1 --agent codex --pane`) first.',
    );
  });

  it('negative: no target named — NOT_SENT keeps the hint as before', async () => {
    mockFetchResponse(serverResult(NOT_SENT));
    await run('Yes', ...STRICT);

    expect(stderr()).toContain('Observe the screen again with `commandmate prompt` before answering.');
    expect(stderr()).not.toContain('--instance');
    expect(stderr()).not.toContain('--agent');
  });
});
