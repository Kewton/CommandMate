/**
 * Issue #4031 (item 2): the strict respond's failure hints name the target the
 * request resolved to (#3982's `followUpCommand`).
 *
 * Before #4031 they said `commandmate prompt` / `capture --pane` with no
 * worktree and no target, so after `--instance codex-2` the reader looked at
 * the worktree default's pane. Negative: a strict respond that named no
 * target keeps the hints as before.
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

describe('[#4031] strict respond hints name the resolved target', () => {
  it('positive: NOT_SENT after --instance codex-2 — `commandmate prompt wt1 --instance codex-2`', async () => {
    mockFetchResponse(serverResult(NOT_SENT));
    await run('Yes', '--instance', 'codex-2', ...STRICT);

    expect(mockExit).toHaveBeenCalledWith(40);
    expect(stderr()).toContain('Observe the screen again with `commandmate prompt wt1 --instance codex-2` before answering.');
  });

  it('positive: keys sent, not confirmed, after --instance codex-2 — prompt and capture both name it', async () => {
    mockFetchResponse(serverResult(UNCONFIRMED));
    await run('Yes', '--instance', 'codex-2', ...STRICT);

    expect(mockExit).toHaveBeenCalledWith(41);
    expect(stderr()).toContain(
      'Do not send it again: look at the pane (`commandmate prompt wt1 --instance codex-2` / ' +
        '`commandmate capture wt1 --instance codex-2 --pane`) first.',
    );
  });

  it('negative: no target named — NOT_SENT keeps the hint as before', async () => {
    mockFetchResponse(serverResult(NOT_SENT));
    await run('Yes', ...STRICT);

    expect(mockExit).toHaveBeenCalledWith(40);
    expect(stderr()).toContain('Observe the screen again with `commandmate prompt` before answering.');
    expect(stderr()).not.toContain('--instance');
  });

  it('negative: no target named — the unconfirmed hint as before', async () => {
    mockFetchResponse(serverResult(UNCONFIRMED));
    await run('Yes', ...STRICT);

    expect(mockExit).toHaveBeenCalledWith(41);
    expect(stderr()).toContain('Do not send it again: look at the pane (`commandmate prompt` / `capture --pane`) first.');
  });
});
