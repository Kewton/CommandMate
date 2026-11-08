/**
 * `commandmate send --no-brief / --with-brief` (Issue #4274): the flags reach the
 * send body as `brief: 'skip' | 'force'`, a plain send's body is the one it was,
 * both flags together are exit 2 with nothing sent, and `ask` sends no flag.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`exit ${code}`);
}) as never);
vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleError.mockClear();
});

type FetchCall = [string, { body?: string }];
const fetchCalls = (): FetchCall[] => ((global.fetch as ReturnType<typeof vi.fn> | undefined)?.mock.calls ?? []) as FetchCall[];
const sendBody = (): Record<string, unknown> | undefined => {
  const call = fetchCalls().find((entry) => String(entry[0]).includes('/send'));
  return call ? JSON.parse(call[1].body ?? '{}') : undefined;
};

async function runSend(argv: string[]): Promise<void> {
  const { createSendCommand } = await import('../../../../src/cli/commands/send');
  try {
    await createSendCommand().parseAsync(['node', 'send', ...argv]);
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('exit '))) throw error;
  }
}

describe('[#4274] send --no-brief / --with-brief', () => {
  it('(control) a plain send carries no brief field', async () => {
    mockFetchSequence([{ data: { id: 1 }, status: 201 }]);
    await runSend(['wt1', 'hello', '--agent', 'claude']);
    expect(sendBody()).toEqual({ content: 'hello', cliToolId: 'claude' });
  });

  it('--no-brief sends brief: skip', async () => {
    mockFetchSequence([{ data: { id: 1 }, status: 201 }]);
    await runSend(['wt1', 'hello', '--agent', 'claude', '--no-brief']);
    expect(sendBody()).toEqual({ content: 'hello', cliToolId: 'claude', brief: 'skip' });
  });

  it('--with-brief sends brief: force', async () => {
    mockFetchSequence([{ data: { id: 1 }, status: 201 }]);
    await runSend(['wt1', 'hello', '--agent', 'claude', '--with-brief']);
    expect(sendBody()).toEqual({ content: 'hello', cliToolId: 'claude', brief: 'force' });
  });

  it('both: exit 2, nothing sent', async () => {
    mockFetchSequence([{ data: { id: 1 }, status: 201 }]);
    await runSend(['wt1', 'hello', '--agent', 'claude', '--no-brief', '--with-brief']);
    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('--with-brief or --no-brief'));
    expect(sendBody()).toBeUndefined();
  });

  it('--help states the flags and the verified length from the shared constants', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const { SEND_VERIFIED_MAX_KIB, SEND_VERIFIED_MAX_LINES } = await import('../../../../src/config/send-verified-limits');
    let help = '';
    const cmd = createSendCommand();
    cmd.configureOutput({ writeOut: (text) => (help += text) });
    cmd.outputHelp();
    expect(help).toContain('--no-brief');
    expect(help).toContain('--with-brief');
    expect(help).toContain(`up to ${SEND_VERIFIED_MAX_KIB} KiB and ${SEND_VERIFIED_MAX_LINES} lines`);
  });
});

describe('[#4274] ask sends no brief flag (the route’s auto applies)', () => {
  it('the ask source builds its body without a brief field', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync('src/cli/commands/ask.ts', 'utf8');
    expect(source).not.toMatch(/\bbrief\s*[:=]|\.brief\b|['"]brief['"]/);
    const dispatch = readFileSync('src/cli/commands/message-dispatch.ts', 'utf8');
    expect(dispatch).not.toMatch(/\bbrief\s*[:=]|\.brief\b|['"]brief['"]/);
  });
});
