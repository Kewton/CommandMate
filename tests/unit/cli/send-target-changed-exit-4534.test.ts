/**
 * Issue #4534 PR-B s2, T18 (the human's answer C4・C5・Q3 (a)): the CLI's end of
 * the send route's 409 `SEND_TARGET_CHANGED`.
 *
 * - `sendOutcome: not_sent` → exit 34 (`SendTargetExitCode.CHANGED`): nothing
 *   of the message was delivered, so reading the roster again and resending is
 *   safe.
 * - `sendOutcome: unknown` → exit 99 as today: it may have arrived. A bound
 *   relay is NOT withdrawn, and stderr says to look at the pane first.
 * - No `sendOutcome`, or one that is not a value → not 34 (no proof).
 * - stdout gets nothing; stderr has the resend note (as today) and then ONE
 *   `Error: <the server's sentence>` line.
 *
 * Controls: `roster_changed` stays 31, `TOOL_POLICY_DENIED` stays 33, a lost
 * reservation (500 with no code) stays 99.
 *
 * The client is a stub; nothing is sent anywhere.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, handleApiError, type ApiErrorPayload } from '@/cli/utils/api-client-errors';
import { postMessage } from '@/cli/commands/message-dispatch';
import { handleSendFailure } from '@/cli/commands/send-action-support';
import type { ApiClient } from '@/cli/utils/api-client';
import * as cliTypes from '@/cli/types';
import { toolPolicyDenialFromResponse } from '@/cli/utils/tool-policy-failure';

const WT = 'wt-cli-4534';
const NOT_SENT_TEXT = 'Send stopped: the target changed while the message was being sent (send target changed: tool-changed). The message was not delivered; read the roster again, then send it again.';
const UNKNOWN_TEXT = 'Send stopped: the target changed while the message was being sent (send target changed: tool-changed). The message may already have reached the session; look at the pane before sending it again.';

function targetChanged(sendOutcome: unknown, error = NOT_SENT_TEXT): ApiErrorPayload {
  const payload: Record<string, unknown> = {
    error,
    code: 'SEND_TARGET_CHANGED',
    reason: 'tool-changed',
    target: { worktreeId: WT, instanceId: 'codex', cliToolId: 'codex' },
    current: { cliToolId: 'claude', resolvedBy: 'roster' },
    requestId: 'send-1-1',
  };
  if (sendOutcome !== undefined) payload.sendOutcome = sendOutcome;
  return payload as ApiErrorPayload;
}

/** The ApiError the client throws for (status, payload), as `ApiClient` builds it. */
function apiError(status: number, payload: ApiErrorPayload): ApiError {
  const result = handleApiError(null, status, payload);
  return new ApiError(result.message, result.exitCode, status, payload);
}

class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

let stdout: string[] = [];
let stderr: string[] = [];
beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void stdout.push(args.join(' ')));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void stderr.push(args.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void stderr.push(args.join(' ')));
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exited(code);
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** `send`'s failing post, end to end: postMessage, then the command's failure report. */
async function failedSend(error: ApiError, relay?: { id: string; bound: boolean }): Promise<{ exit: number | undefined; posts: string[] }> {
  const posts: string[] = [];
  const client = {
    post: vi.fn(async (path: string) => {
      posts.push(path);
      if (path.endsWith('/send')) throw error;
      return {};
    }),
    get: vi.fn(async () => {
      throw new Error('not asked');
    }),
  } as unknown as ApiClient;
  let exit: number | undefined;
  try {
    await postMessage(client, WT, { content: 'hello' }, {
      relay,
      promptWaitingFallback: 'waiting',
      target: { target: null, agent: 'codex', instanceId: 'codex' },
    });
  } catch (thrown) {
    try {
      handleSendFailure(thrown, {} as never, WT);
    } catch (end) {
      if (!(end instanceof Exited)) throw end;
      exit = end.code;
    }
  }
  return { exit, posts };
}

describe('T18: the exit code of a 409 SEND_TARGET_CHANGED', () => {
  it('[T18] SendTargetExitCode.CHANGED is 34, and no other exit code of the CLI is 34', () => {
    const named = (cliTypes as unknown as Record<string, unknown>).SendTargetExitCode as Record<string, number> | undefined;
    expect(named?.CHANGED).toBe(34);
    const others: Array<[string, string, number]> = [];
    for (const [name, value] of Object.entries(cliTypes as unknown as Record<string, unknown>)) {
      if (name === 'SendTargetExitCode' || typeof value !== 'object' || value === null) continue;
      for (const [key, code] of Object.entries(value as Record<string, unknown>)) {
        if (code === 34) others.push([name, key, code]);
      }
    }
    expect(others).toEqual([]);
  });

  it.each([
    ['not_sent', 34],
    ['unknown', 99],
    [undefined, 99],
    ['sent', 99],
    ['maybe', 99],
  ] as const)('[T18] handleApiError: sendOutcome %s → exit %s, the server’s sentence as the message', (outcome, code) => {
    const result = handleApiError(null, 409, targetChanged(outcome));
    expect(result.exitCode).toBe(code);
    expect(result.message).toBe(NOT_SENT_TEXT);
  });

  it('[T18] send, not_sent: exit 34; stdout nothing; stderr the resend note then one Error line; an unbound send posts nothing else', async () => {
    const { exit, posts } = await failedSend(apiError(409, targetChanged('not_sent')));
    expect(exit).toBe(34);
    expect(stdout).toEqual([]);
    expect(stderr.filter((l) => l.startsWith('Error: '))).toEqual([`Error: ${NOT_SENT_TEXT}`]);
    expect(stderr[stderr.length - 1]).toBe(`Error: ${NOT_SENT_TEXT}`);
    expect(stderr.some((l) => l.includes('sendOutcome=not_sent'))).toBe(true);
    expect(posts).toEqual([`/api/worktrees/${WT}/send`]);
  });

  it('[T18] send with a bound relay, not_sent: exit 34 and the relay is withdrawn (as for any not_sent)', async () => {
    const { exit, posts } = await failedSend(apiError(409, { ...targetChanged('not_sent'), relayId: 'r1' } as ApiErrorPayload), { id: 'r1', bound: true });
    expect(exit).toBe(34);
    expect(posts).toContain('/api/relays/r1/cancel');
  });

  it('[T18] send with a bound relay, unknown: exit 99, the relay is NOT withdrawn, stderr says to look at the pane first', async () => {
    const { exit, posts } = await failedSend(apiError(409, { ...targetChanged('unknown', UNKNOWN_TEXT), relayId: 'r2' } as ApiErrorPayload), { id: 'r2', bound: true });
    expect(exit).toBe(99);
    expect(posts).not.toContain('/api/relays/r2/cancel');
    expect(stdout).toEqual([]);
    expect(stderr.some((l) => /relay r2 was left open/.test(l) && /capture/.test(l))).toBe(true);
    expect(stderr.filter((l) => l.startsWith('Error: '))).toEqual([`Error: ${UNKNOWN_TEXT}`]);
  });

  it('[T18] send, unknown, no relay: exit 99, the "check the pane first" note', async () => {
    const { exit } = await failedSend(apiError(409, targetChanged('unknown', UNKNOWN_TEXT)));
    expect(exit).toBe(99);
    expect(stderr.some((l) => l.includes('sendOutcome=unknown') && l.includes('capture'))).toBe(true);
  });

  it('[T18] send, a 409 SEND_TARGET_CHANGED with no sendOutcome: not 34', async () => {
    const { exit } = await failedSend(apiError(409, targetChanged(undefined)));
    expect(exit).not.toBe(34);
    expect(exit).toBe(99);
  });
});

describe('T18 controls: the other answers keep their exit codes', () => {
  it('[T18-control] roster_changed is 31', () => {
    expect(handleApiError(null, 409, { code: 'ROSTER_CHANGED', error: 'x' }).exitCode).toBe(31);
  });

  it('[T18-control] a lost reservation (500, no code, not_sent) is 99 with the server’s sentence', async () => {
    const payload = { error: 'Failed to send message to Codex CLI: Input boundary could not be recorded (relay r is no longer reserved for this send); nothing was typed (Issue #3957)', sendOutcome: 'not_sent' } as ApiErrorPayload;
    const { exit } = await failedSend(apiError(500, payload));
    expect(exit).toBe(99);
  });

  it('[T18-control] TOOL_POLICY_DENIED is 33', async () => {
    const payload = {
      error: 'refused by the tool policy',
      code: 'TOOL_POLICY_DENIED',
      reason: 'undeclared-use',
      operation: 'send',
      origin: 'agent',
      sent: false,
      links: [],
      unlock: [],
    } as unknown as ApiErrorPayload;
    // The client turns this 409 into its own error (`toolPolicyDenialFromResponse`), as ApiClient does.
    const denial = toolPolicyDenialFromResponse(409, payload);
    expect(denial).not.toBeNull();
    const { exit } = await failedSend(denial as unknown as ApiError);
    expect(exit).toBe(33);
  });
});
