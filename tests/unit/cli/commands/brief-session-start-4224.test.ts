/**
 * `commandmate brief --session-start` (Issue #4224, D2 design §6.3・§6.4 K1): when the
 * server says the send path briefs the conversation (`deferred: 'send'`), stdout stays
 * empty and the exit is 0 — one line on stderr says why. Otherwise the text is printed as
 * the plain command prints it. Not with `--json` (exit 2, nothing asked).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';
import { createBriefCommand } from '../../../../src/cli/commands/brief';

let exitCode: number | undefined;
let stderr: string[];
let stdout: string[];
let savedPort: string | undefined;

beforeEach(() => {
  savedPort = process.env.CM_PORT;
  process.env.CM_PORT = '39421';
  exitCode = undefined;
  stderr = [];
  stdout = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('process.exit');
  }) as never);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void stderr.push(args.join(' ')));
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    stdout.push(String(chunk));
    return true;
  }) as never);
});
afterEach(() => {
  if (savedPort === undefined) delete process.env.CM_PORT;
  else process.env.CM_PORT = savedPort;
  restoreFetch();
  vi.restoreAllMocks();
});

async function run(...argv: string[]): Promise<number | undefined> {
  try {
    await createBriefCommand().parseAsync(['node', 'brief', ...argv]);
  } catch (error) {
    if ((error as Error).message !== 'process.exit') throw error;
  }
  return exitCode;
}

const TARGET = ['--worktree', 'wt-1', '--instance', 'claude'];

describe('commandmate brief --session-start', () => {
  it('deferred to the send: nothing on stdout, exit 0, one line on stderr; the query names sessionStart=1', async () => {
    mockFetchResponse({ ok: true, format: 'text', mode: 'on', text: '', omitted: 0, deferred: 'send' });
    expect(await run(...TARGET, '--session-start')).toBe(0);
    expect(stdout.join('')).toBe('');
    expect(stderr).toHaveLength(1);
    const url = String((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    expect(url).toContain('sessionStart=1');
  });

  it('negative: not deferred — the text and one newline, as the plain command', async () => {
    mockFetchResponse({ ok: true, format: 'text', mode: 'on', text: '<<<cmate-brief:x\n…\ncmate-brief:x>>>', omitted: 0 });
    expect(await run(...TARGET, '--session-start')).toBe(0);
    expect(stdout.join('')).toBe('<<<cmate-brief:x\n…\ncmate-brief:x>>>\n');
  });

  it('with --json: exit 2 and nothing is asked', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await run(...TARGET, '--session-start', '--json')).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdout.join('')).toBe('');
  });
});
