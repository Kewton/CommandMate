/**
 * Issue #2068 — what `CodexTool.waitForReady` does with codex's update dialog,
 * under each of the four policies.
 *
 * The reported bug is not that the wrong key was sent; it is that the SAME key
 * was sent every time and it persisted nothing. Measured on codex-cli 0.149.1
 * in an isolated `CODEX_HOME` (2026-08-31):
 *
 * | key | `$CODEX_HOME/version.json` after | next launch |
 * |-----|----------------------------------|-------------|
 * | `'2'` | `dismissed_version: null` (unchanged) | dialog again |
 * | `'3'` | `dismissed_version: "0.151.0"` | no dialog |
 * | `'1'` | unchanged; codex exits into `npm install -g @openai/codex` | — |
 *
 * So the tests below are about which digit reaches the pane, and — for the two
 * policies that can end with codex gone — whether the launch line goes back in.
 *
 * The frames are the ones captured live for this Issue
 * (`tests/fixtures/codex-update-dialog-2068/`), not hand-written approximations:
 * the post-update pane in particular has a property no synthetic frame would
 * have reproduced, and the whole relaunch trigger turns on it.
 *
 * Separate file so `vi.mock` does not affect `codex.test.ts` (the precedent set
 * by `codex-startup-dialog.test.ts`).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  getSessionWorkingDirectory: vi.fn().mockResolvedValue('/test/path'),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/cli-tools/validation', () => ({
  validateSessionName: vi.fn(),
}));

// BaseCLITool.isInstalled() uses promisify(exec); resolve it so isInstalled() === true
vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: () => vi.fn().mockResolvedValue(undefined),
  };
});

import { CodexTool } from '@/lib/cli-tools/codex';
import { hasSession, sendKeys, capturePane } from '@/lib/tmux/tmux';
import { CODEX_UPDATE_DIALOG_ENV_VAR } from '@/config/codex-update-dialog-config';

const WORKTREE_ID = 'test-worktree';
const SESSION = 'mcbd-codex-test-worktree';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/codex-update-dialog-2068');
const frame = (name: string): string =>
  fs.readFileSync(path.join(FIXTURES, `${name}-01491.txt`), 'utf-8');

/** codex 0.149.1's interactive update dialog, bottom-most on the pane. */
const UPDATE_DIALOG = frame('update-dialog');
/** One second after `1`: `Updating Codex via …` and a spinner. */
const UPDATING = frame('updating');
/** `npm install` done, codex gone, a live shell prompt on the last row. */
const UPDATED_SHELL = frame('updated-shell');
/** A pane whose bottom-most element is the genuine composer. */
const PROMPT = '› ';
/** A pane with nothing on it but a shell prompt — no dialog anywhere above. */
const BARE_SHELL = 'localuser@EXAMPLEMac-Studio wt %';

/** The launch line, however Issue #1760's env prefix renders it. */
const LAUNCH_LINE = expect.stringMatching(/(^codex$|'codex'$)/);

/** Digits sent to the pane, in order, ignoring the launch line. */
function digitsSent(): string[] {
  return vi
    .mocked(sendKeys)
    .mock.calls.filter(([session, sent]) => session === SESSION && /^[0-9]$/.test(sent))
    .map(([, sent]) => sent);
}

/** How many times the launch line was typed into the pane. */
function launchCount(): number {
  return vi
    .mocked(sendKeys)
    .mock.calls.filter(([session, sent, enter]) => session === SESSION && enter === true && /(^codex$|'codex'$)/.test(sent))
    .length;
}

/** Drive a whole `startSession` under fake timers. */
async function runStartSession(tool: CodexTool): Promise<void> {
  vi.useFakeTimers();
  try {
    const promise = tool.startSession(WORKTREE_ID, '/test/path');
    await vi.runAllTimersAsync();
    await promise;
  } finally {
    vi.useRealTimers();
  }
}

describe('[#2068] the update dialog policy', () => {
  let tool: CodexTool;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(CODEX_UPDATE_DIALOG_ENV_VAR, undefined as unknown as string);
    tool = new CodexTool();
    vi.mocked(hasSession).mockResolvedValue(false);
    vi.mocked(sendKeys).mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('the default', () => {
    it('sends "3" (Skip until next version) — the only key that persists', async () => {
      vi.mocked(capturePane).mockResolvedValueOnce(UPDATE_DIALOG).mockResolvedValue(PROMPT);

      await runStartSession(tool);

      expect(digitsSent()).toEqual(['3']);
      // The regression the default replaces: '2' answered the dialog and wrote
      // nothing, so the next launch met it again.
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '2', false);
      // And never with a trailing Enter (Issue #890): the number confirms, so an
      // Enter would land on the screen behind it.
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '3', true);
    });

    it('sends it exactly once however long the dialog stays in the capture', async () => {
      vi.mocked(capturePane)
        .mockResolvedValueOnce(UPDATE_DIALOG)
        .mockResolvedValueOnce(UPDATE_DIALOG)
        .mockResolvedValue(PROMPT);

      await runStartSession(tool);

      expect(digitsSent()).toEqual(['3']);
    });

    it('does not relaunch: the pane never became a shell', async () => {
      vi.mocked(capturePane).mockResolvedValueOnce(UPDATE_DIALOG).mockResolvedValue(PROMPT);

      await runStartSession(tool);

      expect(launchCount()).toBe(1);
    });
  });

  describe('CM_CODEX_UPDATE_DIALOG=skip', () => {
    it('sends "2", the pre-#2068 behaviour, for operators who want it back', async () => {
      vi.stubEnv(CODEX_UPDATE_DIALOG_ENV_VAR, 'skip');
      vi.mocked(capturePane).mockResolvedValueOnce(UPDATE_DIALOG).mockResolvedValue(PROMPT);

      await runStartSession(tool);

      expect(digitsSent()).toEqual(['2']);
    });
  });

  describe('CM_CODEX_UPDATE_DIALOG=update', () => {
    beforeEach(() => {
      vi.stubEnv(CODEX_UPDATE_DIALOG_ENV_VAR, 'update');
    });

    it('sends "1" and re-sends the launch line once the shell comes back', async () => {
      vi.mocked(capturePane)
        .mockResolvedValueOnce(UPDATE_DIALOG) // -> "1"
        .mockResolvedValueOnce(UPDATING) // npm still running: do NOT relaunch
        .mockResolvedValueOnce(UPDATED_SHELL) // codex gone, shell back: relaunch
        .mockResolvedValue(PROMPT); // the new codex is ready

      await runStartSession(tool);

      expect(digitsSent()).toEqual(['1']);
      // Two launch lines: the original and the one after the update.
      expect(launchCount()).toBe(2);
      expect(sendKeys).toHaveBeenLastCalledWith(SESSION, LAUNCH_LINE, true);
    });

    it('waits out the install rather than relaunching on top of it', async () => {
      // Six polls of `npm install` still running, then the shell.
      vi.mocked(capturePane)
        .mockResolvedValueOnce(UPDATE_DIALOG)
        .mockResolvedValueOnce(UPDATING)
        .mockResolvedValueOnce(UPDATING)
        .mockResolvedValueOnce(UPDATING)
        .mockResolvedValueOnce(UPDATING)
        .mockResolvedValueOnce(UPDATING)
        .mockResolvedValueOnce(UPDATING)
        .mockResolvedValueOnce(UPDATED_SHELL)
        .mockResolvedValue(PROMPT);

      await runStartSession(tool);

      expect(launchCount()).toBe(2);
    });

    it('relaunches at most once, so a failed update cannot loop', async () => {
      // The install failed: the relaunched codex is the old version and puts the
      // identical dialog back. Answering "1" again would quit it a second time
      // with the one relaunch already spent, so neither happens — the dialog is
      // left on the pane where `detectPrompt` reports it to the human.
      vi.mocked(capturePane)
        .mockResolvedValueOnce(UPDATE_DIALOG)
        .mockResolvedValueOnce(UPDATED_SHELL)
        .mockResolvedValue(UPDATE_DIALOG);

      await runStartSession(tool);

      expect(digitsSent()).toEqual(['1']);
      expect(launchCount()).toBe(2);
    });

    it('does not relaunch a pane that never met the dialog', async () => {
      // A bare shell with no update dialog above it is not this Issue's frame —
      // it is Issue #2070's, and `launchSession`'s own reuse branch owns it.
      vi.mocked(capturePane).mockResolvedValue(BARE_SHELL);

      await runStartSession(tool);

      expect(digitsSent()).toEqual([]);
      expect(launchCount()).toBe(1);
    });
  });

  describe('CM_CODEX_UPDATE_DIALOG=ask', () => {
    beforeEach(() => {
      vi.stubEnv(CODEX_UPDATE_DIALOG_ENV_VAR, 'ask');
    });

    it('answers nothing at all — the human owns the screen', async () => {
      vi.mocked(capturePane).mockResolvedValue(UPDATE_DIALOG);

      await runStartSession(tool);

      expect(digitsSent()).toEqual([]);
      // Not an Enter either: "Press enter to continue" is this dialog's own
      // footer, and Enter on it confirms the pre-selected "1. Update now".
      expect(sendKeys).not.toHaveBeenCalledWith(SESSION, '', true);
      expect(launchCount()).toBe(1);
    });

    it('still reaches the prompt when the human picks a skip', async () => {
      vi.mocked(capturePane)
        .mockResolvedValueOnce(UPDATE_DIALOG)
        .mockResolvedValueOnce(UPDATE_DIALOG)
        .mockResolvedValue(PROMPT);

      await runStartSession(tool);

      expect(digitsSent()).toEqual([]);
      expect(launchCount()).toBe(1);
    });

    it('relaunches when the human picks "1" while the launch is still waiting', async () => {
      vi.mocked(capturePane)
        .mockResolvedValueOnce(UPDATE_DIALOG)
        .mockResolvedValueOnce(UPDATING)
        .mockResolvedValueOnce(UPDATED_SHELL)
        .mockResolvedValue(PROMPT);

      await runStartSession(tool);

      // Nothing was answered by this server…
      expect(digitsSent()).toEqual([]);
      // …but the pane it was handed back is a shell, so the launch line goes in.
      expect(launchCount()).toBe(2);
    });
  });

  describe('an unrecognised CM_CODEX_UPDATE_DIALOG', () => {
    it('falls back to the default rather than guessing at "update"', async () => {
      vi.stubEnv(CODEX_UPDATE_DIALOG_ENV_VAR, 'updates');
      vi.mocked(capturePane).mockResolvedValueOnce(UPDATE_DIALOG).mockResolvedValue(PROMPT);

      await runStartSession(tool);

      expect(digitsSent()).toEqual(['3']);
    });
  });
});
