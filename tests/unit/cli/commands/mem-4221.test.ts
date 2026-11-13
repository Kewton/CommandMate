/**
 * `commandmate mem` (Issue #4221, design §12): the exit code per refusal, the target
 * an ordinary shell must name, purge refused inside a session, no way to change the
 * mode, and errors that never repeat what was refused.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';
import { createMemCommand } from '../../../../src/cli/commands/mem';
import { MEM_EXIT_BY_CODE } from '../../../../src/types/mem';

const GHP = `ghp_${'d'.repeat(36)}`;
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

describe('commandmate mem', () => {
  it('has no subcommand or option that changes the mode', () => {
    const mem = createMemCommand();
    expect(mem.commands.map((command) => command.name())).toEqual(['now', 'add', 'update', 'close', 'list', 'check', 'mode', 'purge', 'decisions']);
    const mode = mem.commands.find((command) => command.name() === 'mode')!;
    expect(mode.options.map((option) => option.long).sort()).toEqual(['--branch', '--json', '--repository', '--token', '--worktree']);
    // Issue #4355: decisions reads; none of its options changes the mode.
    const decisions = mem.commands.find((command) => command.name() === 'decisions')!;
    expect(decisions.options.map((option) => option.long).sort()).toEqual(['--branch', '--effect', '--json', '--pending', '--repository', '--token', '--worktree']);
  });

  it('asks an ordinary shell to name the target (exit 2) and sends nothing', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await run('now', 'x')).toBe(2);
    expect(await run('list')).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toContain('target_required');
  });

  it.each([
    ['disabled', 409, 50],
    ['version_conflict', 409, 51],
    ['not_registered', 404, 52],
    ['item_not_found', 404, 52],
    ['ambiguous', 409, 53],
    ['duplicate_key', 409, 54],
    ['not_owner', 409, 55],
    ['limit_exceeded', 409, 56],
    ['invalid_close_when', 400, 2],
  ] as const)('maps %s to its exit code', async (code, status, exit) => {
    mockFetchResponse({ ok: false, code, message: 'x' }, status);
    expect(await run('add', '--worktree', 'w', '--instance', 'claude', '--kind', 'note', '--text', 't')).toBe(exit);
    expect(MEM_EXIT_BY_CODE[code]).toBe(exit);
  });

  it('never repeats a refused value in stderr or --json', async () => {
    mockFetchResponse({ ok: false, code: 'secret_like', field: 'text', rule: 'github-token', message: 'A field looks like it contains a secret' }, 400);
    expect(await run('add', '--worktree', 'w', '--instance', 'claude', '--kind', 'note', '--text', `x ${GHP}`)).toBe(2);
    expect(stderr.join('\n')).toContain('secret_like');
    expect(stderr.join('\n')).toContain('rule=github-token');
    expect(stderr.join('\n')).not.toContain(GHP);
    stdout = [];
    expect(await run('add', '--worktree', 'w', '--instance', 'claude', '--kind', 'note', '--text', `x ${GHP}`, '--json')).toBe(2);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ code: 'secret_like', exitCode: 2 });
    expect(stdout.join('\n')).not.toContain(GHP);
  });

  it('reads the mode (exit 0, --json is the body)', async () => {
    const body = { ok: true, mode: 'on', source: { level: 'rule', rulePosition: 0, pattern: 'main' }, branch: 'main', detached: false };
    mockFetchResponse(body);
    expect(await run('mode', '--worktree', 'w', '--json')).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ mode: 'on' });
  });

  it('refuses purge from inside an agent session (55) and sends nothing', async () => {
    process.env.CM_WORKTREE_ID = 'w';
    process.env.CM_CLI_TOOL = 'claude';
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await run('purge', '--branch', 'main', '--confirm')).toBe(55);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('purge without --confirm asks for counts only', async () => {
    mockFetchResponse({ ok: true, dryRun: true, counts: { note: 2 } });
    expect(await run('purge', '--worktree', 'w', '--branch', 'main')).toBe(0);
    const body = JSON.parse(String((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(body).toEqual({ branch: 'main' });
    expect(stdout.join('\n')).toContain('Would delete');
  });
});
