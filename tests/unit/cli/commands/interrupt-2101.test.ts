/**
 * `commandmate interrupt` — the CLI face of POST /api/worktrees/:id/interrupt
 * (Issue #2101).
 *
 * Epic #2055's acceptance condition 1 counted the interrupt path as unmet on the
 * CLI side only: the Web route was measured end to end on 2026-08-26 (opencode
 * `sessionStatus=running / isGenerating=true` -> 200 ->
 * `opencode-interrupt-aborted-via-api` -> `ready / false`), and no subcommand
 * reached it. `stop` stops the CommandMate server.
 *
 * What this file pins, and why each of these could break silently:
 *
 * 1. **The 404 fork.** The route answers 404 for BOTH "no session was running"
 *    and "no such worktree", with no machine code to tell them apart. The
 *    generic mapping in `handleApiError` turns every 404 into
 *    ExitCode.UNEXPECTED_ERROR (99), so without the message match an
 *    orchestration cannot distinguish "already idle, carry on" from "your id is
 *    wrong, stop". Both halves of the fork are asserted, and the message the
 *    fork keys on is asserted against the ROUTE'S OWN SOURCE — a rename there
 *    is otherwise invisible to every test in this repo.
 * 2. **The additive JSON contract.** `interrupted[]` must be present in both
 *    outcomes, because a caller reads its length.
 * 3. **Same-PR docs.** Epic #2055 requires the CLI JSON contract and the
 *    published guide to move together; PR #2102 existed only because three
 *    commits' worth of guide drift had accumulated. The guide and the embedded
 *    `commandmate docs` guide are asserted here rather than left to review.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, mockFetchError, restoreFetch } from '../../../helpers/mock-api';
import { ExitCode, InterruptExitCode, WaitExitCode, VerifyExitCode, SkillExitCode } from '../../../../src/cli/types';
import { INTERRUPT_INSTANCE_OPTION_DESCRIPTION } from '../../../../src/cli/config/agent-target-options';
import { AGENT_OPERATIONS_GUIDE } from '../../../../src/cli/docs/agent-operations';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The 200 body the live UAT recorded on 2026-08-26, verbatim. */
const LIVE_INTERRUPT_RESPONSE = {
  success: true,
  message: 'Interrupt sent to 1 session(s)',
  interrupted: [
    { cliToolId: 'opencode', instanceId: 'opencode', sessionName: 'mcbd-opencode-uat2055oc' },
  ],
};

async function loadCommand() {
  const { createInterruptCommand } = await import('../../../../src/cli/commands/interrupt');
  return createInterruptCommand();
}

function fetchCalls(): Array<[string, { method?: string; body?: string }]> {
  const mock = global.fetch as ReturnType<typeof vi.fn> | undefined;
  return (mock?.mock.calls ?? []) as Array<[string, { method?: string; body?: string }]>;
}

function interruptCall(): [string, { method?: string; body?: string }] | undefined {
  return fetchCalls().find((call) => String(call[0]).includes('/interrupt'));
}

function stderrText(): string {
  return mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');
}

function stdoutText(): string {
  return mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('createInterruptCommand', () => {
  it('is registered under the name `interrupt`', async () => {
    expect((await loadCommand()).name()).toBe('interrupt');
  });

  it('takes --instance but no --agent (the `wait` precedent, Issue #1629)', async () => {
    const flags = (await loadCommand()).options.map((o) => o.long);
    expect(flags).toContain('--instance');
    expect(flags).toContain('--json');
    expect(flags).not.toContain('--agent');
  });

  it('rejects --agent rather than silently ignoring it', async () => {
    const cmd = (await loadCommand()).exitOverride();
    await expect(
      cmd.parseAsync(['node', 'interrupt', 'wt1', '--agent', 'codex'])
    ).rejects.toThrow(/unknown option/i);
  });

  it('says on --instance that omitting it interrupts every running session', async () => {
    // The default is a broadcast, not "the primary instance". Someone reading
    // only the help must not learn the wrong default.
    expect(INTERRUPT_INSTANCE_OPTION_DESCRIPTION).toContain('every running session');
    expect(INTERRUPT_INSTANCE_OPTION_DESCRIPTION).toContain('takes no --agent');
    expect((await loadCommand()).helpInformation().replace(/\s+/g, ' '))
      .toContain(INTERRUPT_INSTANCE_OPTION_DESCRIPTION.replace(/\s+/g, ' '));
  });
});

describe('interrupt: the request', () => {
  it('POSTs to /api/worktrees/<id>/interrupt with an empty body', async () => {
    mockFetchResponse(LIVE_INTERRUPT_RESPONSE);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1']);

    const call = interruptCall();
    expect(String(call?.[0])).toContain('/api/worktrees/wt1/interrupt');
    expect(call?.[1].method).toBe('POST');
    expect(JSON.parse(call?.[1].body ?? '{}')).toEqual({});
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('puts --instance on the wire as instanceId', async () => {
    mockFetchResponse(LIVE_INTERRUPT_RESPONSE);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1', '--instance', 'codex-2']);

    expect(JSON.parse(interruptCall()?.[1].body ?? '{}')).toEqual({ instanceId: 'codex-2' });
  });

  it('sends no cliToolId: the route resolves the tool from the roster itself', async () => {
    // `respond` had to pre-resolve (#1629) because /prompt-response falls back
    // to the worktree default. This route does not, so an extra GET here would
    // be a request that buys nothing.
    mockFetchResponse(LIVE_INTERRUPT_RESPONSE);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1', '--instance', 'codex-2']);

    expect(JSON.parse(interruptCall()?.[1].body ?? '{}')).not.toHaveProperty('cliToolId');
    expect(fetchCalls().filter((c) => !String(c[0]).includes('/api/capabilities'))).toHaveLength(1);
  });
});

describe('interrupt: success output', () => {
  it('prints the server message and one line per interrupted session', async () => {
    mockFetchResponse(LIVE_INTERRUPT_RESPONSE);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1']);

    expect(mockConsoleLog).toHaveBeenCalledWith('Interrupt sent to 1 session(s)');
    expect(stdoutText()).toContain('opencode');
    expect(stdoutText()).toContain('mcbd-opencode-uat2055oc');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('--json passes the API response through verbatim, interrupted[] included', async () => {
    mockFetchResponse(LIVE_INTERRUPT_RESPONSE);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1', '--json']);

    const parsed = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(parsed).toEqual(LIVE_INTERRUPT_RESPONSE);
    expect(parsed.interrupted).toHaveLength(1);
  });

  it('--json survives an additive field the route grows later', async () => {
    // The additive rule Epic #2055 imposes cuts both ways: a new server field
    // must reach the caller without a code change here.
    mockFetchResponse({ ...LIVE_INTERRUPT_RESPONSE, abortedVia: 'opencode-server' });
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1', '--json']);

    expect(JSON.parse(mockConsoleLog.mock.calls[0][0]).abortedVia).toBe('opencode-server');
  });

  it('exits 0 (InterruptExitCode.SUCCESS) when a session was interrupted', async () => {
    mockFetchResponse(LIVE_INTERRUPT_RESPONSE);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1']);

    expect(mockExit).not.toHaveBeenCalled();
    expect(InterruptExitCode.SUCCESS).toBe(0);
  });
});

describe('interrupt: no active session (the defined non-zero outcome)', () => {
  it('exits 30 with a stderr line naming the worktree', async () => {
    mockFetchResponse({ error: 'No active sessions found' }, 404);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(InterruptExitCode.NO_ACTIVE_SESSIONS);
    expect(mockExit).toHaveBeenCalledWith(30);
    expect(stderrText()).toContain('No active sessions found');
    expect(stderrText()).toContain("worktree 'wt1'");
    expect(stderrText()).toContain('Nothing was interrupted.');
  });

  it('names the instance too when one was targeted', async () => {
    mockFetchResponse({ error: 'No active sessions found' }, 404);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1', '--instance', 'codex-2']);

    expect(stderrText()).toContain("instance 'codex-2'");
    expect(mockExit).toHaveBeenCalledWith(InterruptExitCode.NO_ACTIVE_SESSIONS);
  });

  it('--json still emits an interrupted[] — empty, not absent', async () => {
    mockFetchResponse({ error: 'No active sessions found' }, 404);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1', '--json']);

    const parsed = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(parsed).toEqual({ success: false, message: 'No active sessions found', interrupted: [] });
    expect(Array.isArray(parsed.interrupted)).toBe(true);
    expect(mockExit).toHaveBeenCalledWith(InterruptExitCode.NO_ACTIVE_SESSIONS);
  });

  it('prints nothing on stdout without --json', async () => {
    mockFetchResponse({ error: 'No active sessions found' }, 404);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1']);

    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it('the matched message is the one the route actually sends', async () => {
    // Nothing else in the repo would catch a rename on the server side: the
    // route has no machine code, and the CLI would quietly fall back to 99.
    const route = fs.readFileSync(
      path.join(REPO_ROOT, 'src/app/api/worktrees/[id]/interrupt/route.ts'),
      'utf8'
    );
    expect(route).toContain("{ error: 'No active sessions found' }");
  });
});

describe('interrupt: the other failures keep their existing codes', () => {
  it('a 404 for a missing worktree stays UNEXPECTED_ERROR, not 30', async () => {
    mockFetchResponse({ error: "Worktree 'nope' not found" }, 404);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'nope']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    expect(mockExit).not.toHaveBeenCalledWith(InterruptExitCode.NO_ACTIVE_SESSIONS);
    expect(stderrText()).toContain('Resource not found');
  });

  it('passes the 400 wording through for an unresolvable instance', async () => {
    mockFetchResponse(
      { error: 'Could not resolve CLI tool for the specified instance. Provide cliToolId.' },
      400
    );
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1', '--instance', 'ghost-9']);

    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: Could not resolve CLI tool for the specified instance. Provide cliToolId.'
    );
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
  });

  it('exits DEPENDENCY_ERROR when the server is not running', async () => {
    mockFetchError('fetch failed');
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1']);

    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: Server is not running. Start it with: commandmate start'
    );
    expect(mockExit).toHaveBeenCalledWith(ExitCode.DEPENDENCY_ERROR);
  });

  it('surfaces the server reason on 500', async () => {
    mockFetchResponse({ error: 'Failed to send interrupt' }, 500);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1']);

    expect(mockConsoleError).toHaveBeenCalledWith('Error: Server error: Failed to send interrupt');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
  });

  it('rejects a malformed worktree id before issuing a request', async () => {
    mockFetchResponse(LIVE_INTERRUPT_RESPONSE);
    await (await loadCommand()).parseAsync(['node', 'interrupt', '../etc']);

    expect(mockConsoleError).toHaveBeenCalledWith('Error: Invalid worktree ID format.');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(interruptCall()).toBeUndefined();
  });

  it('rejects a malformed --instance before issuing a request', async () => {
    mockFetchResponse(LIVE_INTERRUPT_RESPONSE);
    await (await loadCommand()).parseAsync(['node', 'interrupt', 'wt1', '--instance', 'bad id!']);

    expect(stderrText()).toContain('Invalid --instance');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(interruptCall()).toBeUndefined();
  });
});

describe('InterruptExitCode does not collide with the other CLI exit-code namespaces', () => {
  it('30 is not spent by ExitCode / Wait / Verify / Skill', () => {
    const taken = new Set<number>([
      ...Object.values(ExitCode).filter((v): v is number => typeof v === 'number'),
      ...Object.values(WaitExitCode),
      ...Object.values(VerifyExitCode),
      ...Object.values(SkillExitCode),
    ]);
    // 0 is SUCCESS everywhere by design; the verdict code is what must be free.
    expect(taken.has(InterruptExitCode.NO_ACTIVE_SESSIONS)).toBe(false);
  });
});

describe('the docs move in the same commit (Epic #2055 cross-cutting condition)', () => {
  const guidePath = 'docs/user-guide/cli-operations-guide.md';

  function guide(): string {
    return fs.readFileSync(path.join(REPO_ROOT, guidePath), 'utf8');
  }

  it('the published guide documents the command, --instance, --json and exit 30', () => {
    const text = guide();
    expect(text).toContain('commandmate interrupt');
    expect(text).toContain('commandmate interrupt <worktree-id> --json');
    expect(text).toContain('commandmate interrupt <worktree-id> --instance');
    expect(text).toContain('NO_ACTIVE_SESSIONS');
    expect(text).toMatch(/\|\s*30\s*\|/);
  });

  it('the guide lists interrupt in the command table', () => {
    expect(guide()).toContain('[`commandmate interrupt`](#commandmate-interrupt)');
  });

  it('the embedded `commandmate docs` guide documents it too', () => {
    expect(AGENT_OPERATIONS_GUIDE).toContain('commandmate interrupt');
    expect(AGENT_OPERATIONS_GUIDE).toContain('30  NO_ACTIVE_SESSIONS');
  });

  it('the embedded guide never shows interrupt taking --agent', () => {
    const bad = AGENT_OPERATIONS_GUIDE.split('\n')
      .filter((line) => /commandmate interrupt\b/.test(line) && line.includes('--agent'));
    expect(bad).toEqual([]);
  });
});
