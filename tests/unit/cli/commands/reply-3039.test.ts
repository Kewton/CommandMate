/**
 * `commandmate reply` (Issue #3039)
 *
 * The latest reply of a session, read from the chat ledger rows the transcript
 * readers write (`<tool>-turn:<id>`), with no knowledge of where the tool keeps
 * its transcript file. The ledger is faked at the fetch boundary, as the `ask`
 * tests do, with Command Code as the tool — the worker the Issue is about.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const ESC = String.fromCharCode(27);

const json = (data: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }) as unknown as Response;

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'm',
    worktreeId: 'wt1',
    role: 'assistant',
    messageType: 'normal',
    archived: false,
    ...overrides,
  };
}

const T0 = '2026-09-30T10:00:00.000Z';
const T1 = '2026-09-30T10:05:00.000Z';
const T2 = '2026-09-30T10:06:00.000Z';

/** A ledger as Command Code's transcript reader and the server leave it. */
const LEDGER = [
  row({ id: 'u', role: 'user', content: 'stop and report', timestamp: T0 }),
  row({ id: 'old', content: 'earlier turn', timestamp: T0, requestId: 'command-code-turn:a1' }),
  row({
    id: 'report',
    content: `${ESC}[1mStopped.${ESC}[0m The migration is half done.`,
    timestamp: T1,
    requestId: 'command-code-turn:b2',
  }),
  // A screen scrape (no request id) and CommandMate's own furniture: neither
  // is a reply, even though both are newer.
  row({ id: 'scrape', content: '> composer', timestamp: T2 }),
  row({ id: 'relay', content: 'reply from x', timestamp: T2, requestId: 'relay-sys:r1' }),
  row({ id: 'model', content: 'model changed', timestamp: T2, requestId: 'model-changed:m1' }),
];

interface Routes {
  messages: unknown;
  messagesStatus?: number;
}

const fetchedUrls: string[] = [];

function mockRoutes(routes: Routes): void {
  fetchedUrls.length = 0;
  global.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    fetchedUrls.push(url);
    if (url.includes('/api/capabilities')) {
      return Promise.resolve(
        json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }),
      );
    }
    if (url.includes('/resolve-target')) {
      return Promise.resolve(
        json({
          cliToolId: 'command-code',
          instanceId: 'command-code',
          resolvedBy: 'roster',
          conflict: null,
        }),
      );
    }
    if (url.includes('/messages')) {
      return Promise.resolve(json(routes.messages, routes.messagesStatus ?? 200));
    }
    if (url.includes('/capture')) {
      return Promise.resolve(json({ output: 'PANE MUST NOT BE READ' }));
    }
    return Promise.resolve(json({ error: 'unexpected' }, 404));
  }) as unknown as typeof fetch;
}

async function runReply(argv: string[]): Promise<void> {
  const { createReplyCommand } = await import('../../../../src/cli/commands/reply');
  await createReplyCommand().parseAsync(['node', 'reply', ...argv]);
}

function payload(): Record<string, unknown> {
  return JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
}

describe('reply: latest transcript reply (Issue #3039)', () => {
  it('prints the newest command-code turn row, sanitized, without reading the pane', async () => {
    mockRoutes({ messages: LEDGER });

    await runReply(['wt1', '--instance', 'command-code']);

    expect(mockConsoleLog).toHaveBeenCalledWith('Stopped. The migration is half done.');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    expect(fetchedUrls.some((u) => u.includes('/capture'))).toBe(false);
    expect(fetchedUrls.some((u) => u.includes('/messages') && u.includes('instance=command-code')))
      .toBe(true);
  });

  it('--json carries the row\'s requestId and timestamp', async () => {
    mockRoutes({ messages: LEDGER });

    await runReply(['wt1', '--agent', 'command-code', '--json']);

    expect(payload()).toEqual({
      worktreeId: 'wt1',
      instanceId: 'command-code',
      cliToolId: 'command-code',
      reply: 'Stopped. The migration is half done.',
      requestId: 'command-code-turn:b2',
      at: T1,
    });
    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
  });

  it('does not return a reply written before --since', async () => {
    mockRoutes({ messages: LEDGER });

    await runReply(['wt1', '--instance', 'command-code', '--since', '2026-09-30T10:05:30Z', '--json']);

    expect(payload()).toMatchObject({ reply: null, requestId: null, at: null });
    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
  });

  it('returns the reply written at or after --since', async () => {
    mockRoutes({ messages: LEDGER });

    await runReply(['wt1', '--instance', 'command-code', '--since', '2026-09-30T10:01:00Z']);

    expect(mockConsoleLog).toHaveBeenCalledWith('Stopped. The migration is half done.');
  });

  it('with no turn row: exit 0, empty stdout, one line on stderr', async () => {
    mockRoutes({ messages: LEDGER.filter((m) => !String(m.requestId ?? '').includes('-turn:')) });

    await runReply(['wt1', '--instance', 'command-code']);

    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockConsoleError).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
  });

  it('with no turn row, --json prints reply: null', async () => {
    mockRoutes({ messages: [] });

    await runReply(['wt1', '--instance', 'command-code', '--json']);

    expect(payload()).toMatchObject({ reply: null, requestId: null, at: null });
    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
  });

  it('rejects a --since that is not an ISO 8601 date-time', async () => {
    mockRoutes({ messages: LEDGER });

    await runReply(['wt1', '--since', 'yesterday']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
  });

  it('a failed ledger read is an error, not "no reply"', async () => {
    mockRoutes({ messages: { error: 'boom' }, messagesStatus: 500 });

    await runReply(['wt1', '--instance', 'command-code']);

    expect(mockExit).not.toHaveBeenCalledWith(ExitCode.SUCCESS);
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });
});
