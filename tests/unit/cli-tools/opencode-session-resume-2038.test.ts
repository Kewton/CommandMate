/**
 * `opencode -s <id>` on the launch path, and the promise that no other tool's
 * launch line moved (Issue #2038).
 *
 * Three acceptance conditions are pinned here.
 *
 *  1. **A relaunch continues the conversation.** opencode is the one supported
 *     agent whose session is addressable from the command line (`-s` / `-c` /
 *     `--fork`, measured on 1.18.22), and until this Issue a `kill-session`
 *     followed by a `send` came back on the home screen.
 *  2. **A session recorded for another worktree is not used.** Sessions belong
 *     to opencode's own database rather than to a server — measured, a server
 *     started in directory A lists directory B's sessions — so the recorded
 *     `Session.directory` is checked before the flag is composed.
 *  3. **claude / codex launch arguments are unchanged.** The resume flag is
 *     appended inside `OpenCodeTool.launchSession` and nowhere else, which is
 *     asserted twice: once behaviourally (the rendered launch line for the other
 *     tools is byte-identical with a fully populated store) and once
 *     structurally (no other launcher imports the helper that composes it).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { buildOpencodeComposerFrame } from '@tests/fixtures/opencode-launch-boot-11821';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  capturePane: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  killSession: vi.fn(),
  exactTarget: (name: string) => `=${name}`,
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/cli-tools/opencode-config', () => ({
  ensureOpencodeConfig: vi.fn(),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({ exec: vi.fn(), execFile: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: () => vi.fn().mockResolvedValue(undefined) };
});

vi.mock('@/lib/hooks/sources/opencode/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/runtime')>();
  return {
    ...actual,
    reserveOpencodeServerPort: vi.fn().mockResolvedValue(null),
    attachOpencodeEventStream: vi.fn().mockResolvedValue(false),
    resumeOpencodeEventStream: vi.fn().mockResolvedValue(false),
    releaseOpencodeEventStream: vi.fn().mockResolvedValue(undefined),
  };
});

import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { capturePane, hasSession, sendKeys } from '@/lib/tmux/tmux';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { buildAgentLaunchCommandLine } from '@/lib/session/agent-session-lifecycle';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  rememberOpencodeSession,
  resetOpencodeSessionMemories,
} from '@/lib/session/opencode-session-store';

const WORKTREE_ID = 'wt-resume-2038';
const SESSION_ID = 'ses_fc9802f88ffeZzlE5mU5cYYEFs';
const target: AgentInstanceRef = { worktreeId: WORKTREE_ID, cliToolId: 'opencode' };

/** Tools whose launch arguments this Issue promises not to touch. */
const UNTOUCHED_TOOLS: readonly CLIToolType[] = ['claude', 'codex', 'gemini', 'copilot'];

let sandbox: string;
let worktreePath: string;
const MANAGED_ENV = [
  'CM_OPENCODE_SESSION_FILE',
  'CM_OPENCODE_PORT_FILE',
  'CM_AGENT_HOOKS_DIR',
  'CODEX_HOME',
] as const;
const savedEnv: Record<string, string | undefined> = {};

/** The command line `sendKeys` was asked to type into the pane. */
function typedLaunchCommand(): string {
  const call = vi.mocked(sendKeys).mock.calls[0];
  return String(call?.[1] ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  sandbox = makeTempDir('opencode-resume-2038-');
  worktreePath = join(sandbox, 'worktree');
  for (const key of MANAGED_ENV) savedEnv[key] = process.env[key];
  process.env.CM_OPENCODE_SESSION_FILE = join(sandbox, 'opencode-sessions.json');
  process.env.CM_OPENCODE_PORT_FILE = join(sandbox, 'opencode-ports.json');
  process.env.CM_AGENT_HOOKS_DIR = join(sandbox, 'hooks');
  process.env.CODEX_HOME = join(sandbox, 'codex-home');
  resetOpencodePortAssignments();
  resetOpencodeSessionMemories();

  vi.mocked(hasSession).mockResolvedValue(false);
  vi.mocked(capturePane).mockResolvedValue(buildOpencodeComposerFrame());
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetOpencodePortAssignments();
  resetOpencodeSessionMemories();
  removeTempDir(sandbox);
});

describe('OpenCodeTool launch: resuming the last session', () => {
  it('ACCEPTANCE: appends -s <id> when the remembered session belongs here', async () => {
    rememberOpencodeSession(target, { sessionId: SESSION_ID, worktreePath });

    await new OpenCodeTool().startSession(WORKTREE_ID, worktreePath);

    expect(typedLaunchCommand()).toBe(`opencode -s ${SESSION_ID}`);
  });

  it('ACCEPTANCE: does NOT resume a session recorded for a different worktree', async () => {
    rememberOpencodeSession(target, {
      sessionId: SESSION_ID,
      worktreePath: join(sandbox, 'some-other-worktree'),
    });

    await new OpenCodeTool().startSession(WORKTREE_ID, worktreePath);

    const command = typedLaunchCommand();
    expect(command).toBe('opencode');
    expect(command).not.toContain(SESSION_ID);
    expect(command).not.toContain(' -s ');
  });

  it('launches bare when nothing has ever been recorded', async () => {
    await new OpenCodeTool().startSession(WORKTREE_ID, worktreePath);
    expect(typedLaunchCommand()).toBe('opencode');
  });

  it('keeps the resume flag beside the --port flag #1763 added', async () => {
    rememberOpencodePort(target, 4242, worktreePath);
    rememberOpencodeSession(target, { sessionId: SESSION_ID, worktreePath });

    await new OpenCodeTool().startSession(WORKTREE_ID, worktreePath);

    // `prepareOpencodeLaunch` shell-quotes the executable when it passes flags;
    // the resume flag is appended after that, untouched.
    expect(typedLaunchCommand()).toBe(
      `'opencode' --port 4242 --hostname 127.0.0.1 -s ${SESSION_ID}`
    );
  });

  it('resumes per instance, so a second pane does not adopt the first conversation', async () => {
    const second: AgentInstanceRef = {
      worktreeId: WORKTREE_ID,
      cliToolId: 'opencode',
      instanceId: 'opencode-2',
    };
    rememberOpencodeSession(target, { sessionId: SESSION_ID, worktreePath });

    await new OpenCodeTool().startSession(WORKTREE_ID, worktreePath, 'opencode-2');
    expect(typedLaunchCommand()).toBe('opencode');

    vi.mocked(sendKeys).mockClear();
    rememberOpencodeSession(second, {
      sessionId: 'ses_second0000000000000000',
      worktreePath,
    });
    await new OpenCodeTool().startSession(WORKTREE_ID, worktreePath, 'opencode-2');
    expect(typedLaunchCommand()).toBe('opencode -s ses_second0000000000000000');
  });

  it('does not type a launch command at all on the reuse path', async () => {
    rememberOpencodeSession(target, { sessionId: SESSION_ID, worktreePath });
    vi.mocked(hasSession).mockResolvedValue(true);

    await new OpenCodeTool().startSession(WORKTREE_ID, worktreePath);

    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
  });
});

describe('ACCEPTANCE: claude / codex launch arguments are unchanged', () => {
  it('renders the same launch line whether or not a session is remembered', () => {
    const before = new Map<CLIToolType, string>();
    for (const cliToolId of UNTOUCHED_TOOLS) {
      before.set(
        cliToolId,
        buildAgentLaunchCommandLine({
          target: { worktreeId: WORKTREE_ID, cliToolId },
          executablePath: cliToolId,
          worktreePath,
        })
      );
    }

    // Populate the store for every tool, not only opencode: even an entry that
    // should never have been written must not reach another tool's launcher.
    for (const cliToolId of [...UNTOUCHED_TOOLS, 'opencode' as CLIToolType]) {
      rememberOpencodeSession(
        { worktreeId: WORKTREE_ID, cliToolId },
        { sessionId: SESSION_ID, worktreePath }
      );
    }

    for (const cliToolId of UNTOUCHED_TOOLS) {
      const after = buildAgentLaunchCommandLine({
        target: { worktreeId: WORKTREE_ID, cliToolId },
        executablePath: cliToolId,
        worktreePath,
      });
      expect(after).toBe(before.get(cliToolId));
      expect(after).not.toContain(` -s ${SESSION_ID}`);
    }
  });

  it('no launcher other than opencode composes the resume flag', () => {
    const dir = join(process.cwd(), 'src/lib/cli-tools');
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && name !== 'opencode.ts')
      .filter((name) => {
        const source = readFileSync(join(dir, name), 'utf8');
        return (
          source.includes('withOpencodeResumedSession') ||
          source.includes('recoverOpencodeSessionId')
        );
      });

    expect(offenders).toEqual([]);
  });
});
