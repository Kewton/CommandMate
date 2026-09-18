/**
 * Unit tests for CopilotTool
 * Issue #545: Copilot CLI support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  CopilotTool,
  COPILOT_EXIT_COMMAND,
  isCopilotStartupLoading,
  judgeCopilotModelSwitch,
  readCopilotModelSwitchOutcomes,
} from '@/lib/cli-tools/copilot';
import { resolveCopilotExecutable } from '@/lib/cli-tools/copilot-executable';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { COPILOT_EXIT_WAIT_MS, TUI_EXIT_WAIT_MS } from '@/config/cli-tool-timing-config';
import { COPILOT_MODEL_SWITCH_TIMEOUT_MS } from '@/config/copilot-constants';
import { COPILOT_MODEL_SWITCH_2623_FRAMES as FRAMES } from '../../fixtures/copilot-model-switch-2623';

// Mock child_process execFile so nothing here can spawn a real process
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

// Issue #1907: install detection is a filesystem probe now (PATH lookup +
// `--version`), so it is stubbed here and exercised for real against temp
// directories in copilot-install-detection-1907.test.ts.
vi.mock('@/lib/cli-tools/copilot-executable', () => ({
  resolveCopilotExecutable: vi.fn(),
}));

// Mock tmux functions
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  // Issue #1905: the exit command is typed and submitted separately.
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/pasted-text-helper', () => ({
  detectAndResendIfPastedText: vi.fn().mockResolvedValue(undefined),
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

/** A promise's outcome, readable while fake timers are being advanced. */
interface Tracked {
  state: 'pending' | 'resolved' | 'rejected';
  error?: string;
  /** Fake-clock ms from `track()` to settling. */
  settledAt?: number;
}

function track(promise: Promise<unknown>): Tracked {
  const startedAt = Date.now();
  const tracked: Tracked = { state: 'pending' };
  promise.then(
    () => {
      tracked.state = 'resolved';
      tracked.settledAt = Date.now() - startedAt;
    },
    (error: unknown) => {
      tracked.state = 'rejected';
      tracked.error = error instanceof Error ? error.message : String(error);
      tracked.settledAt = Date.now() - startedAt;
    },
  );
  return tracked;
}

/**
 * A copilot pane the test can change, answering `/model` the way the capture
 * after it did (Issue #2623). Times are fake-clock ms from `fakePane()`.
 */
interface FakePane {
  show(frame: string): void;
  /** Show `frame` `delayMs` after `/model <model>` is typed. */
  onModel(model: string, delayMs: number, frame: string): void;
  modelSentAt: number | null;
  bodySentAt: number | null;
}

async function fakePane(initial: string): Promise<FakePane> {
  const tmux = await import('@/lib/tmux/tmux');
  const createdAt = Date.now();
  let frame = initial;
  const reactions = new Map<string, readonly [number, string]>();
  const pane: FakePane = {
    show: (next) => {
      frame = next;
    },
    onModel: (model, delayMs, next) => {
      reactions.set(`/model ${model}`, [delayMs, next]);
    },
    modelSentAt: null,
    bodySentAt: null,
  };
  vi.mocked(tmux.capturePane).mockImplementation(async () => frame);
  vi.mocked(tmux.sendKeys).mockImplementation(async (_sessionName: string, keys: string) => {
    if (keys.startsWith('/model ')) {
      pane.modelSentAt ??= Date.now() - createdAt;
      const reaction = reactions.get(keys);
      if (reaction) setTimeout(() => pane.show(reaction[1]), reaction[0]);
    } else {
      pane.bodySentAt ??= Date.now() - createdAt;
    }
  });
  return pane;
}

/** Put the tmux mocks back to the factory's answers after a {@link fakePane} test. */
async function restorePaneMocks(): Promise<void> {
  const tmux = await import('@/lib/tmux/tmux');
  vi.mocked(tmux.capturePane).mockResolvedValue('');
  vi.mocked(tmux.sendKeys).mockResolvedValue(undefined);
}

describe('CopilotTool', () => {
  let tool: CopilotTool;

  beforeEach(() => {
    tool = new CopilotTool();
    vi.clearAllMocks();
  });

  describe('Tool properties', () => {
    it('should have correct id', () => {
      expect(tool.id).toBe('copilot');
    });

    it('should have correct name', () => {
      expect(tool.name).toBe('Copilot');
    });

    // Issue #1907: was 'gh', from the days when copilot was the `gh-copilot`
    // extension. Copilot CLI is a standalone executable.
    it('should have correct command (copilot)', () => {
      expect(tool.command).toBe('copilot');
    });

    it('should have CLIToolType as id type', () => {
      const id: CLIToolType = tool.id;
      expect(id).toBe('copilot');
    });
  });

  describe('getSessionName', () => {
    it('should generate session name with correct format', () => {
      const sessionName = tool.getSessionName('feature-foo');
      expect(sessionName).toBe('mcbd-copilot-feature-foo');
    });

    it('should throw error for worktree id with slashes (security)', () => {
      expect(() => tool.getSessionName('feature/issue/123')).toThrow(/Invalid session name format/);
    });
  });

  // Issue #1907: `isInstalled` is now the resolver's answer and nothing else.
  // The resolution rules themselves (PATH first, gh's downloaded copy second,
  // a version string required) live in copilot-install-detection-1907.test.ts,
  // where they run against real temp directories.
  describe('isInstalled', () => {
    it('should return true when a copilot executable answered --version', async () => {
      vi.mocked(resolveCopilotExecutable).mockResolvedValue({
        path: '/usr/local/bin/copilot',
        version: '1.0.80',
        source: 'path',
      });

      await expect(tool.isInstalled()).resolves.toBe(true);
    });

    it('should return false when nothing answered', async () => {
      vi.mocked(resolveCopilotExecutable).mockResolvedValue(null);

      await expect(tool.isInstalled()).resolves.toBe(false);
    });
  });

  describe('isRunning', () => {
    it('should check if session is running', async () => {
      const running = await tool.isRunning('test-worktree');
      expect(typeof running).toBe('boolean');
    });

    it('should return false for non-existent session', async () => {
      const running = await tool.isRunning('non-existent-worktree-xyz');
      expect(running).toBe(false);
    });
  });

  describe('Interface implementation', () => {
    it('should implement all required methods', () => {
      expect(typeof tool.isInstalled).toBe('function');
      expect(typeof tool.isRunning).toBe('function');
      expect(typeof tool.startSession).toBe('function');
      expect(typeof tool.sendMessage).toBe('function');
      expect(typeof tool.killSession).toBe('function');
      expect(typeof tool.getSessionName).toBe('function');
    });

    it('should have readonly properties', () => {
      expect(tool.id).toBe('copilot');
      expect(tool.name).toBe('Copilot');
      expect(tool.command).toBe('copilot');
    });
  });

  describe('extractSlashCommand (via sendMessage behavior)', () => {
    it('should recognize /model as a selection list command', () => {
      // Access private method via any cast for testing
      const extract = (tool as unknown as { extractSlashCommand(m: string): string | null }).extractSlashCommand;
      expect(extract.call(tool, '/model')).toBe('model');
      expect(extract.call(tool, '/agent')).toBe('agent');
      expect(extract.call(tool, '/theme')).toBe('theme');
    });

    it('should return null for non-slash messages', () => {
      const extract = (tool as unknown as { extractSlashCommand(m: string): string | null }).extractSlashCommand;
      expect(extract.call(tool, 'hello world')).toBeNull();
      expect(extract.call(tool, '')).toBeNull();
    });

    it('should extract command name from slash command with args', () => {
      const extract = (tool as unknown as { extractSlashCommand(m: string): string | null }).extractSlashCommand;
      expect(extract.call(tool, '/help commands')).toBe('help');
      expect(extract.call(tool, '/compact  ')).toBe('compact');
    });
  });

  describe('sendModelCommand', () => {
    it('should be a public method', () => {
      expect(typeof tool.sendModelCommand).toBe('function');
    });

    it('should throw if session does not exist', async () => {
      const { hasSession } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(false);

      await expect(tool.sendModelCommand('test-wt', 'gpt-5-mini'))
        .rejects.toThrow(/does not exist/);
    });

    it('should send /model command and Enter to session', async () => {
      vi.useFakeTimers();

      const { hasSession, sendKeys } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);
      const pane = await fakePane(FRAMES.SWITCH_BEFORE());
      pane.onModel('gpt-5.6-terra', 300, FRAMES.SWITCH_AFTER());

      const run = track(tool.sendModelCommand('test-wt', 'gpt-5.6-terra'));
      await vi.advanceTimersByTimeAsync(2000);

      expect(run.state).toBe('resolved');
      expect(sendKeys).toHaveBeenCalledWith(
        'mcbd-copilot-test-wt',
        '/model gpt-5.6-terra',
        true
      );

      vi.useRealTimers();
      await restorePaneMocks();
    });

    it('should never send a bare Enter after an argument-form /model (Issue #1895)', async () => {
      vi.useFakeTimers();

      // `/model <id>` switches in place and prints `● Model changed from … for
      // this session.` — measured on 1.0.80 and captured as
      // `copilot-picker-1895/model-arg-immediate.txt`. No picker is ever drawn.
      //
      // The pane is nonetheless mocked as a picker here, which is the strongest
      // form of the assertion: even if copilot DID somehow show one, the
      // argument form must not answer it on the operator's behalf. The old code
      // waited 5s for exactly this screen and then sent `C-m` into it. Since
      // Issue #2623 a picker is not an idle copilot, so `/model` is not even
      // typed into it.
      const { hasSession, capturePane, sendKeys, sendSpecialKey } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue(
        [
          '   Recommended models',
          ' ❯  Search models…',
          ' ↑/↓ to navigate · enter to select · esc to cancel',
        ].join('\n'),
      );

      const run = track(tool.sendModelCommand('test-wt', 'gpt-5-mini'));
      await vi.advanceTimersByTimeAsync(40000);

      expect(run.state).toBe('rejected');
      expect(sendSpecialKey).not.toHaveBeenCalledWith('mcbd-copilot-test-wt', 'C-m');
      expect(sendKeys).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  /**
   * Issue #2623: `send --agent copilot --model <id>` started copilot, typed
   * `/model`, and typed the body 0.3 s later — and the body never ran. The wait
   * between the two was "is a composer on screen", which copilot 1.0.85 answers
   * yes to before it has finished loading, during a switch and after it, so it
   * returned in 22 ms. Every frame below is a live 1.0.85 capture
   * (`tests/fixtures/copilot-model-switch-2623.ts`); the `BOOT_*` ones come from
   * separate launches of the same build.
   */
  describe('sendModelCommand waits for copilot, then for its answer (Issue #2623)', () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      const { hasSession } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);
    });

    afterEach(async () => {
      vi.useRealTimers();
      await restorePaneMocks();
    });

    it('does not type /model while copilot is still loading, and returns on the switch row', async () => {
      const pane = await fakePane(FRAMES.BOOT_LOADING());
      setTimeout(() => pane.show(FRAMES.BOOT_IDLE()), 3000);
      pane.onModel('claude-sonnet-5', 400, FRAMES.BOOT_SWITCHED_IDLE());

      const run = track(tool.sendModelCommand('wt', 'claude-sonnet-5'));
      await vi.advanceTimersByTimeAsync(2900);
      expect(pane.modelSentAt).toBeNull();

      await vi.advanceTimersByTimeAsync(3000);
      expect(pane.modelSentAt).toBeGreaterThanOrEqual(3000);
      expect(run.state).toBe('resolved');
      expect(run.settledAt).toBeGreaterThanOrEqual((pane.modelSentAt ?? 0) + 400);
    });

    it('is not satisfied by the composer coming back: it waits for the row', async () => {
      // The old wait's exit condition holds on every one of these reads.
      const pane = await fakePane(FRAMES.SWITCH_BEFORE());
      pane.onModel('gpt-5.6-terra', 1200, FRAMES.SWITCH_AFTER());

      const run = track(tool.sendModelCommand('wt', 'gpt-5.6-terra'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(run.state).toBe('pending');

      await vi.advanceTimersByTimeAsync(1000);
      expect(run.state).toBe('resolved');
    });

    it('waits for a NEW row when the pane already holds an answer for that id', async () => {
      // SWITCH_AFTER already reads `… to gpt-5.6-terra (medium) …`.
      const pane = await fakePane(FRAMES.SWITCH_AFTER());
      pane.onModel('gpt-5.6-terra', 500, FRAMES.SAME_MODEL_AFTER());

      const run = track(tool.sendModelCommand('wt', 'gpt-5.6-terra'));
      await vi.advanceTimersByTimeAsync(400);
      expect(run.state).toBe('pending');

      await vi.advanceTimersByTimeAsync(1000);
      expect(run.state).toBe('resolved');
    });

    it.each([
      ['claude-opus-4.6', 'UNSUPPORTED_BEFORE', 'UNSUPPORTED_AFTER', 'Model "claude-opus-4.6" is unsupported.'],
      ['claude-opus-5', 'UNAVAILABLE_BEFORE', 'UNAVAILABLE_AFTER', 'Model "claude-opus-5" is unavailable.'],
    ] as const)('reports a refused id (%s) in copilot\'s words and types nothing else', async (model, before, after, words) => {
      const tmux = await import('@/lib/tmux/tmux');
      const pane = await fakePane(FRAMES[before]());
      pane.onModel(model, 400, FRAMES[after]());

      const run = track(tool.sendModelCommand('wt', model));
      await vi.advanceTimersByTimeAsync(2000);

      expect(run.state).toBe('rejected');
      expect(run.error).toBe(`Failed to switch Copilot model to ${model}: copilot refused it: ${words}`);
      expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
      expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
      expect(tmux.sendSpecialKeys).not.toHaveBeenCalled();
    });

    it('does not type /model into a running turn: it waits for the turn to end', async () => {
      // Measured: `/model` sent 1.6 s into a turn switched with NO row at all
      // (WORKING_SWITCHED_SILENTLY / WORKING_SWITCH_TURN_ENDED), so there would
      // have been nothing to wait for. After the turn it prints one.
      const pane = await fakePane(FRAMES.WORKING_SWITCHED_SILENTLY());
      setTimeout(() => pane.show(FRAMES.WORKING_SWITCH_TURN_ENDED()), 10_000);
      pane.onModel('claude-haiku-4.5', 400, FRAMES.BUSY_SWITCH_AFTER_TURN());

      const run = track(tool.sendModelCommand('wt', 'claude-haiku-4.5'));
      await vi.advanceTimersByTimeAsync(9_900);
      expect(pane.modelSentAt).toBeNull();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(pane.modelSentAt).toBeGreaterThanOrEqual(10_000);
      expect(run.state).toBe('resolved');
    });

    it.each([
      ['still loading', 'BOOT_LOADING', 'Loading: 6 hooks, 16 skills'],
      ['holding text in the composer', 'IDLE_COMPOSER_HOLDS_TEXT', '@ files · # issues'],
    ] as const)('refuses without typing anything when copilot is %s for the whole window', async (_label, frame, shown) => {
      const tmux = await import('@/lib/tmux/tmux');
      await fakePane(FRAMES[frame]());

      const run = track(tool.sendModelCommand('wt', 'claude-sonnet-5'));
      await vi.advanceTimersByTimeAsync(COPILOT_MODEL_SWITCH_TIMEOUT_MS + 1000);

      expect(run.state).toBe('rejected');
      expect(run.error).toContain(
        `copilot did not become idle within ${COPILOT_MODEL_SWITCH_TIMEOUT_MS}ms, so /model was not sent`
      );
      expect(run.error).toContain(shown);
      expect(tmux.sendKeys).not.toHaveBeenCalled();
    });

    it('fails, rather than proceeds, when no answer ever arrives', async () => {
      // SWITCH_BEFORE already holds one row for claude-sonnet-5; the count never moves.
      const tmux = await import('@/lib/tmux/tmux');
      await fakePane(FRAMES.SWITCH_BEFORE());

      const run = track(tool.sendModelCommand('wt', 'claude-sonnet-5'));
      await vi.advanceTimersByTimeAsync(COPILOT_MODEL_SWITCH_TIMEOUT_MS - 1000);
      expect(run.state).toBe('pending');

      await vi.advanceTimersByTimeAsync(2000);
      expect(run.state).toBe('rejected');
      expect(run.error).toContain(
        `copilot printed no answer to /model within ${COPILOT_MODEL_SWITCH_TIMEOUT_MS}ms`
      );
      expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendMessage waits out the start-up row (Issue #2623)', () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      const { hasSession } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);
    });

    afterEach(async () => {
      vi.useRealTimers();
      await restorePaneMocks();
    });

    it('types the body only once loading has ended', async () => {
      const pane = await fakePane(FRAMES.BOOT_LOADING());
      setTimeout(() => pane.show(FRAMES.BOOT_IDLE()), 3000);

      const run = track(tool.sendMessage('wt', 'hello'));
      await vi.advanceTimersByTimeAsync(2900);
      expect(pane.bodySentAt).toBeNull();

      await vi.advanceTimersByTimeAsync(3000);
      expect(pane.bodySentAt).toBeGreaterThanOrEqual(3000);
      expect(run.state).toBe('resolved');
    });

    it('still sends into a running turn at once, as before', async () => {
      // Only the start-up row holds a plain send; `waitForPrompt` has always
      // returned on a working copilot's composer (#1906's measurement).
      const pane = await fakePane(FRAMES.WORKING_SWITCHED_SILENTLY());

      const run = track(tool.sendMessage('wt', 'hello'));
      await vi.advanceTimersByTimeAsync(2000);

      expect(pane.bodySentAt).not.toBeNull();
      expect(pane.bodySentAt).toBeLessThan(100);
      expect(run.state).toBe('resolved');
    });
  });

  describe('reading /model answers (Issue #2623)', () => {
    it.each([
      ['BOOT_LOADING', true],
      ['BOOT_SWITCH_HELD_WHILE_LOADING', true],
      ['BOOT_IDLE', false],
      ['BOOT_IDLE_MCP_RELOADED', false],
      ['BOOT_SWITCHED_IDLE', false],
      ['BOOT_BODY_STUCK_BEHIND_SWITCH', false],
      ['WORKING_SWITCHED_SILENTLY', false],
      ['SWITCH_AFTER', false],
    ] as const)('isCopilotStartupLoading(%s) is %s', (frame, expected) => {
      expect(isCopilotStartupLoading(FRAMES[frame]().split('\n'))).toBe(expected);
    });

    it('reads only the bottom row for the start-up state', () => {
      // A reply that prints the start-up row's wording must not hold a send.
      const lines = FRAMES.BOOT_IDLE().split('\n');
      lines[20] = ' ● Loading: 6 hooks, 16 skills';
      expect(isCopilotStartupLoading(lines)).toBe(false);
    });

    it.each([
      ['SWITCH_BEFORE', 'SWITCH_AFTER', 'gpt-5.6-terra', { kind: 'switched' }],
      // The label turns first; that is not the answer.
      ['SWITCH_BEFORE', 'SWITCH_LABEL_FIRST', 'gpt-5.6-terra', { kind: 'pending' }],
      ['SAME_MODEL_BEFORE', 'SAME_MODEL_AFTER', 'gpt-5.6-terra', { kind: 'switched' }],
      ['UNSUPPORTED_BEFORE', 'UNSUPPORTED_AFTER', 'claude-opus-4.6',
        { kind: 'rejected', reason: 'Model "claude-opus-4.6" is unsupported.' }],
      ['UNAVAILABLE_BEFORE', 'UNAVAILABLE_AFTER', 'claude-opus-5',
        { kind: 'rejected', reason: 'Model "claude-opus-5" is unavailable.' }],
      // The two answers above list valid ids (`   - "claude-sonnet-5"`); those rows are not answers.
      ['UNSUPPORTED_BEFORE', 'UNSUPPORTED_AFTER', 'claude-sonnet-5', { kind: 'pending' }],
      ['UNSUPPORTED_BEFORE', 'UNSUPPORTED_AFTER', 'claude-opus-5', { kind: 'pending' }],
      // An id that is a prefix of the switched-to id is not the switched-to id.
      ['SWITCH_BEFORE', 'SWITCH_AFTER', 'gpt-5', { kind: 'pending' }],
      ['SWITCH_BEFORE', 'SWITCH_AFTER', 'gpt-5.6', { kind: 'pending' }],
      // A row already on screen is not an answer to this command.
      ['SWITCH_AFTER', 'SAME_MODEL_BEFORE', 'gpt-5.6-terra', { kind: 'pending' }],
      // A switch made during a turn prints nothing.
      ['UNAVAILABLE_AFTER', 'WORKING_SWITCHED_SILENTLY', 'claude-haiku-4.5', { kind: 'pending' }],
      ['UNAVAILABLE_AFTER', 'WORKING_SWITCH_TURN_ENDED', 'claude-haiku-4.5', { kind: 'pending' }],
    ] as const)('%s -> %s for %s', (before, after, model, expected) => {
      const baseline = readCopilotModelSwitchOutcomes(FRAMES[before](), model);
      expect(judgeCopilotModelSwitch(baseline, FRAMES[after](), model)).toEqual(expected);
    });

    it('counts the success row with and without the effort suffix, and 1.0.80\'s longer one', () => {
      expect(readCopilotModelSwitchOutcomes(FRAMES.BUSY_SWITCH_AFTER_TURN(), 'claude-haiku-4.5').switched).toBe(1);
      expect(readCopilotModelSwitchOutcomes(FRAMES.BOOT_SWITCHED_IDLE(), 'claude-sonnet-5').switched).toBe(1);

      // `● Model changed from gpt-5.6-terra (xhigh) to gpt-5-mini (medium) for this
      // session. Use /config to set default`, with its ANSI still on.
      const frame1080 = readFileSync(
        path.resolve(__dirname, '../lib/detection/fixtures/copilot-picker-1895/model-arg-immediate.txt'),
        'utf8'
      );
      expect(frame1080).toContain('\x1b[');
      expect(readCopilotModelSwitchOutcomes(frame1080, 'gpt-5-mini')).toEqual({ switched: 1, rejected: [] });
      expect(readCopilotModelSwitchOutcomes(frame1080, 'gpt-5').switched).toBe(0);
    });

    it('matches the id literally and never reads the composer', () => {
      const frame = [
        ' ● Model changed from gpt-5.6-terra (xhigh) to gpt-5x6-terra (medium) for this session',
        '❯ /model gpt-5.6-terra',
        '❯ ● Switched model to: gpt-5.6-terra',
      ].join('\n');
      expect(readCopilotModelSwitchOutcomes(frame, 'gpt-5.6-terra')).toEqual({ switched: 0, rejected: [] });
      expect(readCopilotModelSwitchOutcomes(frame, 'gpt-5x6-terra').switched).toBe(1);
    });
  });

  describe('waitForSelectionList returns boolean', () => {
    it('should return true when selection list is detected', async () => {
      const { hasSession, capturePane } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);
      // The picker's key-hint footer at the bottom of the pane — the only thing
      // `isCopilotSelectionFrame` reads (Issue #1895). `Search models…` alone is
      // deliberately NOT enough any more.
      vi.mocked(capturePane).mockResolvedValue(
        [
          '   Recommended models',
          ' ❯  Search models…',
          ' ↑/↓ to navigate · enter to select · esc to cancel',
        ].join('\n'),
      );

      // Access private method for testing
      const waitForSelectionList = (tool as unknown as {
        waitForSelectionList(s: string): Promise<boolean>
      }).waitForSelectionList;

      const result = await waitForSelectionList.call(tool, 'mcbd-copilot-test');
      expect(result).toBe(true);
    });

    it('should return false when selection list times out', async () => {
      vi.useFakeTimers();

      const { capturePane } = await import('@/lib/tmux/tmux');
      vi.mocked(capturePane).mockResolvedValue('some other output');

      const waitForSelectionList = (tool as unknown as {
        waitForSelectionList(s: string): Promise<boolean>
      }).waitForSelectionList;

      const promise = waitForSelectionList.call(tool, 'mcbd-copilot-test');

      // Advance timers past the 5s timeout
      await vi.advanceTimersByTimeAsync(6000);

      const result = await promise;
      expect(result).toBe(false);

      vi.useRealTimers();
    });
  });

  /**
   * Issue #1905. Until this Issue nothing reached this method from the product:
   * `POST /api/worktrees/:id/kill-session` called `lib/tmux`'s `killSession`
   * directly and the Assistant session route (the only other caller) does not
   * allow copilot. Both defects below are therefore first-time regressions,
   * pinned against measurements on GitHub Copilot CLI 1.0.80.
   */
  describe('killSession (Issue #1905)', () => {
    async function runKill(): Promise<{
      sendKeys: ReturnType<typeof vi.fn>;
      sendSpecialKey: ReturnType<typeof vi.fn>;
      sendSpecialKeys: ReturnType<typeof vi.fn>;
      killSession: ReturnType<typeof vi.fn>;
    }> {
      const tmux = await import('@/lib/tmux/tmux');
      vi.mocked(tmux.hasSession).mockResolvedValue(true);
      vi.useFakeTimers();
      const promise = tool.killSession('feature-foo');
      await vi.runAllTimersAsync();
      await promise;
      vi.useRealTimers();
      return tmux as unknown as {
        sendKeys: ReturnType<typeof vi.fn>;
        sendSpecialKey: ReturnType<typeof vi.fn>;
        sendSpecialKeys: ReturnType<typeof vi.fn>;
        killSession: ReturnType<typeof vi.fn>;
      };
    }

    /**
     * The body used to be the bare word `exit` batched with its Enter into one
     * `send-keys exit C-m`. Measured on 1.0.80, that spelling does end the
     * process — the Issue's premise that it only becomes a chat message is
     * wrong for this version — but it is indistinguishable from a prompt and
     * the batched form is the shape #1471 removed everywhere else.
     */
    it('types the slash exit command without batching Enter into it', async () => {
      const { sendKeys } = await runKill();

      expect(sendKeys).toHaveBeenCalledWith('mcbd-copilot-feature-foo', COPILOT_EXIT_COMMAND, false);
      expect(COPILOT_EXIT_COMMAND).toBe('/exit');
      // No `sendEnter: true` batch, and no bare `exit` body, anywhere.
      for (const call of sendKeys.mock.calls) {
        expect(call[2]).toBe(false);
        expect(call[1]).not.toBe('exit');
      }
    });

    it('submits with a separate Enter, after the body and after the interrupt', async () => {
      const { sendSpecialKey, sendSpecialKeys } = await runKill();

      expect(sendSpecialKey).toHaveBeenCalledWith('mcbd-copilot-feature-foo', 'C-c');
      expect(sendSpecialKeys).toHaveBeenCalledWith('mcbd-copilot-feature-foo', ['Enter']);
      expect(sendSpecialKey.mock.invocationCallOrder[0]).toBeLessThan(
        sendSpecialKeys.mock.invocationCallOrder[0]
      );
    });

    /**
     * The wait between the submit and the tmux kill. 11 samples of copilot
     * 1.0.80's shutdown ran 1.006 s to 2.193 s, so the generic
     * `TUI_EXIT_WAIT_MS` (500) guaranteed the kill landed mid-shutdown. Held to
     * the measurement rather than to the constant's identity, so lowering the
     * constant back under a second fails here.
     */
    it('waits longer than the slowest measured shutdown before force-killing', () => {
      expect(COPILOT_EXIT_WAIT_MS).toBeGreaterThan(2193);
      expect(COPILOT_EXIT_WAIT_MS).toBeGreaterThan(TUI_EXIT_WAIT_MS);
    });

    it('still force-kills the tmux session as the fallback', async () => {
      const { killSession } = await runKill();
      expect(killSession).toHaveBeenCalledWith('mcbd-copilot-feature-foo');
    });

    it('does not touch the pane when there is no session to exit', async () => {
      const tmux = await import('@/lib/tmux/tmux');
      vi.mocked(tmux.hasSession).mockResolvedValue(false);

      await tool.killSession('feature-foo');

      expect(tmux.sendKeys).not.toHaveBeenCalled();
      expect(tmux.sendSpecialKeys).not.toHaveBeenCalled();
      expect(tmux.killSession).toHaveBeenCalledWith('mcbd-copilot-feature-foo');
    });
  });
});
