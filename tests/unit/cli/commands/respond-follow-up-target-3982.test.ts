/**
 * Issue #3982 (CLI): `respond` reads `answer_input_lost` by `reason` on a
 * server that says it puts one there, and every next-step hint names the
 * RESOLVED target with the flags that read a dialog.
 *
 * Positive controls: a new server's 500 that only QUOTES the reason code is
 * not an InputLost; `--agent codex` / an `--instance` alias reach the hints as
 * `--agent codex` / the resolved id. Negative controls: an older server (no
 * `prompt-answer-reason`) is still read by the text; no target named, no
 * target flag; the capability probe is asked once per command.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { resetServerCapabilityProbe } from '../../../../src/cli/utils/server-capabilities';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  resetServerCapabilityProbe();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

function stderr(): string {
  return mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

const NEW_SERVER = { serverVersion: '9.9.9', capabilities: ['resolve-session-target', 'prompt-answer-reason'] };
const OLD_SERVER = { serverVersion: '0.49.1', capabilities: ['resolve-session-target', 'default-selected-agents'] };

/** The roster `resolve-target` answers from: an alias and two tool-named instances. */
const ROSTER: Record<string, { cliToolId: string; instanceId: string }> = {
  'Codex 2': { cliToolId: 'codex', instanceId: 'codex-2' },
  codex: { cliToolId: 'codex', instanceId: 'codex' },
};

/**
 * A server: answers the probe with `capabilities`, resolves instances from
 * {@link ROSTER}, and answers `/prompt-response` (or `/send`) with `answer`.
 * Returns the paths requested, in order.
 */
function mockServer(capabilities: unknown, answer: { data: unknown; status?: number }): string[] {
  const requested: string[] = [];
  global.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    requested.push(path);
    if (path.startsWith('/api/capabilities')) return Promise.resolve(jsonResponse(capabilities));
    if (path.includes('/resolve-target')) {
      const instance = new URL(url).searchParams.get('instance') ?? '';
      const hit = ROSTER[instance];
      return Promise.resolve(jsonResponse({ ...hit, resolvedBy: 'roster', conflict: null }));
    }
    if (path.includes('/current-output')) return Promise.resolve(jsonResponse({}));
    return Promise.resolve(jsonResponse(answer.data, answer.status ?? 200));
  }) as unknown as typeof fetch;
  return requested;
}

async function respond(args: string[]): Promise<void> {
  const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
  await createRespondCommand().parseAsync(['node', 'respond', ...args]);
}

/** A tmux failure whose message quotes the answer — and the answer quotes the reason code. */
const QUOTING_500 = {
  data: { error: 'Failed to send answer to tmux: send-keys failed for "answer_input_lost"' },
  status: 500,
};

describe('[#3982] respond: answer_input_lost by reason, on a server that declares it', () => {
  it('positive (new server): a 500 that only quotes the reason code is not shown as InputLost', async () => {
    mockServer(NEW_SERVER, QUOTING_500);
    await respond(['wt1', 'answer_input_lost', '--instance', 'codex']);

    expect(stderr()).not.toContain('partly typed');
    expect(stderr()).toContain('send-keys failed');
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('positive (new server): a 500 with reason answer_input_lost is shown as InputLost', async () => {
    mockServer(NEW_SERVER, {
      data: { error: 'Failed to send answer to tmux: stopped', reason: 'answer_input_lost', keysSent: true },
      status: 500,
    });
    await respond(['wt1', '1', '--instance', 'codex']);

    expect(stderr()).toContain('partly typed (reason: answer_input_lost)');
  });

  it('negative (older server): no token, the reason code in the 500 text is still InputLost', async () => {
    mockServer(OLD_SERVER, QUOTING_500);
    await respond(['wt1', '1', '--instance', 'codex']);

    expect(stderr()).toContain('partly typed (reason: answer_input_lost)');
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('negative (server older than /api/capabilities): the 404 probe keeps the text reading', async () => {
    const requested: string[] = [];
    global.fetch = vi.fn((input: unknown) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '');
      requested.push(path);
      if (path.startsWith('/api/capabilities')) return Promise.resolve(jsonResponse({}, 404));
      if (path.includes('/current-output')) return Promise.resolve(jsonResponse({}));
      return Promise.resolve(jsonResponse(QUOTING_500.data, 500));
    }) as unknown as typeof fetch;
    await respond(['wt1', '1', '--agent', 'claude']);

    expect(stderr()).toContain('partly typed (reason: answer_input_lost)');
  });

  it('negative: the probe is asked once per command — the one --instance resolution made', async () => {
    const requested = mockServer(NEW_SERVER, QUOTING_500);
    await respond(['wt1', '1', '--instance', 'codex']);

    expect(requested.filter((path) => path.startsWith('/api/capabilities'))).toHaveLength(1);
  });

  it('negative: with no target and a request that went through, nothing probes at all', async () => {
    const requested = mockServer(NEW_SERVER, { data: { success: true, answer: '1' } });
    await respond(['wt1', '1']);

    expect(requested.filter((path) => path.startsWith('/api/capabilities'))).toHaveLength(0);
    expect(stderr()).toContain('Response sent.');
  });
});

describe('[#3982] respond: hints name the resolved target', () => {
  const UNRESOLVABLE = { data: { success: false, answer: 'go ahead', reason: 'unresolvable_answer' } };

  it('positive: unresolvable_answer after --agent codex names --agent codex and reads the pane', async () => {
    mockServer(NEW_SERVER, UNRESOLVABLE);
    await respond(['wt1', 'go ahead', '--agent', 'codex']);

    expect(stderr()).toContain('`commandmate respond wt1 <number> --agent codex`');
    expect(stderr()).toContain('`commandmate capture wt1 --agent codex --pane --tail 40`');
  });

  it('positive: an --instance alias reaches the hint as the resolved id', async () => {
    mockServer(NEW_SERVER, UNRESOLVABLE);
    await respond(['wt1', 'go ahead', '--instance', 'Codex 2']);

    expect(stderr()).toContain('`commandmate respond wt1 <number> --instance codex-2`');
    expect(stderr()).toContain('`commandmate capture wt1 --instance codex-2 --pane --tail 40`');
    expect(stderr()).not.toContain('Codex 2');
  });

  it('negative: no target named, no target flag', async () => {
    mockServer(NEW_SERVER, UNRESOLVABLE);
    await respond(['wt1', 'go ahead']);

    expect(stderr()).toContain('`commandmate respond wt1 <number>`');
    expect(stderr()).toContain('`commandmate capture wt1 --pane --tail 40`');
    expect(stderr()).not.toContain('--instance');
    expect(stderr()).not.toContain('--agent');
  });

  it('PROMPT_NO_LONGER_ACTIVE: positive with an alias, negative without a target', async () => {
    const GONE = { data: { success: false, answer: 'use the other API', reason: 'prompt_no_longer_active' } };
    mockServer(NEW_SERVER, GONE);
    await respond(['wt1', 'use the other API', '--instance', 'Codex 2']);
    expect(stderr()).toContain('`commandmate send wt1 "<text>" --instance codex-2`');

    mockConsoleError.mockClear();
    mockServer(NEW_SERVER, GONE);
    await respond(['wt1', 'use the other API']);
    expect(stderr()).toContain('`commandmate send wt1 "<text>"`');
  });

  it('plan review Next / Note: positive with --agent, negative without a target', async () => {
    const COMMENT = {
      data: { success: true, answer: 'Add tests', planReview: { action: 'comment', comment: 'Add tests', phase: 'body', pendingCommentsBefore: 0 } },
    };
    mockServer(NEW_SERVER, COMMENT);
    await respond(['wt1', 'Add tests', '--agent', 'command-code']);
    expect(stderr()).toContain('`commandmate respond wt1 --plan-review submit --agent command-code`');

    mockConsoleError.mockClear();
    mockServer(NEW_SERVER, {
      data: { success: true, answer: '', planReview: { action: 'approve', comment: null, phase: 'body', pendingCommentsBefore: 1 } },
    });
    await respond(['wt1', '--plan-review', 'approve', '--agent', 'command-code']);
    expect(stderr()).toContain('`commandmate respond wt1 --plan-review approve --agent command-code`');

    mockConsoleError.mockClear();
    mockServer(NEW_SERVER, COMMENT);
    await respond(['wt1', 'Add tests']);
    expect(stderr()).toContain('`commandmate respond wt1 --plan-review submit`');
  });

  it('textFollowUp Next: positive with an alias, negative without a target', async () => {
    const FOLLOW_UP = {
      data: { success: true, answer: '3', textFollowUp: { optionNumber: 3, optionLabel: 'No, tell Codex', message: 'x' } },
    };
    mockServer(NEW_SERVER, FOLLOW_UP);
    await respond(['wt1', '3', '--instance', 'Codex 2']);
    expect(stderr()).toContain('`commandmate send wt1 "<text>" --instance codex-2`');

    mockConsoleError.mockClear();
    mockServer(NEW_SERVER, FOLLOW_UP);
    await respond(['wt1', '3']);
    expect(stderr()).toContain('`commandmate send wt1 "<text>"`.');
  });
});

describe('[#3982] send: the PROMPT_WAITING fallback names the resolved target', () => {
  async function send(args: string[]): Promise<void> {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', ...args]);
  }
  const WAITING = { data: { code: 'PROMPT_WAITING' }, status: 409 };

  it('positive: an --instance alias is the resolved id', async () => {
    mockServer(NEW_SERVER, WAITING);
    await send(['wt1', 'hello', '--instance', 'Codex 2']);
    expect(stderr()).toContain('`commandmate respond wt1 <answer> --instance codex-2`');
  });

  it('positive: --agent codex is named', async () => {
    mockServer(NEW_SERVER, WAITING);
    await send(['wt1', 'hello', '--agent', 'codex']);
    expect(stderr()).toContain('`commandmate respond wt1 <answer> --agent codex`');
  });

  it('negative: no target named, no target flag', async () => {
    mockServer(NEW_SERVER, WAITING);
    await send(['wt1', 'hello']);
    expect(stderr()).toContain('`commandmate respond wt1 <answer>`.');
  });
});

describe('[#3982] send / ask: the "check the pane before a resend" hints name the resolved target', () => {
  it('positive: describeFailedSendOutcome and the relay notice name the instance; negative: none without a target', async () => {
    const { ApiError } = await import('../../../../src/cli/utils/api-client');
    const { describeFailedSendOutcome } = await import('../../../../src/cli/commands/message-dispatch');
    const { printRelayUnconfirmedNotice } = await import('../../../../src/cli/commands/relays');
    const { commandTargetOf } = await import('../../../../src/cli/commands/command-target');
    const unknown = new ApiError('x', 99, 500, { error: 'x', sendOutcome: 'unknown' } as never);
    const target = commandTargetOf({ cliToolId: 'codex', instanceId: 'codex-2' }, undefined);

    expect(describeFailedSendOutcome(unknown, 'wt1', target)).toContain('`commandmate capture wt1 --instance codex-2 --pane`');
    expect(describeFailedSendOutcome(unknown, 'wt1')).toContain('`commandmate capture wt1 --pane`');

    printRelayUnconfirmedNotice('r1', 'wt1', target);
    expect(stderr()).toContain('`commandmate capture wt1 --instance codex-2 --pane`');
    mockConsoleError.mockClear();
    printRelayUnconfirmedNotice('r1', 'wt1', commandTargetOf(null, undefined));
    expect(stderr()).toContain('`commandmate capture wt1 --pane`');
  });
});
