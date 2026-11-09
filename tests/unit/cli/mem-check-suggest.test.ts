/**
 * `commandmate mem check --suggest [--quiet]` (Issue #4226, design §3.1, I-F8・I-F12),
 * through the real commander parser of `createMemCommand()`.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetchResponse, mockFetchUnreachable, restoreFetch } from '../../helpers/mock-api';
import { createMemCommand } from '../../../src/cli/commands/mem';
import { MemExitCode } from '../../../src/cli/types';
import type { MemSuggestResponse } from '../../../src/types/mem-suggest';

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
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void stderr.push(args.join(' ')));
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void stdout.push(args.join(' ')));
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
    await createMemCommand().parseAsync(['node', 'mem', ...argv]);
  } catch (error) {
    if ((error as Error).message !== 'process.exit') throw error;
  }
  return exitCode;
}

const inSession = () => {
  process.env.CM_WORKTREE_ID = 'w';
  process.env.CM_CLI_TOOL = 'claude';
};

const suggestion = { code: 'now_stale', itemIds: ['i1'], versions: [3], fingerprint: 'sha256:x', shown: false, message: 'm', command: 'commandmate mem now "<…>"' };
const answer = (extra: Partial<MemSuggestResponse> = {}): MemSuggestResponse => ({
  ok: true,
  mode: 'on',
  branch: 'feature/x',
  instanceId: 'claude',
  full: true,
  hook: null,
  suggestions: [],
  skipped: [],
  discarded: null,
  ...extra,
});
const fetchCalls = () => (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => !String(url).includes('/api/capabilities'));
const sentBody = () => JSON.parse(String(fetchCalls()[0][1].body));

describe('mem check --suggest (I-F12)', () => {
  it('a prompt is exit 57 (run() does not turn it into 0); none is 0; the text is one line per prompt', async () => {
    mockFetchResponse(answer({ suggestions: [suggestion as MemSuggestResponse['suggestions'][number]] }));
    expect(await run('check', '--suggest', '--worktree', 'w', '--instance', 'claude')).toBe(MemExitCode.SUGGESTED);
    expect(stdout).toEqual(['suggest now_stale item=i1 v3  m: commandmate mem now "<…>"']);
    expect(String(fetchCalls()[0][0])).toContain('/api/worktrees/w/mem/suggest');
    expect(sentBody()).toEqual({ instanceId: 'claude', full: true });
    exitCode = undefined;
    stdout = [];
    mockFetchResponse(answer());
    expect(await run('check', '--suggest', '--worktree', 'w', '--json')).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ suggestions: [] });
  });

  it('off / derived: exit 50, nothing on stdout (also with --json), one line on stderr', async () => {
    mockFetchResponse({ ok: false, code: 'disabled', mode: 'derived', message: 'x' }, 409);
    expect(await run('check', '--suggest', '--worktree', 'w', '--json')).toBe(50);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain('mode derived');
  });

  it('a discarded answer (the state moved) is exit 0 with a line on stderr', async () => {
    mockFetchResponse(answer({ discarded: 'mode' }));
    expect(await run('check', '--suggest', '--worktree', 'w')).toBe(0);
    expect(stderr.join('\n')).toContain('run it again');
  });

  it.each([
    [['check', '--instance', 'claude', '--worktree', 'w'], 'instance'],
    [['check', '--hook', 'manual', '--worktree', 'w'], 'hook'],
    [['check', '--suggest', '--hook', '--worktree', 'w'], 'hook'],
    [['check', '--suggest', '--hook', 'stop', '--worktree', 'w'], 'hook'],
    [['check', '--suggest', '--branch', 'main', '--worktree', 'w'], 'branch'],
  ])('%j is exit 2 (field %s) and sends nothing', async (argv, field) => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await run(...argv)).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toContain(`field=${field}`);
  });

  it('--hook is declared with an optional value (a missing one reaches the action)', () => {
    const check = createMemCommand().commands.find((command) => command.name() === 'check')!;
    const hook = check.options.find((option) => option.long === '--hook')!;
    expect(hook.optional).toBe(true);
    expect(hook.required).toBe(false);
  });
});

describe('mem check --suggest --quiet (I-F8)', () => {
  it('prints the quiet line only and exits 0; --json does not change it (quiet wins)', async () => {
    inSession();
    mockFetchResponse(answer({ full: false, quietLine: '[CommandMate mem] line', suggestions: [suggestion as MemSuggestResponse['suggestions'][number]] }));
    expect(await run('check', '--suggest', '--quiet', '--json', '--hook', 'pre_compact')).toBe(0);
    expect(stdout).toEqual(['[CommandMate mem] line']);
    expect(sentBody()).toEqual({ instanceId: 'claude', full: false, hook: 'pre_compact' });
  });

  it.each([
    ['no identity (headless)', [] as string[], false],
    ['another instance', ['--instance', 'codex'], true],
    ['another worktree', ['--worktree', 'other'], true],
  ])('%s: exit 0, nothing sent, stdout empty', async (_name, extra, session) => {
    if (session) inSession();
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await run('check', '--suggest', '--quiet', ...extra)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
  });

  it.each([
    [['check', '--quiet']],
    [['check', '--suggest', '--quiet', '--hook']],
    [['check', '--suggest', '--quiet', '--hook', 'stop']],
    [['check', '--suggest', '--quiet', '--branch', 'main']],
  ])('a flag error inside the action %j is exit 0 with one line on stderr', async (argv) => {
    inSession();
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await run(...argv)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('a server that does not answer, or answers off / 500: exit 0, stdout empty', async () => {
    inSession();
    mockFetchUnreachable();
    expect(await run('check', '--suggest', '--quiet')).toBe(0);
    for (const [body, status] of [
      [{ ok: false, code: 'disabled', message: 'x' }, 409],
      [{ ok: false, code: 'internal_error', message: 'x' }, 500],
    ] as const) {
      exitCode = undefined;
      mockFetchResponse(body, status);
      expect(await run('check', '--suggest', '--quiet')).toBe(0);
    }
    expect(stdout).toEqual([]);
  });

  it('(range) an unknown flag is still the parser’s: exit 1', async () => {
    inSession();
    expect(await run('check', '--suggest', '--quiet', '--nope')).toBe(1);
  });
});

describe('E-0: check without the new flags is as it was', () => {
  it('the same request body and output; other subcommands still exit 0', async () => {
    mockFetchResponse({ ok: true, mode: 'on', branch: 'main', results: [] });
    expect(await run('check', '--worktree', 'w', '--branch', 'main')).toBe(0);
    expect(String(fetchCalls()[0][0])).toContain('/api/worktrees/w/mem/check');
    expect(sentBody()).toEqual({ branch: 'main' });
    expect(stdout).toEqual(['mode: on  branch: main  evaluated: 0']);
    exitCode = undefined;
    mockFetchResponse({ ok: true, mode: 'on', source: { level: 'fallback' }, branch: 'main', detached: false });
    expect(await run('mode', '--worktree', 'w')).toBe(0);
  });
});
