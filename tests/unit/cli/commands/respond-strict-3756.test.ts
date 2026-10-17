/**
 * `respond --expect-screen <kind> --observation <token>` (Issue #3756): the
 * CLI half — the body that reaches the strict endpoint, the refusals made
 * before any request, the exit codes 40 / 41, and that an older server without
 * the endpoint is a stop, never a fallback to `/prompt-response`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetchResponse, mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { strictRespondActor } from '../../../../src/cli/commands/respond-strict';

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
const stdoutCalls = (): string[] => mockConsoleLog.mock.calls.map((call) => String(call[0]));

function requests(): Array<{ url: string; body: Record<string, unknown> | null }> {
  if (!vi.isMockFunction(global.fetch)) return [];
  return vi
    .mocked(global.fetch)
    .mock.calls.map(([url, init]) => ({
      url: String(url),
      body: (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : null,
    }))
    .filter((request) => !request.url.includes('/api/capabilities'));
}

async function run(...args: string[]): Promise<void> {
  const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
  await createRespondCommand().parseAsync(['node', 'respond', 'wt1', ...args]);
}

const STRICT = ['--agent', 'antigravity', '--expect-screen', 'antigravity-trust', '--observation', 'po1.abc.def'];
const FOLDER = '/Users/agy-user/work/repo';

function serverResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    strictRespond: 1,
    code: 0,
    delivery: 'sent',
    reason: null,
    message: 'Answered: the screen advanced.',
    expectedKind: 'antigravity-trust',
    observedKind: 'antigravity-trust',
    expectedTarget: FOLDER,
    observedTarget: FOLDER,
    operationId: 'op-from-server',
    answer: { position: 1, label: 'Yes, I trust this folder' },
    keysSent: 1,
    outcome: 'advanced',
    replayed: false,
    ...over,
  };
}

describe('[#3756] respond --expect-screen sends to the strict endpoint only', () => {
  it('posts the kind, the token, the label, the folder and an operation id, and nothing else', async () => {
    mockFetchResponse(serverResult());
    await run('Yes', ...STRICT, '--expect-target', FOLDER);

    const sent = requests();
    expect(sent.map((r) => new URL(r.url).pathname)).toEqual(['/api/worktrees/wt1/prompt-response/strict']);
    expect(sent[0].body).toMatchObject({
      expectScreen: 'antigravity-trust',
      observation: 'po1.abc.def',
      answer: 'Yes',
      expectTarget: FOLDER,
      cliTool: 'antigravity',
    });
    expect(String(sent[0].body?.operationId)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(stdoutCalls().join('\n')).toContain('Answered antigravity-trust with option 1: Yes, I trust this folder');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('--json prints the result object, once, on stdout', async () => {
    mockFetchResponse(serverResult());
    await run('Yes', ...STRICT, '--expect-target', FOLDER, '--json', '--operation-id', 'op-3756-json');

    expect(requests()[0].body?.operationId).toBe('op-3756-json');
    expect(stdoutCalls()).toHaveLength(1);
    expect(JSON.parse(stdoutCalls()[0])).toMatchObject({ code: 0, delivery: 'sent', outcome: 'advanced', operationId: 'op-from-server' });
  });

  it('exits 40 with the observed kind when the server sent nothing', async () => {
    mockFetchResponse(
      serverResult({
        code: 40,
        delivery: 'not-sent',
        reason: 'kind_mismatch',
        message: 'The screen on the pane is not the kind the answer was meant for.',
        observedKind: 'antigravity-permission',
        answer: null,
        keysSent: 0,
        outcome: null,
      })
    );
    await run('Yes', ...STRICT, '--expect-target', FOLDER);

    expect(mockExit).toHaveBeenCalledWith(40);
    expect(stderr()).toContain('kind_mismatch');
    expect(stderr()).toContain('Observed kind: antigravity-permission');
  });

  it('exits 41 when keys were sent and the result is not confirmed', async () => {
    mockFetchResponse(serverResult({ code: 41, reason: 'outcome_unchanged', outcome: 'unchanged' }));
    await run('Yes', ...STRICT, '--expect-target', FOLDER);
    expect(mockExit).toHaveBeenCalledWith(41);
    expect(stderr()).toContain('Do not send it again');
  });
});

describe('[#3756] an older server without the endpoint is a stop, not a fallback', () => {
  it('a bare 404 exits 40 and never reaches /prompt-response', async () => {
    mockFetchSequence([{ data: null, status: 404 }]);
    await run('Yes', ...STRICT, '--expect-target', FOLDER, '--json');

    expect(mockExit).toHaveBeenCalledWith(40);
    expect(requests().map((r) => new URL(r.url).pathname)).toEqual(['/api/worktrees/wt1/prompt-response/strict']);
    expect(JSON.parse(stdoutCalls()[0])).toMatchObject({
      code: 40,
      delivery: 'not-sent',
      reason: 'strict_endpoint_missing',
      expectedKind: 'antigravity-trust',
      observedKind: null,
    });
  });

  it("the strict route's own 404 (no such worktree) is a bad argument, not a missing endpoint", async () => {
    mockFetchResponse({ strictRespond: 1, code: 'worktree_not_found', error: "Worktree 'wt1' not found" }, 404);
    await run('Yes', ...STRICT, '--expect-target', FOLDER);
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('a 5xx exits 41: the request may have been carried out', async () => {
    mockFetchResponse({ error: 'boom' }, 500);
    await run('Yes', ...STRICT, '--expect-target', FOLDER, '--operation-id', 'op-3756-retry');
    expect(mockExit).toHaveBeenCalledWith(41);
    expect(stderr()).toContain('--operation-id op-3756-retry');
  });
});

describe('[#3756] refused before any request (exit 2)', () => {
  it('--default, an option number on the unnumbered trust screen, and a half-given strict pair', async () => {
    const cases = [
      ['--default', ...STRICT],
      ['1', ...STRICT],
      ['Yes', '--agent', 'antigravity', '--expect-screen', 'antigravity-trust'],
      ['Yes', '--agent', 'antigravity', '--observation', 'po1.abc.def'],
      ['Yes', ...STRICT.slice(0, 2), '--expect-screen', 'trust-screen', '--observation', 'po1.abc.def'],
      ['Yes', ...STRICT, '--operation-id', 'x'],
    ];
    for (const args of cases) {
      mockFetchResponse(serverResult());
      mockExit.mockClear();
      await run(...args);
      expect(mockExit, args.join(' ')).toHaveBeenCalledWith(2);
      expect(requests(), args.join(' ')).toEqual([]);
    }
  });

  it('--json without --expect-screen is refused, and the plain respond is untouched otherwise (negative control)', async () => {
    mockFetchResponse({ success: true, answer: 'yes' });
    await run('yes', '--agent', 'claude', '--json');
    expect(mockExit).toHaveBeenCalledWith(2);
    expect(requests()).toEqual([]);
  });
});

describe('[#3756] strictRespondActor', () => {
  it('names the agent session the CLI runs in, or cli', () => {
    expect(strictRespondActor({ CM_WORKTREE_ID: 'wt-a', CM_INSTANCE_ID: 'claude-2' })).toBe('agent:wt-a/claude-2');
    expect(strictRespondActor({})).toBe('cli');
    expect(strictRespondActor({ CM_WORKTREE_ID: 'wt a', CM_INSTANCE_ID: 'x' })).toBe('cli');
  });
});
