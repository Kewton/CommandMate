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

import * as fs from 'fs';
import * as path from 'path';
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

/**
 * The markdown surfaces (Issue #1638, second pass).
 *
 * The embedded guide above is a TypeScript constant, so it was already covered.
 * The prose docs were not, and that is exactly where the drift happened: the
 * first pass fixed the Japanese guide and left the English one teaching only
 * `--agent`, with no test to notice. These guards read the files off disk so a
 * regression in any locale — or in a locale added later — turns red.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Locale-agnostic discovery: docs/user-guide/*.md and docs/<locale>/user-guide/*.md. */
function findUserGuides(): string[] {
  const docsDir = path.join(REPO_ROOT, 'docs');
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 2) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (entry.name.endsWith('.md') && path.basename(dir) === 'user-guide') {
        found.push(path.relative(REPO_ROOT, full));
      }
    }
  };
  visit(docsDir, 0);
  return found.sort();
}

/**
 * Shell example lines (`commandmate ...` / `commandmatedev ...`), reduced to the
 * command itself.
 *
 * Quoted arguments are blanked before the trailing `#` comment is cut, because
 * message arguments legitimately contain a `#` (`"Implement #102" --auto-yes`)
 * and a naive cut would hide every flag after it. The remaining text still
 * carries all flags — none of them live inside quotes.
 */
function exampleLines(text: string): string[] {
  return text
    .split('\n')
    .filter(line => /^\s*commandmate(dev)?\s/.test(line))
    .map(line => {
      const unquoted = line.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
      const comment = unquoted.indexOf('#');
      return comment === -1 ? unquoted : unquoted.slice(0, comment);
    })
    .map(line => line.trimEnd())
    .filter(line => line.length > 0);
}

describe('user-facing markdown teaches the --instance form (Issue #1638)', () => {
  const guides = findUserGuides();
  const withClaudeMd = [...guides, 'CLAUDE.md'];

  it('actually discovered the guides (a silent empty sweep proves nothing)', () => {
    expect(guides.length).toBeGreaterThan(10);
    expect(guides).toContain('docs/user-guide/cli-operations-guide.md');
    expect(guides).toContain('docs/en/user-guide/cli-operations-guide.md');
  });

  it.each(withClaudeMd)('%s shows no `wait --agent` example', (relPath) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8');
    const offenders = exampleLines(text)
      .filter(line => /\bwait\b/.test(line) && line.includes('--agent'));
    // `wait --agent` exits 1 with `unknown option`: an example using it is not
    // merely off-style, it is a command that cannot run.
    expect(offenders, `wait --agent in ${relPath}`).toEqual([]);
  });

  /**
   * `--agent` survives in exactly two example shapes:
   *   - `instances ... add --agent <tool>`, where it declares a new roster row
   *   - `send ... --register`, where an unregistered id carries no tool
   * Anything else is the demoted form the Issue set out to retire, so
   * re-introducing `send --agent codex` in any locale turns this red.
   */
  it.each(withClaudeMd)('%s uses --agent only for `instances add` or --register', (relPath) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8');
    const offenders = exampleLines(text)
      .filter(line => line.includes('--agent'))
      .filter(line => !line.includes('--register'))
      .filter(line => !/\binstances\b.*\badd\b/.test(line));
    expect(offenders, `unexpected --agent example in ${relPath}`).toEqual([]);
  });

  const CLI_GUIDES = guides.filter(p => p.endsWith('user-guide/cli-operations-guide.md'));

  it('every locale ships a cli-operations-guide (parity, not just the ja one)', () => {
    expect(CLI_GUIDES.length).toBeGreaterThanOrEqual(2);
  });

  it.each(CLI_GUIDES)('%s states the recommendation and the wait asymmetry', (relPath) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8');

    // The decision has to be findable from the doc, not only from git log.
    expect(text, `${relPath} does not cite the Issue`).toContain('#1638');
    // The symptom: `wait` is the one command with no --agent.
    expect(text, `${relPath} does not say wait has no --agent`).toMatch(/wait[^\n]*--agent/);
    // And it must show the working form, not just describe it.
    expect(exampleLines(text).filter(l => /\bwait\b/.test(l) && l.includes('--instance')))
      .not.toEqual([]);
  });
});
