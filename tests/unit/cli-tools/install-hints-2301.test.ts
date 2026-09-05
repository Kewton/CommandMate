/**
 * A refusal to start says how to fix itself, for every tool (Issue #2301).
 *
 * #2009 made all eight tools refuse a start when the binary is missing, and
 * made the refusal a typed error. What it did not make uniform was the
 * SENTENCE. Seven tools said some spelling of `<tool> is not installed or not
 * in PATH` and stopped; only copilot went on to name the installer (#1907). So
 * the operator who picked opencode or Command Code from the agent list — the
 * two this Issue is about — was told what was wrong and nothing about what to
 * do, while the operator who picked copilot was told both.
 *
 * ## What is driven
 *
 * The eight real tools, through their real `startSession()`, against a PATH
 * where nothing can be exec'd — the shape
 * `tests/unit/push/session-start-failure-all-tools-2009.test.ts` established.
 * Nothing here asserts "a function was called": what is read is the message a
 * 503 body and a `commandmate send` would carry.
 *
 * Two traps this file is deliberately built against:
 *
 * 1. **A table that agrees with itself.** Asserting the message contains
 *    `CLI_TOOL_INSTALL_HINTS[id]` would pass for a table of eight empty
 *    strings, and pass again if every tool shared one hint. So the hints are
 *    separately asserted to be non-empty, mutually distinct, and — for the
 *    ones with a package name — to name the package that actually resolves.
 * 2. **A suite that covers seven of eight.** The tool list is pinned against
 *    `CLI_TOOL_IDS`, so a ninth agent cannot land with no hint and a green run.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Nothing may reach a real tmux server, and a refusal must happen before any of
// this is touched — these are also the witnesses for "refused before creating".
const createSession = vi.fn();
const sendKeys = vi.fn();
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: (...args: unknown[]) => createSession(...args),
  sendKeys: (...args: unknown[]) => sendKeys(...args),
  capturePane: vi.fn().mockResolvedValue(''),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  setSessionEnvironment: vi.fn(),
}));

/**
 * An empty PATH, in every shape the eight tools ask the question in.
 *
 * `exec` is `which <cmd>` (`BaseCLITool.isInstalled` and claude's own
 * `isClaudeInstalled`); `execFile` is what `resolveCopilotExecutable` uses —
 * copilot is the one tool that demands positive evidence rather than trusting
 * `which` (#1907).
 */
vi.mock('child_process', () => {
  const fail = (...args: unknown[]) => {
    const callback = args.find((a) => typeof a === 'function') as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    queueMicrotask(() => callback?.(new Error('command not found'), '', ''));
    return {};
  };
  return { exec: vi.fn(fail), execFile: vi.fn(fail), spawn: vi.fn(fail) };
});

// The notification is #2009's business and is fire-and-forget; stubbing it keeps
// the database and web-push out of a suite that only reads a message.
vi.mock('@/lib/push/failure-push-notifier', () => ({
  notifySessionStartFailurePush: vi.fn().mockResolvedValue(undefined),
}));

import { ClaudeTool } from '@/lib/cli-tools/claude';
import { CodexTool } from '@/lib/cli-tools/codex';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { CommandCodeTool } from '@/lib/cli-tools/command-code';
import type { ICLITool } from '@/lib/cli-tools/types';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import {
  CLI_TOOL_INSTALL_HINTS,
  buildMissingToolMessage,
  getCliToolInstallHint,
  missingToolError,
} from '@/lib/cli-tools/install-hints';
import { assertToolStartable } from '@/lib/cli-tools/start-availability';
import { isSessionStartUnavailableError } from '@/lib/session/session-start-error';
import { clearCachedClaudePath } from '@/lib/session/claude-session';
import { getOptionalDependencies } from '@/cli/config/cli-dependencies';

const WT = 'wt-2301';
const WT_PATH = '/tmp/wt-2301';

const TOOLS: ReadonlyArray<() => ICLITool> = [
  () => new ClaudeTool(),
  () => new CodexTool(),
  () => new GeminiTool(),
  () => new VibeLocalTool(),
  () => new OpenCodeTool(),
  () => new CopilotTool(),
  () => new AntigravityTool(),
  () => new CommandCodeTool(),
];

/** The rejection message from a start that cannot happen. */
async function refusalMessage(tool: ICLITool): Promise<string> {
  const caught = await tool.startSession(WT, WT_PATH).then(
    () => null,
    (error: unknown) => error
  );
  expect(isSessionStartUnavailableError(caught)).toBe(true);
  return (caught as Error).message;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCachedClaudePath();
});

describe('Issue #2301: the hint table', () => {
  it('carries an entry for every id CLI_TOOL_IDS knows about', () => {
    expect(Object.keys(CLI_TOOL_INSTALL_HINTS).sort()).toEqual([...CLI_TOOL_IDS].sort());
  });

  it('says something, and something different, for each tool', () => {
    const hints = [...CLI_TOOL_IDS].map((id) => getCliToolInstallHint(id));
    for (const hint of hints) expect(hint.trim().length).toBeGreaterThan(20);
    // A table of eight copies of one sentence would satisfy every other
    // assertion in this file.
    expect(new Set(hints).size).toBe(hints.length);
  });

  it('names the package that actually resolves, per tool', () => {
    // Measured against the npm registry on 2026-09-05. `@anthropic-ai/claude-cli`
    // — still the spelling in `PreflightChecker.getInstallHint` — 404s; the one
    // below is the package that exists.
    expect(CLI_TOOL_INSTALL_HINTS.claude).toContain('@anthropic-ai/claude-code');
    expect(CLI_TOOL_INSTALL_HINTS.codex).toContain('@openai/codex');
    expect(CLI_TOOL_INSTALL_HINTS.gemini).toContain('@google/gemini-cli');
    expect(CLI_TOOL_INSTALL_HINTS.opencode).toContain('opencode-ai');
    expect(CLI_TOOL_INSTALL_HINTS['command-code']).toContain('command-code');
    // Copilot keeps #1907's wording, which is also why the retired extension
    // must not come back.
    expect(CLI_TOOL_INSTALL_HINTS.copilot).toMatch(/brew install copilot-cli|@github\/copilot/);
    expect(CLI_TOOL_INSTALL_HINTS.copilot).not.toContain('gh extension install');
    // agy has no package; the URL is a string in the shipped binary.
    expect(CLI_TOOL_INSTALL_HINTS.antigravity).toContain('https://antigravity.google/docs/cli');
    // vibe-local has no artifact to install, so it must not pretend otherwise.
    expect(CLI_TOOL_INSTALL_HINTS['vibe-local']).not.toContain('npm install');
  });
});

describe('Issue #2301: buildMissingToolMessage', () => {
  it('names the tool, the binary and the remedy in one sentence', () => {
    const message = buildMissingToolMessage({
      id: 'command-code',
      name: 'Command Code CLI',
      command: 'commandcode',
    });

    // The display name and the binary are different words for six of the eight
    // tools, and the reader needs both: one to recognise what they picked, the
    // other to type.
    expect(message).toContain('Command Code CLI');
    expect(message).toContain('commandcode');
    expect(message).toContain(CLI_TOOL_INSTALL_HINTS['command-code']);
  });

  it('keeps the phrase #2009 downstream readers match on', () => {
    for (const tool of TOOLS.map((make) => make())) {
      expect(buildMissingToolMessage(tool)).toContain('is not installed');
    }
  });

  it('produces the typed error, not a bare Error', () => {
    const error = missingToolError(new CodexTool());
    expect(isSessionStartUnavailableError(error)).toBe(true);
    expect(error.toolName).toBe('Codex CLI');
  });
});

/**
 * The seven tools whose `launchSession` composes its own refusal.
 *
 * claude is not among them: it delegates to `lib/session/claude-session`, which
 * both detects the missing binary and writes the sentence (#1637), and that
 * module — plus the integration test that pins its wording verbatim — is outside
 * what this change was allowed to touch. Its own case is below.
 */
const SELF_REFUSING_TOOLS = TOOLS.filter((make) => make().id !== 'claude');

describe('Issue #2301: every tool refuses with its own remedy', () => {
  it.each(SELF_REFUSING_TOOLS.map((make) => [make().id, make] as const))(
    '%s tells the operator how to install it',
    async (id, make) => {
      const tool = make();

      const message = await refusalMessage(tool);

      expect(message).toContain(tool.name);
      expect(message).toContain(tool.command);
      expect(message).toContain('is not installed');
      expect(message).toContain(CLI_TOOL_INSTALL_HINTS[id]);

      // The gate still refuses before anything is created (#2009).
      expect(createSession).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    }
  );

  it('covers every tool CLI_TOOL_IDS knows about', () => {
    // The table above skips exactly one id, and this is what keeps that skip
    // honest: a ninth agent lands in TOOLS or this goes red.
    expect(TOOLS.map((make) => make().id).sort()).toEqual([...CLI_TOOL_IDS].sort());
    expect(SELF_REFUSING_TOOLS).toHaveLength(TOOLS.length - 1);
  });

  it('reaches claude through the start gate, which is the path in scope', async () => {
    // `assertToolStartable` is what Assistant Chat asks before it spawns
    // `claude -p` (#2022), and since this change it builds the same sentence the
    // other seven throw.
    const tool = new ClaudeTool();
    const caught = await assertToolStartable(tool, { worktreeId: WT }).then(
      () => null,
      (error: unknown) => error
    );

    expect(isSessionStartUnavailableError(caught)).toBe(true);
    expect((caught as Error).message).toContain(CLI_TOOL_INSTALL_HINTS.claude);
  });

  it('still refuses a claude start, with #1637 wording it does not own', async () => {
    // Documented, not endorsed: the sentence is composed in
    // `lib/session/claude-session`. The refusal is still typed, so nothing
    // downstream regressed — only the remedy is missing, and only here.
    const message = await refusalMessage(new ClaudeTool());

    expect(message).toContain('is not installed');
    expect(message).not.toContain(CLI_TOOL_INSTALL_HINTS.claude);
  });

  it('gives opencode and Command Code the treatment copilot already had', async () => {
    // The Issue's own acceptance sentence, read back off the wire: before this
    // change these two said "is not installed or not in PATH" and stopped.
    const opencode = await refusalMessage(new OpenCodeTool());
    const commandCode = await refusalMessage(new CommandCodeTool());
    const copilot = await refusalMessage(new CopilotTool());

    expect(opencode).toContain('npm install -g opencode-ai');
    expect(commandCode).toContain('npm install -g command-code');
    expect(copilot).toMatch(/brew install copilot-cli|@github\/copilot/);
  });
});

describe('Issue #2301: init checks the binary the tool actually launches', () => {
  /**
   * `commandmate init` rows, paired with the tool that owns the binary.
   *
   * This is the Issue's named trap: the package is `command-code`, the class is
   * `CommandCodeTool`, the id is `command-code` — and the executable is
   * `commandcode`, chosen in Epic #2249 決定 1 because `cmd` collides with
   * Windows' shell. A dependency row that spelled any of the other three would
   * report "Not found" on a machine where the tool is installed and working,
   * which is worse than the silence it replaced.
   *
   * `vibe-local` is absent from the pairs because it is absent from the rows —
   * asserted separately below, so its absence is a decision rather than an
   * oversight.
   */
  const ROWS: ReadonlyArray<{ row: string; tool: () => ICLITool }> = [
    { row: 'Claude CLI', tool: () => new ClaudeTool() },
    { row: 'Codex CLI', tool: () => new CodexTool() },
    { row: 'GitHub Copilot CLI', tool: () => new CopilotTool() },
    { row: 'OpenCode CLI', tool: () => new OpenCodeTool() },
    { row: 'Gemini CLI', tool: () => new GeminiTool() },
    { row: 'Antigravity CLI', tool: () => new AntigravityTool() },
    { row: 'Command Code CLI', tool: () => new CommandCodeTool() },
  ];

  it.each(ROWS.map(({ row, tool }) => [row, tool] as const))(
    '%s probes the executable its tool launches',
    (row, make) => {
      const dependency = getOptionalDependencies().find((d) => d.name === row);

      expect(dependency).toBeDefined();
      expect(dependency?.command).toBe(make().command);
    }
  );

  it('leaves out vibe-local, which has no version to ask for', () => {
    // Measured 2026-09-05: `vibe-local --version` does not print a version — it
    // ignores the flag and opens its interactive permission prompt. A row for it
    // would make `init` hang a terminal on a dialog nobody asked for.
    const commands = getOptionalDependencies().map((d) => d.command);
    expect(commands).not.toContain(new VibeLocalTool().command);
  });
});
