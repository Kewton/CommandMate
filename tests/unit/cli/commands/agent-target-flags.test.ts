/**
 * Agent target flags: `--instance` is the recommended form, `--agent` stays
 * (Issue #1638).
 *
 * The flags were asymmetric and nothing said so: `--agent` is accepted by
 * send / respond / capture / auto-yes but rejected by `wait` (`unknown option`,
 * exit 1). A workflow that names the agent on `send` and nothing on `wait`
 * therefore waited on the worktree's DEFAULT agent — a worktree cut for Codex
 * ran Claude in silence.
 *
 * The decision was to keep `--agent` and re-position it, not to remove it. So
 * this file pins BOTH halves:
 *   1. the wording that carries the recommendation (help text + embedded docs),
 *      because the wording IS the fix, and
 *   2. that `--agent` keeps working exactly as before on all four commands,
 *      because a doc-only change must not have moved any behaviour.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import {
  AGENT_OPTION_DESCRIPTION,
  INSTANCE_OPTION_DESCRIPTION,
  WAIT_INSTANCE_OPTION_DESCRIPTION,
} from '../../../../src/cli/config/agent-target-options';
import {
  AGENT_OPERATIONS_GUIDE,
  AGENT_OPERATIONS_SAMPLES,
} from '../../../../src/cli/docs/agent-operations';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

function bodyOf(call: [string, { body?: string }]): Record<string, unknown> {
  return JSON.parse(call[1].body ?? '{}');
}

/** The four commands that accept `--agent`. `wait` is deliberately absent. */
const AGENT_AWARE_COMMANDS = [
  { name: 'send', load: () => import('../../../../src/cli/commands/send').then(m => m.createSendCommand()) },
  { name: 'respond', load: () => import('../../../../src/cli/commands/respond').then(m => m.createRespondCommand()) },
  { name: 'capture', load: () => import('../../../../src/cli/commands/capture').then(m => m.createCaptureCommand()) },
  { name: 'auto-yes', load: () => import('../../../../src/cli/commands/auto-yes').then(m => m.createAutoYesCommand()) },
];

describe('help text positions --agent as the ad-hoc supplement (Issue #1638)', () => {
  it.each(AGENT_AWARE_COMMANDS)('$name spells out both flags from the shared source', async ({ load }) => {
    const help = (await load()).helpInformation();

    // helpInformation() wraps long descriptions, so compare on collapsed
    // whitespace rather than on the literal one-line constant.
    const flat = help.replace(/\s+/g, ' ');
    expect(flat).toContain(AGENT_OPTION_DESCRIPTION.replace(/\s+/g, ' '));
    expect(flat).toContain(INSTANCE_OPTION_DESCRIPTION.replace(/\s+/g, ' '));
  });

  it('the shared --agent wording demotes it and points at --instance', () => {
    expect(AGENT_OPTION_DESCRIPTION).toMatch(/ad-hoc/i);
    expect(AGENT_OPTION_DESCRIPTION).toMatch(/roster/i);
    expect(AGENT_OPTION_DESCRIPTION).toContain('--instance');
    expect(AGENT_OPTION_DESCRIPTION).toContain('wait has no --agent');
  });

  it('the shared --instance wording names it the recommended target flag', () => {
    expect(INSTANCE_OPTION_DESCRIPTION).toMatch(/recommended/i);
    expect(INSTANCE_OPTION_DESCRIPTION).toContain('send/wait/respond/capture/auto-yes');
  });

  it('every CLI tool id stays listed in the --agent help', async () => {
    const { CLI_TOOL_IDS } = await import('../../../../src/cli/config/cli-tool-ids');
    for (const id of CLI_TOOL_IDS) {
      expect(AGENT_OPTION_DESCRIPTION).toContain(id);
    }
  });

  it('wait has no --agent option and says so on --instance', async () => {
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();

    const flags = cmd.options.map(o => o.long);
    expect(flags).toContain('--instance');
    expect(flags).not.toContain('--agent');

    expect(WAIT_INSTANCE_OPTION_DESCRIPTION).toContain('wait takes no --agent');
    expect(cmd.helpInformation().replace(/\s+/g, ' '))
      .toContain(WAIT_INSTANCE_OPTION_DESCRIPTION.replace(/\s+/g, ' '));
  });

  it('wait still rejects --agent (the asymmetry is documented, not removed)', async () => {
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand().exitOverride();

    await expect(
      cmd.parseAsync(['node', 'wait', 'wt1', '--agent', 'codex'])
    ).rejects.toThrow(/unknown option/i);
  });
});

describe('--agent still behaves exactly as before (Issue #1638 changed no behaviour)', () => {
  it('send --agent still puts the tool on the wire', async () => {
    mockFetchSequence([{ data: { id: 1, role: 'user', content: 'hello' }, status: 201 }]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync(['node', 'send', 'wt1', 'hello', '--agent', 'codex']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const sendCall = calls.find(c => String(c[0]).includes('/send'));
    expect(bodyOf(sendCall as [string, { body?: string }]))
      .toEqual({ content: 'hello', cliToolId: 'codex' });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('respond --agent still puts the tool on the wire', async () => {
    mockFetchSequence([{ data: { success: true } }]);

    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    await createRespondCommand().parseAsync(['node', 'respond', 'wt1', 'yes', '--agent', 'codex']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.find(c => String(c[0]).includes('/prompt-response'));
    expect(bodyOf(call as [string, { body?: string }]))
      .toEqual({ answer: 'yes', cliTool: 'codex' });
  });

  it('capture --agent still scopes the query', async () => {
    mockFetchSequence([{ data: { content: 'pane', fullOutput: 'pane' } }]);

    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    await createCaptureCommand().parseAsync(['node', 'capture', 'wt1', '--agent', 'codex']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.find(c => String(c[0]).includes('/current-output'));
    expect(String(call?.[0])).toContain('cliTool=codex');
  });

  it('auto-yes --agent still puts the tool on the wire', async () => {
    mockFetchSequence([{ data: {}, status: 200 }]);

    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    await createAutoYesCommand().parseAsync(['node', 'auto-yes', 'wt1', '--enable', '--agent', 'codex']);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.find(c => String(c[0]).includes('/auto-yes'));
    expect(bodyOf(call as [string, { body?: string }])).toMatchObject({ cliToolId: 'codex' });
  });

  it('--register still requires --agent for a roster-less instance id', async () => {
    mockFetchSequence([]);

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    await createSendCommand().parseAsync([
      'node', 'send', 'wt1', 'hello', '--instance', 'codex-3', '--register',
    ]);

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('--register requires --agent'));
  });
});

describe('embedded `commandmate docs` guide recommends the --instance form (Issue #1638)', () => {
  const embedded = [
    { name: 'agent-operations', text: AGENT_OPERATIONS_GUIDE },
    { name: 'agent-operations-samples', text: AGENT_OPERATIONS_SAMPLES },
  ];

  /**
   * `--agent <tool> --instance <id>` on send/respond/capture/auto-yes is the
   * form the Issue set out to retire: with a rostered instance the --agent is
   * redundant, and it teaches a habit that breaks on `wait`. The one legitimate
   * survivor is --register, whose instance id is by definition not in the
   * roster yet.
   */
  it.each(embedded)('$name pairs --agent with --instance only for --register', ({ text }) => {
    const paired = text
      .split('\n')
      // Command examples only: prose is allowed to name both flags in one
      // sentence, which is exactly how the recommendation is stated.
      .filter(line => line.trim().startsWith('commandmate '))
      .filter(line => line.includes('--agent') && line.includes('--instance'));

    for (const line of paired) {
      expect(line, `unexpected --agent+--instance example: ${line.trim()}`).toContain('--register');
    }
  });

  it.each(embedded)('$name never shows wait taking --agent', ({ text }) => {
    const badWait = text
      .split('\n')
      .filter(line => /commandmate wait\b/.test(line) && line.includes('--agent'));
    expect(badWait).toEqual([]);
  });

  it('the guide states the recommendation and the reason --agent survives', () => {
    expect(AGENT_OPERATIONS_GUIDE).toContain('Issue #1638');
    expect(AGENT_OPERATIONS_GUIDE).toMatch(/--instance alone is the recommended way/i);
    // The rationale must be findable from `commandmate docs`, not just git log.
    expect(AGENT_OPERATIONS_GUIDE).toMatch(/--agent remains accepted/i);
    expect(AGENT_OPERATIONS_GUIDE).toMatch(/'wait'/);
  });

  it('the samples show a codex worktree being waited on by instance', () => {
    expect(AGENT_OPERATIONS_SAMPLES).toContain('commandmate wait "$WT2" --instance codex');
  });

  it('is reachable through the docs reader, not just as a constant', async () => {
    const { readSection, isValidSection } = await import('../../../../src/cli/utils/docs-reader');
    expect(isValidSection('agent-operations')).toBe(true);
    expect(readSection('agent-operations')).toContain('Issue #1638');
  });
});
