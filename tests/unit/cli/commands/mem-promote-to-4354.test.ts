/**
 * `commandmate mem` and Issue #4354: a destination refused when written exits 2 and says why
 * and what to do; `mem list` shows an expired decision and a stored destination that cannot be
 * used. The server is a mocked fetch (its answers as `memAddItem` / `memList` give them).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';
import { createMemCommand, PROMOTE_TO_REFUSAL_HINTS } from '../../../../src/cli/commands/mem';
import { MEM_EXIT_BY_CODE } from '../../../../src/types/mem';

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

const refused = (reason: string) => ({ ok: false, code: 'invalid_promote_to', message: 'The promote destination is not valid', field: 'promoteTo', reason });

describe('mem add --promote-to: the refusal of the shared rule', () => {
  it.each(['agent_instructions', 'git_dir', 'not_markdown'])('%s → exit 2, the code, the reason and what to do', async (reason) => {
    mockFetchResponse(refused(reason), 400);
    const exit = await run('add', '--worktree', 'w', '--instance', 'claude', '--kind', 'decision', '--text', 't', '--promote-to', 'path:CLAUDE.md');
    expect(exit).toBe(2);
    expect(MEM_EXIT_BY_CODE.invalid_promote_to).toBe(2);
    const printed = stderr.join('\n');
    expect(printed).toContain('invalid_promote_to');
    expect(printed).toContain(`reason=${reason}`);
    expect(printed).toContain(PROMOTE_TO_REFUSAL_HINTS[reason]);
  });

  it('the instruction-file hint names the way out (docs/ or an Issue, the instruction file by hand)', () => {
    expect(PROMOTE_TO_REFUSAL_HINTS.agent_instructions).toMatch(/docs\//);
    expect(PROMOTE_TO_REFUSAL_HINTS.agent_instructions).toMatch(/issue:#N/);
    expect(PROMOTE_TO_REFUSAL_HINTS.agent_instructions).toMatch(/by hand/);
  });

  it('--json carries the reason as it is, with exit 2', async () => {
    mockFetchResponse(refused('agent_instructions'), 400);
    expect(await run('add', '--worktree', 'w', '--instance', 'claude', '--kind', 'decision', '--text', 't', '--promote-to', 'path:AGENTS.md', '--json')).toBe(2);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ code: 'invalid_promote_to', reason: 'agent_instructions', exitCode: 2 });
  });

  it('(control) another refusal prints no promote hint', async () => {
    mockFetchResponse({ ok: false, code: 'invalid_close_when', message: 'x', reason: 'agent_instructions' }, 400);
    expect(await run('add', '--worktree', 'w', '--instance', 'claude', '--kind', 'note', '--text', 't')).toBe(2);
    expect(stderr.join('\n')).not.toContain(PROMOTE_TO_REFUSAL_HINTS.agent_instructions);
  });
});

describe('mem list: the marks of #4354', () => {
  const view = (id: string, extra: Record<string, unknown>) => ({
    id,
    kind: 'decision',
    state: 'open',
    text: `決定 ${id}`,
    closeWhen: null,
    promoteTo: 'issue:#1',
    owner: { repositoryId: 'r', branch: 'feature/x', worktreeId: 'w', instanceId: 'claude' },
    createdBy: 'agent',
    updatedBy: 'agent',
    version: 1,
    createdAt: '2026-11-22T00:00:00.000Z',
    updatedAt: '2026-11-22T00:00:00.000Z',
    closedAt: null,
    closeReason: null,
    stale: false,
    frozen: false,
    ...extra,
  });

  it('prints expired and promote-to-refused:<reason>, and nothing for an item without them', async () => {
    mockFetchResponse({
      ok: true,
      mode: 'on',
      branch: 'feature/x',
      items: [view('d1', { expired: true }), view('d2', { promoteTo: 'path:CLAUDE.md', promoteToRefusal: 'agent_instructions' }), view('d3', {})],
      now: [],
      warnings: [],
    });
    expect(await run('list', '--worktree', 'w')).toBe(0);
    const lines = stdout.join('\n').split('\n');
    expect(lines.find((line) => line.includes(' d1 '))).toContain('(expired)');
    expect(lines.find((line) => line.includes(' d2 '))).toContain('(promote-to-refused:agent_instructions)');
    expect(lines.find((line) => line.includes(' d3 '))).not.toContain('(');
  });
});
