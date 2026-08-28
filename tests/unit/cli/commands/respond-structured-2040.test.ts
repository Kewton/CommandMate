/**
 * `commandmate respond <worktree> <n>` on an agent that publishes decision ids
 * (Issue #2040).
 *
 * The command has always POSTed to `/prompt-response`, which re-captures the
 * pane and presses a key. On opencode that is not an answer: every dialog it
 * draws is `answerMode: 'keys'` (#2033), so a typed number is refused at the
 * sender — while the approval it is refusing to answer has a REST endpoint and
 * an id. This file pins which endpoint the command chooses and on what evidence.
 *
 * The evidence is the DECLARED capability, read off the server
 * (`structuredEvents.source.capabilities.eventIdentity`), never a list of tool
 * names kept in the CLI — §4 D3 of the design policy puts every such property on
 * the source precisely so a caller does not have to keep one. The `claude` cases
 * here are therefore not "claude is special"; they are "a source that declares
 * no per-decision id takes the path it always took".
 *
 * The probe is fail-open on purpose and that is asserted too: an older daemon
 * sends no `structuredEvents` at all, and a `respond` that died of the probe
 * would be a command broken by a field it only wanted to read.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, mockFetchError, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

/** `GET /current-output` as a server that declares a per-decision id answers it. */
function structuredProbe(eventIdentity: string | null) {
  return {
    data: {
      isRunning: true,
      structuredEvents: {
        source: { cliToolId: 'opencode', capabilities: { eventIdentity } },
      },
    },
  };
}

/** Every fetch this command made, in order. */
function calls(): Array<[string, { method?: string; body?: string }]> {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<
    [string, { method?: string; body?: string }]
  >;
}

function bodyOf(call: [string, { body?: string }]): unknown {
  return JSON.parse(call[1].body ?? '{}');
}

function findCall(fragment: string): [string, { method?: string; body?: string }] | undefined {
  return calls().find((call) => String(call[0]).includes(fragment));
}

async function runRespond(argv: string[]): Promise<void> {
  const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
  await createRespondCommand().parseAsync(['node', 'respond', ...argv]);
}

describe('an agent that publishes decision ids', () => {
  it('sends the number to /respond, never to /prompt-response', async () => {
    mockFetchSequence([
      structuredProbe('permission-id'),
      {
        data: {
          success: true,
          answer: '3',
          resolved: {
            via: 'structured-decision',
            optionNumber: 3,
            optionLabel: 'Reject',
            decisionId: 'per_1',
          },
        },
      },
    ]);

    await runRespond(['wt1', '3']);

    const respondCall = findCall('/respond');
    expect(respondCall).toBeDefined();
    expect(respondCall?.[1].method).toBe('POST');
    // No id of any kind: the server picks the ONE decision this instance holds.
    expect(bodyOf(respondCall as [string, { body?: string }])).toEqual({ answer: '3' });
    expect(findCall('/prompt-response')).toBeUndefined();

    expect(mockConsoleLog).toHaveBeenCalledWith('Answered approval per_1 with option 3: Reject');
    expect(mockConsoleError).toHaveBeenCalledWith('Response sent.');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('carries the resolved tool and instance to /respond', async () => {
    mockFetchSequence([
      structuredProbe('permission-id'),
      { data: { success: true, answer: '1' } },
    ]);

    await runRespond(['wt1', '1', '--agent', 'opencode']);

    expect(bodyOf(findCall('/respond') as [string, { body?: string }])).toEqual({
      answer: '1',
      cliTool: 'opencode',
    });
  });

  it('reports a question by the labels that reached the agent', async () => {
    // The number is a POSITION in the agent's own list, so what an operator
    // needs back is the other end of that mapping.
    mockFetchSequence([
      structuredProbe('permission-id'),
      {
        data: {
          success: true,
          answer: '2',
          resolved: {
            via: 'structured-question',
            decisionId: 'que_1',
            answers: [['Blue']],
            optionNumbers: [2],
            optionLabels: ['Blue'],
            freeText: false,
          },
        },
      },
    ]);

    await runRespond(['wt1', '2']);

    expect(mockConsoleLog).toHaveBeenCalledWith('Answered question que_1 with 2: Blue');
  });

  it('reports free text as the text that reached the agent', async () => {
    mockFetchSequence([
      structuredProbe('permission-id'),
      {
        data: {
          success: true,
          answer: 'use green',
          resolved: {
            via: 'structured-question',
            decisionId: 'que_1',
            answers: [['use green']],
            optionNumbers: [],
            optionLabels: [],
            freeText: true,
          },
        },
      },
    ]);

    await runRespond(['wt1', 'use green']);

    expect(mockConsoleLog).toHaveBeenCalledWith('Answered question que_1 with free text: use green');
  });
});

describe('the count rule, as the operator sees it', () => {
  it('names the reason and exits 99 when nothing is pending', async () => {
    mockFetchSequence([
      structuredProbe('permission-id'),
      { data: { error: 'nothing pending', code: 'decision_not_found' }, status: 404 },
    ]);

    await runRespond(['wt1', '3']);

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('decision_not_found'),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('was not sent'));
    expect(mockExit).toHaveBeenCalledWith(99);
    expect(mockConsoleError).not.toHaveBeenCalledWith('Response sent.');
  });

  it('lists the open decisions when several are, so the refusal has somewhere to go', async () => {
    mockFetchSequence([
      structuredProbe('permission-id'),
      {
        data: {
          error: 'two are open',
          code: 'multiple_pending_decisions',
          decisions: [
            { id: 'per_1', kind: 'permission', toolName: 'bash' },
            { id: 'que_1', kind: 'question', toolName: null },
          ],
        },
        status: 409,
      },
    ]);

    await runRespond(['wt1', '1']);

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('multiple_pending_decisions'),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('per_1'));
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('que_1'));
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('exits with the input-error code when the number names no option', async () => {
    // Issue #1726's rule, unchanged on the new path: a number the agent's own
    // list does not offer is a bad argument, and nothing was sent.
    mockFetchSequence([
      structuredProbe('permission-id'),
      {
        data: { error: "'9' is not one of the verdicts", code: 'answer_out_of_range' },
        status: 400,
      },
    ]);

    await runRespond(['wt1', '9']);

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('answer_out_of_range'),
    );
    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockExit).not.toHaveBeenCalledWith(99);
  });
});

describe('an agent that publishes no decision id keeps the path it had', () => {
  it('POSTs to /prompt-response for `respond <id> 3`', async () => {
    mockFetchSequence([
      structuredProbe(null),
      { data: { success: true, answer: '3' } },
    ]);

    await runRespond(['wt1', '3']);

    const promptCall = findCall('/prompt-response');
    expect(promptCall).toBeDefined();
    expect(bodyOf(promptCall as [string, { body?: string }])).toEqual({ answer: '3' });
    expect(findCall('/worktrees/wt1/respond')).toBeUndefined();
    expect(mockConsoleError).toHaveBeenCalledWith('Response sent.');
  });

  it('keeps --default on that path even for an agent that DOES publish ids', async () => {
    // There is a highlighted option in the TUI and nothing on the wire says
    // which, so the structured path refuses `--default` outright — while Enter
    // at a `keys` dialog is a real answer this command has always been able to
    // give. Routing it structurally would take that away.
    mockFetchSequence([{ data: { success: true, answer: '' } }]);

    await runRespond(['wt1', '--default']);

    expect(findCall('/prompt-response')).toBeDefined();
    // Not even probed: `--default` has no structured meaning to look up.
    expect(findCall('/current-output')).toBeUndefined();
  });
});

describe('a race between the probe and the answer', () => {
  it('falls back to /prompt-response when the server says the target is unaddressable', async () => {
    // A roster edit between the two requests changes which agent the target
    // resolves to. The server's own instruction for this code is "answer it
    // through /prompt-response", so a `respond` is not failed over a race.
    mockFetchSequence([
      structuredProbe('permission-id'),
      { data: { error: 'no per-decision id', code: 'decision_source_unaddressable' }, status: 404 },
      { data: { success: true, answer: '3' } },
    ]);

    await runRespond(['wt1', '3']);

    expect(findCall('/prompt-response')).toBeDefined();
    expect(mockConsoleError).toHaveBeenCalledWith('Response sent.');
    expect(mockExit).not.toHaveBeenCalled();
  });
});

describe('the probe fails open', () => {
  it('falls back to /prompt-response when the daemon predates structuredEvents', async () => {
    mockFetchSequence([
      { data: { isRunning: true } },
      { data: { success: true, answer: '3' } },
    ]);

    await runRespond(['wt1', '3']);

    expect(findCall('/prompt-response')).toBeDefined();
    expect(mockConsoleError).toHaveBeenCalledWith('Response sent.');
  });

  it('falls back when the probe itself cannot be made', async () => {
    // Both requests fail here — the point is that the command reports the
    // FAILURE OF THE ANSWER rather than dying at a request it only wanted to
    // read, so `/prompt-response` must still have been attempted.
    mockFetchError('ECONNREFUSED');

    await runRespond(['wt1', '3']);

    expect(findCall('/prompt-response')).toBeDefined();
  });
});
