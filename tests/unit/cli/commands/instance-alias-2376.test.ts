/**
 * `--instance` accepts a roster ALIAS (Issue #2376).
 *
 * The alias is the only name a human — or a GUI — has for `codex-2`: it is what
 * the Agent pane shows and what the ALIAS column of `commandmate instances`
 * prints. Before this Issue every command rejected it locally, before any
 * request, with "must be an alphanumeric identifier".
 *
 * Two properties are pinned per command, and the second is the one that matters:
 *
 *   1. the alias is not rejected client-side, and reaches `/resolve-target`;
 *   2. every REQUEST AFTER the resolution carries the resolved instance ID.
 *      An alias that leaked through to `/send`, `/current-output` or
 *      `/prompt-response` would match no session there and silently address the
 *      worktree default instead — the #1638 wrong-session failure, in a new
 *      disguise.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const ALIAS = 'Codex 2';

function resolveTarget(cliToolId = 'codex', instanceId = 'codex-2') {
  return { data: { cliToolId, instanceId, resolvedBy: 'roster', conflict: null } };
}

/** The 409 the route answers for an alias two roster rows respond to. */
function ambiguous() {
  return {
    data: {
      error: "Instance 'Codex' matches 2 roster entries. Name one by its instance id.",
      code: 'ambiguous_instance_alias',
      issues: [
        'codex (codex) — alias "Codex"',
        'codex-2 (codex) — alias "codex"',
      ],
    },
    status: 409,
  };
}

const readyFrame = {
  isRunning: true,
  isComplete: true,
  isPromptWaiting: false,
  isGenerating: false,
  content: 'done',
  fullOutput: 'done',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  thinkingMessage: null,
  cliToolId: 'codex',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
};

function calls(): [string, { body?: string }][] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls as [string, { body?: string }][];
}

function urlsMatching(fragment: string): string[] {
  return calls().map((c) => String(c[0])).filter((u) => u.includes(fragment));
}

function bodyOf(fragment: string): Record<string, unknown> {
  const call = calls().find((c) => String(c[0]).includes(fragment));
  return JSON.parse(call?.[1]?.body ?? '{}');
}

describe('send --instance <alias>', () => {
  it('resolves the alias and sends the resolved instance id', async () => {
    mockFetchSequence([resolveTarget(), { data: { id: 1 }, status: 201 }]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'hi', '--instance', ALIAS]);

    expect(bodyOf('/send')).toEqual({
      content: 'hi',
      cliToolId: 'codex',
      instanceId: 'codex-2',
    });
  });

  it('scopes --auto-yes to the resolved instance, not to the alias', async () => {
    mockFetchSequence([
      resolveTarget(),
      { data: {}, status: 200 },
      { data: { id: 1 }, status: 201 },
    ]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(
      ['node', 'send', 'wt1', 'hi', '--instance', ALIAS, '--auto-yes']
    );

    expect(bodyOf('/auto-yes')).toMatchObject({ instanceId: 'codex-2', cliToolId: 'codex' });
  });
});

describe('wait --instance <alias>', () => {
  it('polls the resolved instance', async () => {
    mockFetchSequence([resolveTarget(), { data: readyFrame }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', '--instance', ALIAS]);

    const polls = urlsMatching('/current-output');
    expect(polls).toHaveLength(1);
    expect(polls[0]).toContain('instance=codex-2');
    expect(polls[0]).not.toContain('Codex');
  });

  it('resolves the alias once per worktree when several are waited on', async () => {
    mockFetchSequence([
      resolveTarget('codex', 'codex-2'),
      resolveTarget('codex', 'codex-3'),
      { data: readyFrame },
      { data: readyFrame },
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    await createWaitCommand().parseAsync(['node', 'wait', 'wt1', 'wt2', '--instance', ALIAS]);

    expect(urlsMatching('/resolve-target')).toHaveLength(2);
    const polls = urlsMatching('/current-output');
    // One roster answered `codex-2`, the other `codex-3`: resolving once and
    // reusing the answer would have polled the same instance twice.
    expect(polls.some((u) => u.includes('instance=codex-2'))).toBe(true);
    expect(polls.some((u) => u.includes('instance=codex-3'))).toBe(true);
  });
});

describe('capture --instance <alias>', () => {
  it('reads the resolved instance from /current-output', async () => {
    mockFetchSequence([resolveTarget(), { data: readyFrame }]);

    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    await createCaptureCommand().parseAsync(['node', 'capture', 'wt1', '--instance', ALIAS]);

    const reads = urlsMatching('/current-output');
    expect(reads[0]).toContain('instance=codex-2');
    expect(reads[0]).toContain('cliTool=codex');
  });

  it('reads the resolved instance from the pane route', async () => {
    mockFetchSequence([resolveTarget(), { data: { output: 'pane text' } }]);

    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    await createCaptureCommand().parseAsync(
      ['node', 'capture', 'wt1', '--instance', ALIAS, '--pane']
    );

    expect(bodyOf('/capture')).toMatchObject({ cliToolId: 'codex', instanceId: 'codex-2' });
  });
});

describe('respond --instance <alias>', () => {
  it('answers the resolved instance', async () => {
    mockFetchSequence([
      resolveTarget(),
      // addressesDecisionsById probe: no structured source, so the keystroke
      // route is taken (the pre-#2040 path).
      { data: readyFrame },
      { data: { success: true, answer: '1' } },
    ]);

    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    await createRespondCommand().parseAsync(
      ['node', 'respond', 'wt1', '1', '--instance', ALIAS]
    );

    expect(bodyOf('/prompt-response')).toMatchObject({
      answer: '1',
      cliTool: 'codex',
      instanceId: 'codex-2',
    });
  });
});

describe('an alias two roster rows answer to', () => {
  it('exits 2 and lists every candidate rather than picking one', async () => {
    mockFetchSequence([ambiguous()]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'hi', '--instance', 'Codex']);

    expect(mockExit).toHaveBeenCalledWith(2);
    const stderr = mockConsoleError.mock.calls.flat().join('\n');
    expect(stderr).toContain('matches 2 roster entries');
    expect(stderr).toContain('codex (codex)');
    expect(stderr).toContain('codex-2 (codex)');
    // Nothing was sent to either candidate.
    expect(urlsMatching('/send')).toHaveLength(0);
  });
});

describe('the selector validator', () => {
  it('accepts instance ids and aliases, and rejects what no alias can be', async () => {
    const { isInstanceSelector } = await import('../../../../src/cli/commands/instances');

    expect(isInstanceSelector('codex-2')).toBe(true);
    expect(isInstanceSelector('Codex 2')).toBe(true);
    expect(isInstanceSelector('レビュー担当')).toBe(true);

    expect(isInstanceSelector('')).toBe(false);
    // An id-shaped value is judged by the ID rule (64 chars), so the alias
    // bound only decides values that are not ids — here, one with a space in it.
    expect(isInstanceSelector('x'.repeat(60))).toBe(true);
    expect(isInstanceSelector(`${'x '.repeat(30)}`)).toBe(false);
    expect(isInstanceSelector('bad\nvalue')).toBe(false);
  });

  it('is what the commands reject with, before any request', async () => {
    mockFetchSequence([]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(
      ['node', 'send', 'wt1', 'hi', '--instance', 'x '.repeat(30)]
    );

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError.mock.calls.flat().join('\n')).toContain('roster alias');
  });
});
