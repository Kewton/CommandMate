/**
 * `commandmate handoff` (Issue #4227 G-PR2, design `mem-ui-4227.md` §4.3・§7.3): the agent's
 * side only — `propose` (add / update / close) and `done`. No subcommand approves, cancels or
 * ends (those are the screen's, with its mark), the request is named, an ordinary shell names
 * its target, and the hand-off's refusals map onto mem's exit codes (52 / 55, 50, 51).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';
import { createHandoffCommand, handoffExitCode } from '../../../../src/cli/commands/handoff';

const SESSION_ENV = ['TMUX', 'TMUX_PANE', 'CM_WORKTREE_ID', 'CM_AGENT_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_AGENT_INSTANCE_ID', 'CM_CLI_TOOL', 'CM_AGENT_TOOL'];
let saved: Record<string, string | undefined>;
let exitCode: number | undefined;
let stderr: string[];

beforeEach(() => {
  saved = {};
  for (const name of [...SESSION_ENV, 'CM_PORT']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.CM_PORT = '39427';
  exitCode = undefined;
  stderr = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('process.exit');
  }) as never);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void stderr.push(args.join(' ')));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
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
    await createHandoffCommand().parseAsync(['node', 'handoff', ...argv]);
  } catch (error) {
    if ((error as Error).message !== 'process.exit') throw error;
  }
  return exitCode;
}
const target = ['--worktree', 'w', '--instance', 'claude', '--request', 'r1'];
const sentBody = () => JSON.parse(String((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
const sentUrl = () => String((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);

describe('[#4227] commandmate handoff', () => {
  it('has propose and done only — nothing approves, cancels or ends', () => {
    const handoff = createHandoffCommand();
    expect(handoff.commands.map((command) => command.name())).toEqual(['propose', 'done']);
    const propose = handoff.commands.find((command) => command.name() === 'propose')!;
    expect(propose.commands.map((command) => command.name())).toEqual(['add', 'update', 'close']);
  });

  it('proposes an add to the request’s proposals route (never decides)', async () => {
    mockFetchResponse({ ok: true, proposal: { id: 'p1', state: 'proposed' } }, 201);
    expect(await run('propose', 'add', ...target, '--kind', 'note', '--text', 'a note')).toBe(0);
    expect(sentUrl()).toContain('/api/worktrees/w/mem/handoff/requests/r1/proposals');
    expect(sentBody()).toEqual({ instanceId: 'claude', op: 'add', kind: 'note', text: 'a note' });
  });

  it('proposes an update with the version read, and a close with a reason', async () => {
    mockFetchResponse({ ok: true, proposal: { id: 'p2', state: 'proposed' } }, 201);
    expect(await run('propose', 'update', 'item-1', ...target, '--base-version', '3', '--text', 'new')).toBe(0);
    expect(sentBody()).toEqual({ instanceId: 'claude', op: 'update', itemId: 'item-1', baseVersion: 3, text: 'new' });
    restoreFetch();
    mockFetchResponse({ ok: true, proposal: { id: 'p3', state: 'proposed' } }, 201);
    expect(await run('propose', 'close', 'item-1', ...target, '--base-version', '4', '--reason', 'done with it')).toBe(0);
    expect(sentBody()).toEqual({ instanceId: 'claude', op: 'close', itemId: 'item-1', baseVersion: 4, reason: 'done with it' });
  });

  it('an update without a whole-number --base-version is 2 and sends nothing', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await run('propose', 'update', 'item-1', ...target, '--base-version', 'x', '--text', 'new')).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an ordinary shell names its target (2) and sends nothing', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await run('done', '--request', 'r1')).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toContain('target_required');
  });

  it.each([
    ['not_requested', 409, 55],
    ['request_closed', 409, 55],
    ['session_changed', 409, 55],
    ['state_forbids', 409, 55],
    ['not_found', 404, 52],
    ['disabled', 409, 50],
    ['version_conflict', 409, 51],
    ['item_not_found', 404, 52],
    ['invalid_close_when', 400, 2],
  ] as const)('maps %s to its exit code', async (code, status, exit) => {
    mockFetchResponse({ ok: false, code, message: 'x' }, status);
    expect(await run('done', ...target)).toBe(exit);
    expect(handoffExitCode(code)).toBe(exit);
  });
});
