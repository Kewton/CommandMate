/**
 * Copilot install detection and launch (Issue #1907).
 *
 * Three defects, all of which left every other test green:
 *
 *  - **`isInstalled()` answered from `gh copilot --help`.** Measured on gh
 *    2.86.0 with an empty `gh extension list`, that exits 0 on a machine with no
 *    copilot: `copilot` is a preview command built into gh, and its help text
 *    says it will download the CLI if none is installed. The badge said
 *    installed and `startSession` then typed `gh copilot` into the pane, where
 *    the download ran while `waitForReady` spun.
 *  - **the launch command was hardcoded** even though the resolution said
 *    nothing about it, so the answer and the action came from different places.
 *  - **the readiness check accepted any `^❯`**, which is a great many shell
 *    prompts. Harmless only for as long as a blind 4-second sleep hid the shell
 *    from the first poll.
 *
 * The resolver is exercised against a real filesystem — temp directories on
 * `PATH` / `XDG_DATA_HOME` — with only `execFile` mocked, so "found on PATH"
 * means what it means at runtime. `~/.copilot` is never touched.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  buildCopilotBannerOnlyFrame,
  buildCopilotShellEchoFrame,
  SHELL_PROMPT_CHEVRON,
} from '@tests/fixtures/copilot-launch-boot-1080';
import {
  buildCopilotFolderTrustFrame,
  buildCopilotReadyFrame,
} from '@tests/fixtures/copilot-folder-trust-1080';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

import { execFile } from 'child_process';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { resolveCopilotExecutable } from '@/lib/cli-tools/copilot-executable';
import { capturePane, sendKeys } from '@/lib/tmux/tmux';

const WORKTREE_ID = 'wt-copilot-1907';
const WORKTREE_PATH = '/repos/wt-copilot-1907';
const SESSION = 'mcbd-copilot-wt-copilot-1907';

const COPILOT_VERSION_OUTPUT = "GitHub Copilot CLI 1.0.80.\nRun 'copilot update' to check for updates.\n";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

let sandbox: string;
let pathDir: string;
let dataHome: string;
let copilotHome: string;
let originalPath: string | undefined;
let originalDataHome: string | undefined;
let tool: CopilotTool;

/** Every `execFile` call as `[file, ...args]`. */
let execFileCalls: string[][];

/** Drop an executable file at `target` (contents irrelevant — execFile is mocked). */
function placeExecutable(target: string): void {
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, '#!/bin/sh\n');
  chmodSync(target, 0o755);
}

/**
 * Answer `--version` for `responders` and fail for everything else.
 *
 * Keyed by absolute path, so "the copy on PATH answers but gh's does not" is
 * expressible — which is the difference the resolver's ordering turns on.
 */
function versionAnswers(responders: Record<string, string>): void {
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    _options: unknown,
    callback?: unknown
  ) => {
    execFileCalls.push([file, ...args]);
    const cb = callback as ExecCallback | undefined;
    const answer = responders[file];
    queueMicrotask(() => {
      if (answer === undefined) cb?.(new Error('command not found'), '', '');
      else cb?.(null, answer, '');
    });
    return {} as import('child_process').ChildProcess;
  }) as unknown as typeof execFile);
}

/**
 * Run `startSession` to completion under fake timers.
 *
 * The rejection handler is attached the moment the promise is created: adding it
 * after the timers have run lets a failure reject while nothing is listening,
 * which vitest reports as an unhandled rejection — a non-zero exit with every
 * test still green.
 */
let sessionStartedAt = 0;

async function startSession(): Promise<void> {
  vi.useFakeTimers();
  try {
    sessionStartedAt = Date.now();
    let failure: unknown;
    const running = tool.startSession(WORKTREE_ID, WORKTREE_PATH).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(90_000);
    await running;
    if (failure !== undefined) throw failure;
  } finally {
    vi.useRealTimers();
  }
}

/** The line `startSession` typed into the pane. */
function launchLine(): string {
  return String(vi.mocked(sendKeys).mock.calls.at(0)?.[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  execFileCalls = [];

  sandbox = mkdtempSync(join(tmpdir(), 'cmate-copilot-1907-'));
  pathDir = join(sandbox, 'bin');
  dataHome = join(sandbox, 'data');
  copilotHome = join(sandbox, 'copilot-home');
  const emptyPathDir = join(sandbox, 'empty-bin');
  mkdirSync(pathDir, { recursive: true });
  mkdirSync(dataHome, { recursive: true });
  mkdirSync(copilotHome, { recursive: true });
  mkdirSync(emptyPathDir, { recursive: true });

  // `startSession` writes hook settings; keep that off the operator's real
  // ~/.copilot, which is one file shared by every checkout on the machine.
  process.env.COPILOT_HOME = copilotHome;
  delete process.env.CM_AGENT_HOOKS_INJECT;

  // The whole point is that nothing outside the sandbox is consulted: the dev
  // machine has a real copilot on PATH and CI does not, and neither may decide
  // the result.
  originalPath = process.env.PATH;
  originalDataHome = process.env.XDG_DATA_HOME;
  // Two entries, the interesting one second: a resolver that only looked at the
  // head of PATH would pass every test below with the order reversed.
  process.env.PATH = [emptyPathDir, pathDir].join(delimiter);
  process.env.XDG_DATA_HOME = dataHome;

  vi.mocked(capturePane).mockResolvedValue(buildCopilotReadyFrame());
  versionAnswers({});

  tool = new CopilotTool();
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  delete process.env.COPILOT_HOME;
  removeTempDir(sandbox);
});

describe('resolveCopilotExecutable', () => {
  it('reports the copilot on PATH with the version it printed', async () => {
    const copilot = join(pathDir, 'copilot');
    placeExecutable(copilot);
    versionAnswers({ [copilot]: COPILOT_VERSION_OUTPUT });

    await expect(resolveCopilotExecutable()).resolves.toEqual({
      path: copilot,
      version: '1.0.80',
      source: 'path',
    });
  });

  it('runs the absolute path it resolved, not the bare word (DR4-010)', async () => {
    const copilot = join(pathDir, 'copilot');
    placeExecutable(copilot);
    versionAnswers({ [copilot]: COPILOT_VERSION_OUTPUT });

    await resolveCopilotExecutable();

    expect(execFileCalls).toEqual([[copilot, '--version']]);
  });

  it('finds nothing when gh is installed but copilot is not — the #1907 false positive', async () => {
    // gh answers everything it is asked, including `gh copilot --help`, which is
    // what the old two-stage check read as proof.
    const gh = join(pathDir, 'gh');
    placeExecutable(gh);
    versionAnswers({ [gh]: 'gh version 2.86.0 (2026-01-21)\n' });

    await expect(resolveCopilotExecutable()).resolves.toBeNull();
  });

  it('never asks gh whether copilot exists', async () => {
    const gh = join(pathDir, 'gh');
    placeExecutable(gh);
    versionAnswers({ [gh]: 'gh version 2.86.0\n' });

    await resolveCopilotExecutable();

    expect(execFileCalls.some((call) => call.includes('copilot') && call.includes('--help'))).toBe(false);
  });

  it('rejects a --version that exits 0 without printing a version', async () => {
    // Exit code 0 alone is precisely what made the old check useless.
    const copilot = join(pathDir, 'copilot');
    placeExecutable(copilot);
    versionAnswers({ [copilot]: 'ok\n' });

    await expect(resolveCopilotExecutable()).resolves.toBeNull();
  });

  it('rejects a path entry that is a directory rather than an executable', async () => {
    mkdirSync(join(pathDir, 'copilot'), { recursive: true });

    await expect(resolveCopilotExecutable()).resolves.toBeNull();
  });

  it("falls back to gh's downloaded copy when PATH has none", async () => {
    const gh = join(pathDir, 'gh');
    const managed = join(dataHome, 'gh', 'copilot');
    placeExecutable(gh);
    placeExecutable(managed);
    versionAnswers({ [gh]: 'gh version 2.86.0\n', [managed]: COPILOT_VERSION_OUTPUT });

    await expect(resolveCopilotExecutable()).resolves.toEqual({
      path: managed,
      version: '1.0.80',
      source: 'gh-managed',
    });
  });

  it("accepts gh's copy inside a directory of that name", async () => {
    const gh = join(pathDir, 'gh');
    const managed = join(dataHome, 'gh', 'copilot', 'copilot');
    placeExecutable(gh);
    placeExecutable(managed);
    versionAnswers({ [gh]: 'gh version 2.86.0\n', [managed]: COPILOT_VERSION_OUTPUT });

    const resolved = await resolveCopilotExecutable();

    expect(resolved?.source).toBe('gh-managed');
    expect(resolved?.path).toBe(managed);
  });

  it("does not offer gh's copy on a machine without gh", async () => {
    const managed = join(dataHome, 'gh', 'copilot');
    placeExecutable(managed);
    versionAnswers({ [managed]: COPILOT_VERSION_OUTPUT });

    await expect(resolveCopilotExecutable()).resolves.toBeNull();
  });

  it('prefers PATH over the downloaded copy', async () => {
    const copilot = join(pathDir, 'copilot');
    const gh = join(pathDir, 'gh');
    const managed = join(dataHome, 'gh', 'copilot');
    placeExecutable(copilot);
    placeExecutable(gh);
    placeExecutable(managed);
    versionAnswers({
      [copilot]: COPILOT_VERSION_OUTPUT,
      [gh]: 'gh version 2.86.0\n',
      [managed]: 'GitHub Copilot CLI 0.9.0.\n',
    });

    const resolved = await resolveCopilotExecutable();

    expect(resolved?.source).toBe('path');
    expect(execFileCalls).toEqual([[copilot, '--version']]);
  });
});

describe('CopilotTool.isInstalled', () => {
  it('is true only when a copilot executable answered --version', async () => {
    const copilot = join(pathDir, 'copilot');
    placeExecutable(copilot);
    versionAnswers({ [copilot]: COPILOT_VERSION_OUTPUT });

    await expect(tool.isInstalled()).resolves.toBe(true);
  });

  it('is false on a machine that only has gh', async () => {
    const gh = join(pathDir, 'gh');
    placeExecutable(gh);
    versionAnswers({ [gh]: 'gh version 2.86.0\n' });

    await expect(tool.isInstalled()).resolves.toBe(false);
  });
});

describe('CopilotTool.command', () => {
  it("is the standalone executable, not 'gh'", () => {
    expect(tool.command).toBe('copilot');
  });
});

describe('startSession', () => {
  it('refuses to start when no copilot answered, and names the current installers', async () => {
    const gh = join(pathDir, 'gh');
    placeExecutable(gh);
    versionAnswers({ [gh]: 'gh version 2.86.0\n' });

    await expect(startSession()).rejects.toThrow(/brew install copilot-cli|@github\/copilot/);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('does not name the retired gh-copilot extension', async () => {
    const gh = join(pathDir, 'gh');
    placeExecutable(gh);
    versionAnswers({ [gh]: 'gh version 2.86.0\n' });

    const message = await startSession().then(
      () => 'started, which it should not have',
      (error: unknown) => String(error)
    );

    expect(message).not.toContain('gh extension install');
    expect(message).not.toContain('gh-copilot');
  });

  it('launches the PATH copilot rather than gh', async () => {
    const copilot = join(pathDir, 'copilot');
    placeExecutable(copilot);
    versionAnswers({ [copilot]: COPILOT_VERSION_OUTPUT });

    await startSession();

    expect(launchLine()).toMatch(/(^| )copilot$/);
    expect(launchLine()).not.toContain('gh copilot');
  });

  it("falls back to `gh copilot` for gh's own copy", async () => {
    const gh = join(pathDir, 'gh');
    const managed = join(dataHome, 'gh', 'copilot');
    placeExecutable(gh);
    placeExecutable(managed);
    versionAnswers({ [gh]: 'gh version 2.86.0\n', [managed]: COPILOT_VERSION_OUTPUT });

    await startSession();

    expect(launchLine()).toMatch(/(^| )gh copilot$/);
  });
});

describe('waitForReady on the real boot sequence', () => {
  /** Feed `startSession` one frame per poll and report how many it consumed. */
  async function pollThrough(frames: string[]): Promise<number> {
    const copilot = join(pathDir, 'copilot');
    placeExecutable(copilot);
    versionAnswers({ [copilot]: COPILOT_VERSION_OUTPUT });

    let index = 0;
    vi.mocked(capturePane).mockImplementation(async () => {
      const frame = frames[Math.min(index, frames.length - 1)];
      index += 1;
      return frame;
    });

    await startSession();
    return index;
  }

  it('does not read a chevron shell prompt as a ready copilot', async () => {
    // The regression the removed 4-second sleep was hiding: at t = 0.41 s the
    // pane is the operator's shell echoing the launch command, and starship /
    // pure / agnoster all draw `❯` at column 0.
    const shell = buildCopilotShellEchoFrame(SHELL_PROMPT_CHEVRON);

    const polls = await pollThrough([shell]);

    // It kept looking for the whole window instead of declaring victory at once.
    expect(polls).toBeGreaterThan(1);
  });

  it('does not read the banner-only frame as ready', async () => {
    const polls = await pollThrough([buildCopilotBannerOnlyFrame()]);

    expect(polls).toBeGreaterThan(1);
  });

  it('walks shell → banner → dialog → composer and stops on the composer', async () => {
    const frames = [
      buildCopilotShellEchoFrame(SHELL_PROMPT_CHEVRON),
      buildCopilotBannerOnlyFrame(),
      buildCopilotFolderTrustFrame(),
      buildCopilotReadyFrame(),
    ];

    const polls = await pollThrough(frames);

    expect(polls).toBe(4);
    expect(sendKeys).toHaveBeenCalledWith(SESSION, '1', false);
  });

  it('stops on the first poll when the composer is already up', async () => {
    const polls = await pollThrough([buildCopilotReadyFrame()]);

    expect(polls).toBe(1);
  });

  it('starts polling immediately instead of sleeping a fixed 4 seconds first', async () => {
    // The blind sleep put a floor under every launch: copilot draws its banner
    // at ~1.3 s and its dialog at ~2.5 s, so 4 s was both too long for a trusted
    // folder and irrelevant to an untrusted one. Under fake timers `Date.now()`
    // advances with the scheduler, so this reads the wait directly.
    const copilot = join(pathDir, 'copilot');
    placeExecutable(copilot);
    versionAnswers({ [copilot]: COPILOT_VERSION_OUTPUT });

    let firstPollAt: number | null = null;
    vi.mocked(capturePane).mockImplementation(async () => {
      firstPollAt ??= Date.now();
      return buildCopilotReadyFrame();
    });

    await startSession();

    expect(firstPollAt).not.toBeNull();
    // Only tmux's own settle (TUI_SESSION_CREATE_WAIT_MS = 100 ms) is left.
    expect((firstPollAt ?? Infinity) - sessionStartedAt).toBeLessThan(1_000);
  });
});
