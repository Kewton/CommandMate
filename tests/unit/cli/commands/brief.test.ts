/**
 * `commandmate brief` (Issue #4223, design §6): the input it refuses before asking
 * (exit 2), the exit code per refusal, `off` printing nothing (exit 50), and the output
 * written as the server built it plus one newline — the bytes the budget counted.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';
import { createBriefCommand } from '../../../../src/cli/commands/brief';

const SESSION_ENV = ['TMUX', 'TMUX_PANE', 'CM_WORKTREE_ID', 'CM_AGENT_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_AGENT_INSTANCE_ID', 'CM_CLI_TOOL', 'CM_AGENT_TOOL'];
let saved: Record<string, string | undefined>;
let exitCode: number | undefined;
let stderr: string[];
let stdout: string[];

beforeEach(() => {
  saved = {};
  for (const name of [...SESSION_ENV, 'CM_PORT']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.CM_PORT = '39421';
  exitCode = undefined;
  stderr = [];
  stdout = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('process.exit');
  }) as never);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void stderr.push(args.join(' ')));
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void stdout.push(args.join(' ')));
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    stdout.push(String(chunk));
    return true;
  }) as never);
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

describe('commandmate brief', () => {
  it.each([
    [['--budget', '1023'], 'text below the minimum'],
    [['--budget', '0'], 'zero'],
    [['--budget', '-1'], 'negative'],
    [['--budget', '1.5'], 'not whole'],
    [['--budget', '1e3'], 'exponent'],
    [['--budget', ''], 'empty'],
    [['--budget', '49153'], 'over the maximum'],
    [['--budget', '4095', '--json'], 'json below its minimum'],
    [['--all', '--budget', '4096'], '--all with --budget'],
  ])('%j (%s) is exit 2 and asks nothing', async (args) => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await run(...TARGET, ...args)).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdout.join('')).toBe('');
  });

  it('one of --worktree / --instance alone, or no target outside a session, is exit 2', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await run('--worktree', 'wt-1')).toBe(2);
    expect(await run('--instance', 'claude')).toBe(2);
    expect(await run()).toBe(2);
    expect(stdout.join('')).toBe('');
  });

  it('the minimum itself is asked for (negative control)', async () => {
    mockFetchResponse({ ok: true, format: 'text', mode: 'on', text: 'brief', omitted: 0 });
    expect(await run(...TARGET, '--budget', '1024')).toBe(0);
    const url = String((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    expect(url).toContain('/api/worktrees/wt-1/mem/brief?instance=claude&format=text&budget=1024');
  });

  it('writes the server’s text and one newline, nothing else', async () => {
    mockFetchResponse({ ok: true, format: 'text', mode: 'on', text: '<<<cmate-brief:x\n…\ncmate-brief:x>>>', omitted: 0 });
    expect(await run(...TARGET)).toBe(0);
    expect(stdout.join('')).toBe('<<<cmate-brief:x\n…\ncmate-brief:x>>>\n');
  });

  it('--json writes the body on one line', async () => {
    const body = { ok: true, schema: 'cmate-brief/v1', mode: 'derived', entries: [{ text: '日本語 👩‍💻' }] };
    mockFetchResponse(body);
    expect(await run(...TARGET, '--json', '--all')).toBe(0);
    expect(stdout.join('')).toBe(`${JSON.stringify(body)}\n`);
    const url = String((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    expect(url).toContain('format=json');
    expect(url).toContain('all=1');
  });

  it('off: nothing on stdout, one line on stderr, exit 50', async () => {
    mockFetchResponse({ ok: false, code: 'disabled', message: 'mem is not enabled for this branch', mode: 'off' }, 409);
    expect(await run(...TARGET)).toBe(50);
    expect(stdout.join('')).toBe('');
    expect(stderr).toHaveLength(1);
  });

  it.each([
    ['not_registered', 404, 52],
    ['instance_not_found', 404, 52],
    ['not_found', 404, 52],
    ['ambiguous', 409, 53],
    ['invalid_request', 400, 2],
    ['internal_error', 500, 99],
  ] as const)('maps %s to exit %d with nothing on stdout', async (code, status, exit) => {
    mockFetchResponse({ ok: false, code, message: 'x' }, status);
    expect(await run(...TARGET)).toBe(exit);
    expect(stdout.join('')).toBe('');
  });

  it('refuses an id of the wrong shape before asking', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await run('--worktree', 'wt-1', '--instance', 'bad id')).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
