/**
 * Unit tests for CommandCodeTool (Issue #2250 Phase A, extended by #2251 Phase B).
 *
 * The four things the tool class owns: the launch line (rendered in ONE place,
 * which since #2251 is `buildAgentLaunchCommandLine` plus the flags), the
 * readiness rule that gates a send, the `/exit` shutdown, and the capture-cache
 * invalidation without which the poller answers a send from the previous frame.
 *
 * Most of this file runs with `CM_AGENT_HOOKS_INJECT=0`, so the assertions about
 * *when* a launch line is sent stay about relaunch behaviour rather than about
 * hooks — and so the byte-identical Phase A line is pinned as the rollback
 * target it is meant to be. The hooks-on path has its own block at the end,
 * against a real temporary worktree.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CommandCodeTool,
  buildCommandCodeLaunchCommand,
  isCommandCodeReady,
  COMMAND_CODE_COMMAND,
  COMMAND_CODE_LAUNCH_FLAGS,
  COMMAND_CODE_EXIT_COMMAND,
} from '@/lib/cli-tools/command-code';
import { getCommandCodeSettingsPath } from '@/lib/hooks/sources/command-code/hooks-config';
import { getAgentEventGenerationStartedAt } from '@/lib/session/agent-event-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { removeTempDir } from '@tests/helpers/temp-dir';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));

const SESSION = 'mcbd-command-code-test-wt';

/** The launch context the tool builds for `startSession('test-wt', <path>)`. */
const launchContext = (worktreePath = '/path/to/wt') => ({
  target: { worktreeId: 'test-wt', cliToolId: 'command-code' as const, instanceId: undefined },
  executablePath: COMMAND_CODE_COMMAND,
  worktreePath,
});

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/command-code-live-2250');
const frame = (name: string): string =>
  fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf-8');

describe('CommandCodeTool', () => {
  let tool: CommandCodeTool;

  beforeEach(() => {
    tool = new CommandCodeTool();
    vi.clearAllMocks();
    // The default for this file. The hooks-on path is exercised in its own
    // block, with a real worktree to write into.
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('Tool properties', () => {
    it('has the tool id Epic #2249 決定 1 fixed', () => {
      const id: CLIToolType = tool.id;
      expect(id).toBe('command-code');
    });

    it('launches `commandcode`, not `cmd`', () => {
      // `cmd` is Windows' shell and reads as CommandMate's own name in a log
      // line. The package ships four bins; this is the unambiguous one.
      expect(tool.command).toBe('commandcode');
      expect(COMMAND_CODE_COMMAND).toBe('commandcode');
    });

    it('has a display-ready name', () => {
      expect(tool.name).toBe('Command Code CLI');
    });

    it('implements the ICLITool surface', () => {
      for (const method of [
        'isInstalled',
        'isRunning',
        'startSession',
        'sendMessage',
        'killSession',
        'getSessionName',
      ] as const) {
        expect(typeof tool[method]).toBe('function');
      }
    });
  });

  describe('getSessionName', () => {
    it('generates a session name from the tool id', () => {
      expect(tool.getSessionName('test-wt')).toBe(SESSION);
    });

    it('rejects a worktree id with slashes (security)', () => {
      expect(() => tool.getSessionName('feature/issue/123')).toThrow(/Invalid session name format/);
    });
  });

  describe('buildCommandCodeLaunchCommand (the Phase B seam)', () => {
    it('renders the launch line Epic #2249 決定 2 fixed', () => {
      // With injection off — the documented rollback (`CM_AGENT_HOOKS_INJECT=0`)
      // — the line is byte-identical to the one Phase A shipped.
      expect(buildCommandCodeLaunchCommand(launchContext())).toBe(
        'commandcode --trust --skip-onboarding --no-auto-update',
      );
    });

    it('names each flag, so a silent drop is a visible diff', () => {
      // `--trust` and `--skip-onboarding` are what keep an unattended launch off
      // a dialog nobody is watching (#2131 sat on claude's onboarding for three
      // hours); `--no-auto-update` is there because a self-update restart kills
      // Auto-Yes.
      expect([...COMMAND_CODE_LAUNCH_FLAGS]).toEqual([
        '--trust',
        '--skip-onboarding',
        '--no-auto-update',
      ]);
    });

    it('takes the executable as a parameter, which is the swap point', () => {
      expect(
        buildCommandCodeLaunchCommand({
          ...launchContext(),
          executablePath: '/opt/homebrew/bin/commandcode',
        }),
      ).toBe('/opt/homebrew/bin/commandcode --trust --skip-onboarding --no-auto-update');
    });
  });

  describe('isCommandCodeReady', () => {
    it('is true for a launched, idle pane', () => {
      expect(isCommandCodeReady(frame('boot-idle'))).toBe(true);
    });

    it('is true for a finished turn', () => {
      expect(isCommandCodeReady(frame('turn-version'))).toBe(true);
    });

    it('is false while a turn is in flight, even though the composer is drawn', () => {
      expect(isCommandCodeReady(frame('turn-thinking'))).toBe(false);
    });

    it('is false while a permission dialog has replaced the composer', () => {
      expect(isCommandCodeReady(frame('dialog-create-file'))).toBe(false);
    });

    it('is false for a bare shell prompt', () => {
      expect(isCommandCodeReady('user@host cc2250-probe % ')).toBe(false);
    });

    it('does not key on `? for shortcuts`, which is only the default mode', () => {
      // A pane in plan / auto-accept / dont-ask mode draws a different footer.
      // Structure is the rule; the footer wording is not.
      // The raw row is `…m? for shortcuts · <SGR>taste on…`, so only the first
      // half is a contiguous substring of the capture.
      const planMode = frame('boot-idle').replace('? for shortcuts · ', 'plan mode ');
      expect(planMode).not.toContain('? for shortcuts');
      expect(isCommandCodeReady(planMode)).toBe(true);
    });
  });

  describe('startSession', () => {
    it('refuses when commandcode is not installed', async () => {
      vi.spyOn(tool, 'isInstalled').mockResolvedValue(false);
      await expect(tool.startSession('test-wt', '/path/to/wt')).rejects.toThrow(/not installed/i);
    });

    it('types the launch line into a new pane and waits for the composer', async () => {
      vi.useFakeTimers();
      try {
        const { hasSession, createSession, sendKeys, capturePane } = await import(
          '@/lib/tmux/tmux'
        );
        vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
        vi.mocked(hasSession).mockResolvedValue(false);
        vi.mocked(capturePane).mockResolvedValue(frame('boot-idle'));

        const promise = tool.startSession('test-wt', '/path/to/wt');
        await vi.advanceTimersByTimeAsync(40000);
        await promise;

        expect(createSession).toHaveBeenCalled();
        expect(sendKeys).toHaveBeenCalledWith(
          SESSION,
          buildCommandCodeLaunchCommand(launchContext()),
          true,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not relaunch into a pane whose agent is still alive', async () => {
      vi.useFakeTimers();
      try {
        const { hasSession, createSession, sendKeys, capturePane } = await import(
          '@/lib/tmux/tmux'
        );
        vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
        vi.mocked(hasSession).mockResolvedValue(true);
        vi.mocked(capturePane).mockResolvedValue(frame('boot-idle'));

        const promise = tool.startSession('test-wt', '/path/to/wt');
        await vi.advanceTimersByTimeAsync(40000);
        await promise;

        expect(createSession).not.toHaveBeenCalled();
        expect(sendKeys).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-sends the launch line into a pane the agent has left (#2070)', async () => {
      vi.useFakeTimers();
      try {
        const { hasSession, createSession, sendKeys, capturePane } = await import(
          '@/lib/tmux/tmux'
        );
        vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
        vi.mocked(hasSession).mockResolvedValue(true);
        // A pane holding nothing but a shell prompt: the tmux session outlived
        // the agent.
        vi.mocked(capturePane).mockResolvedValue('user@host cc2250-probe % ');

        const promise = tool.startSession('test-wt', '/path/to/wt');
        await vi.advanceTimersByTimeAsync(60000);
        await promise;

        expect(createSession).not.toHaveBeenCalled();
        expect(sendKeys).toHaveBeenCalledWith(
          SESSION,
          buildCommandCodeLaunchCommand(launchContext()),
          true,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('sendMessage', () => {
    it('refuses when the session does not exist', async () => {
      const { hasSession } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(false);

      await expect(tool.sendMessage('test-wt', 'hello')).rejects.toThrow(/does not exist/i);
    });

    it('sends through the submit-verified sender and invalidates the capture cache', async () => {
      vi.useFakeTimers();
      try {
        const { hasSession, capturePane } = await import('@/lib/tmux/tmux');
        const { sendMessageWithSubmitVerification } = await import(
          '@/lib/cli-tools/submit-verified-sender'
        );
        const { invalidateCache } = await import('@/lib/tmux/tmux-capture-cache');
        vi.mocked(hasSession).mockResolvedValue(true);
        vi.mocked(capturePane).mockResolvedValue(frame('boot-idle'));

        const promise = tool.sendMessage('test-wt', 'hello');
        await vi.advanceTimersByTimeAsync(20000);
        await promise;

        expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionName: SESSION,
            message: 'hello',
            cliToolId: 'command-code',
            composer: tool.describeComposer(),
          }),
        );
        // Without this the next poll answers from the 5-second capture cache and
        // the send looks like it never happened.
        expect(invalidateCache).toHaveBeenCalledWith(SESSION);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses rather than typing into a pane that is not at a composer', async () => {
      vi.useFakeTimers();
      try {
        const { hasSession, capturePane } = await import('@/lib/tmux/tmux');
        const { sendMessageWithSubmitVerification } = await import(
          '@/lib/cli-tools/submit-verified-sender'
        );
        vi.mocked(hasSession).mockResolvedValue(true);
        // A permission dialog is up: the composer is gone and anything typed
        // would be answering the dialog.
        vi.mocked(capturePane).mockResolvedValue(frame('dialog-create-file'));

        const promise = tool.sendMessage('test-wt', 'hello');
        const assertion = expect(promise).rejects.toThrow(/prompt not ready/i);
        await vi.advanceTimersByTimeAsync(30000);
        await assertion;

        expect(sendMessageWithSubmitVerification).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('killSession', () => {
    it('types `/exit` and submits it as a SEPARATE tmux command', async () => {
      vi.useFakeTimers();
      try {
        const { hasSession, sendKeys, sendSpecialKeys, killSession } = await import(
          '@/lib/tmux/tmux'
        );
        const { invalidateCache } = await import('@/lib/tmux/tmux-capture-cache');
        vi.mocked(hasSession).mockResolvedValue(true);

        const promise = tool.killSession('test-wt');
        await vi.advanceTimersByTimeAsync(10000);
        await promise;

        // Batched, the Enter would be consumed by the slash-command menu that
        // typing `/` opens — the defect #1905 measured on opencode.
        expect(sendKeys).toHaveBeenCalledWith(SESSION, COMMAND_CODE_EXIT_COMMAND, false);
        expect(sendSpecialKeys).toHaveBeenCalledWith(SESSION, ['Enter']);
        expect(killSession).toHaveBeenCalledWith(SESSION);
        expect(invalidateCache).toHaveBeenCalledWith(SESSION);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still kills the tmux session when no pane was there to exit', async () => {
      const { hasSession, sendKeys, killSession } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(false);

      await tool.killSession('test-wt');

      expect(sendKeys).not.toHaveBeenCalled();
      expect(killSession).toHaveBeenCalledWith(SESSION);
    });
  });
  describe('the Phase B launch path (#2251)', () => {
    let worktree: string;

    beforeEach(() => {
      worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmate-2251-tool-')));
      vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
    });

    afterEach(() => {
      removeTempDir(worktree);
    });

    it('writes the worktree settings and prefixes CM_HOOK_URL', () => {
      const line = buildCommandCodeLaunchCommand(launchContext(worktree));

      // The assignments are IN FRONT of the executable and the flags are after
      // it. Rendering the plan any other way — `prepareAgentLaunch(...).command`
      // straight into `sendKeys`, which is the mistake #1846 exists to stop —
      // drops the environment, and the hooks then post with no instance.
      expect(line).toMatch(
        /^CM_HOOK_URL='[^']+' 'commandcode' --trust --skip-onboarding --no-auto-update$/,
      );
      expect(line).toContain('tool=command-code');
      expect(line).toContain('worktreeId=test-wt');

      const settingsPath = getCommandCodeSettingsPath(worktree);
      expect(fs.existsSync(settingsPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(Object.keys(written.hooks)).toEqual([
        'SessionStart',
        'PreToolUse',
        'PostToolUse',
        'Stop',
      ]);
      // The empty matcher, which is the only value that leaves SessionStart and
      // Stop firing at all.
      for (const event of Object.keys(written.hooks)) {
        expect(written.hooks[event][0].matcher, event).toBe('');
      }
    });

    it('opens a new event generation before the pane exists (seam S8)', async () => {
      vi.useFakeTimers();
      try {
        const { hasSession, capturePane, sendKeys } = await import('@/lib/tmux/tmux');
        vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
        vi.mocked(hasSession).mockResolvedValue(false);
        vi.mocked(capturePane).mockResolvedValue(frame('boot-idle'));

        const before = Date.now();
        const promise = tool.startSession('test-wt', worktree);
        await vi.advanceTimersByTimeAsync(40000);
        await promise;

        // Without this, a restarted pane inherits the dead process's last
        // event and publishes `running` before anyone has typed into it (#1723).
        const startedAt = getAgentEventGenerationStartedAt('test-wt', 'command-code');
        expect(startedAt).not.toBeNull();
        expect(startedAt!).toBeGreaterThanOrEqual(before);

        expect(sendKeys).toHaveBeenCalledWith(
          SESSION,
          buildCommandCodeLaunchCommand(launchContext(worktree)),
          true,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
