/**
 * The graceful-exit contract and its postcondition (Issue #1933, 受入条件 S10).
 *
 * Two properties, and they are different in kind:
 *
 *  1. **the declaration** — every tool answers `gracefulExitSequence()` with the
 *     keystrokes, the shutdown window and the port question that its own
 *     measurements produced. `graceful-exit-conformance-1933.test.ts` is what
 *     keeps the declaration equal to what `killSession()` actually sends;
 *     this file pins the values.
 *  2. **the postcondition** — `verifyGracefulExit()` reports
 *     `graceful_exit_timeout` when the pane outlived the exit command and
 *     `port_orphaned` when the pane is gone but opencode's loopback server is
 *     still answering. The second one has no other detector anywhere: the port
 *     is handed to the next instance that asks, so an orphaned server collects
 *     that instance's subscription and files its events against the wrong
 *     worktree with no error (§13.2, #1758 §5.1.2).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveGracefulExitSpec,
  verifyGracefulExit,
  DEFAULT_GRACEFUL_EXIT_SPEC,
} from '@/lib/cli-tools/graceful-exit';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { GRACEFUL_EXIT_FAILURE_REASONS } from '@/types/cli-tool-contracts';
import {
  COPILOT_EXIT_WAIT_MS,
  OPENCODE_EXIT_WAIT_MS,
  TUI_EXIT_WAIT_MS,
  TUI_INTERRUPT_SETTLE_MS,
  TUI_TEXT_INPUT_WAIT_MS,
} from '@/config/cli-tool-timing-config';
import { COPILOT_TEXT_INPUT_DELAY_MS } from '@/config/copilot-constants';

describe('gracefulExitSequence (Issue #1933 S10)', () => {
  it('answers for every CLI tool', () => {
    for (const id of CLI_TOOL_IDS) {
      const spec = resolveGracefulExitSpec(id);
      expect(spec.keys.length).toBeGreaterThan(0);
      expect(spec.exitWaitMs).toBeGreaterThan(0);
      expect(typeof spec.ownsLoopbackServer).toBe('boolean');
    }
  });

  it('is Ctrl-D and the generic window for the three tools that just quit', () => {
    for (const id of ['claude', 'codex', 'antigravity'] as const) {
      expect(resolveGracefulExitSpec(id)).toEqual({
        keys: [{ kind: 'key', name: 'C-d' }],
        exitWaitMs: TUI_EXIT_WAIT_MS,
        ownsLoopbackServer: false,
      });
    }
    expect(resolveGracefulExitSpec('claude')).toEqual(DEFAULT_GRACEFUL_EXIT_SPEC);
  });

  /**
   * gemini is the one tool still on the pre-#1471 batched form
   * (`sendKeys('/quit', true)`), and a literal ending in CR describes that
   * faithfully: `send-keys -t X '/quit' 'C-m'` and
   * `send-keys -t X -l -- '/quit\r'` put the identical six bytes into the pty
   * in one write (`2f 71 75 69 74 0d`), measured on tmux 3.5a.
   */
  it('is Ctrl-C then a submitted /quit for gemini', () => {
    expect(resolveGracefulExitSpec('gemini')).toEqual({
      keys: [
        { kind: 'key', name: 'C-c', delayAfterMs: TUI_INTERRUPT_SETTLE_MS },
        { kind: 'literal', text: '/quit\r' },
      ],
      exitWaitMs: TUI_EXIT_WAIT_MS,
      ownsLoopbackServer: false,
    });
  });

  it('is two Ctrl-Cs for vibe-local', () => {
    expect(resolveGracefulExitSpec('vibe-local')).toEqual({
      keys: [
        { kind: 'key', name: 'C-c', delayAfterMs: TUI_INTERRUPT_SETTLE_MS },
        { kind: 'key', name: 'C-c' },
      ],
      exitWaitMs: TUI_EXIT_WAIT_MS,
      ownsLoopbackServer: false,
    });
  });

  /**
   * copilot's window is its own because every measured shutdown of 1.0.80 —
   * 1.006 / 1.109 / 1.115 / 1.118 / 1.204 / 1.208 / 1.288 / 1.330 / 1.795 /
   * 2.165 / 2.193 s — is past the generic 500 ms, i.e. the tmux kill had been
   * landing mid-shutdown for every copilot session (#1905).
   */
  it('is Ctrl-C then a separately submitted /exit for copilot, with its own window', () => {
    expect(resolveGracefulExitSpec('copilot')).toEqual({
      keys: [
        { kind: 'key', name: 'C-c', delayAfterMs: TUI_INTERRUPT_SETTLE_MS },
        { kind: 'literal', text: '/exit', delayAfterMs: COPILOT_TEXT_INPUT_DELAY_MS },
        { kind: 'key', name: 'Enter' },
      ],
      exitWaitMs: COPILOT_EXIT_WAIT_MS,
      ownsLoopbackServer: false,
    });
    expect(COPILOT_EXIT_WAIT_MS).toBeGreaterThan(TUI_EXIT_WAIT_MS);
  });

  /**
   * opencode's `/exit` and its Enter must be SEPARATE tmux commands: typing `/`
   * opens the command palette and a `C-m` arriving in the same command is
   * consumed by it, leaving `/exit` in the composer 10.8 s later, 2 runs out of
   * 2 (#1905). Which is exactly why its literal does NOT end in CR while
   * gemini's does.
   */
  it('is a separately submitted /exit for opencode, and it owns a port', () => {
    expect(resolveGracefulExitSpec('opencode')).toEqual({
      keys: [
        { kind: 'literal', text: '/exit', delayAfterMs: TUI_TEXT_INPUT_WAIT_MS },
        { kind: 'key', name: 'Enter' },
      ],
      exitWaitMs: OPENCODE_EXIT_WAIT_MS,
      ownsLoopbackServer: true,
    });
  });

  it('is the only tool that owns a loopback server', () => {
    const owners = CLI_TOOL_IDS.filter((id) => resolveGracefulExitSpec(id).ownsLoopbackServer);
    expect(owners).toEqual(['opencode']);
  });
});

describe('verifyGracefulExit (Issue #1933 S10)', () => {
  it('passes when the pane is gone and the tool owns no port', async () => {
    await expect(verifyGracefulExit({ sessionAlive: async () => false })).resolves.toEqual({
      ok: true,
    });
  });

  it('reports graceful_exit_timeout when the pane outlived the exit command', async () => {
    await expect(verifyGracefulExit({ sessionAlive: async () => true })).resolves.toEqual({
      ok: false,
      reason: 'graceful_exit_timeout',
    });
  });

  it('does not ask about the port while the pane is still up', async () => {
    const portAnswering = vi.fn(async () => false);

    const verdict = await verifyGracefulExit({
      sessionAlive: async () => true,
      portAnswering,
    });

    // A server answering while its pane is alive is a running agent, not an
    // orphan — so the question is not even asked.
    expect(verdict).toEqual({ ok: false, reason: 'graceful_exit_timeout' });
    expect(portAnswering).not.toHaveBeenCalled();
  });

  it('reports port_orphaned when the pane is gone but the server still answers', async () => {
    await expect(
      verifyGracefulExit({
        sessionAlive: async () => false,
        portAnswering: async () => true,
      })
    ).resolves.toEqual({ ok: false, reason: 'port_orphaned' });
  });

  it('passes when the pane is gone and the port has fallen silent', async () => {
    await expect(
      verifyGracefulExit({
        sessionAlive: async () => false,
        portAnswering: async () => false,
      })
    ).resolves.toEqual({ ok: true });
  });

  it('checks once by default — the same single probe killSession always made', async () => {
    const sessionAlive = vi.fn(async () => true);

    await verifyGracefulExit({ sessionAlive });

    expect(sessionAlive).toHaveBeenCalledTimes(1);
  });

  it('polls up to `attempts` times and stops as soon as the pane goes', async () => {
    const answers = [true, true, false];
    let call = 0;
    const slept: number[] = [];

    const verdict = await verifyGracefulExit({
      sessionAlive: async () => answers[call++],
      attempts: 5,
      intervalMs: 25,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(verdict).toEqual({ ok: true });
    expect(call).toBe(3);
    expect(slept).toEqual([25, 25]);
  });

  it('gives the port the same rope before calling it orphaned', async () => {
    const answers = [true, false];
    let call = 0;

    const verdict = await verifyGracefulExit({
      sessionAlive: async () => false,
      portAnswering: async () => answers[call++],
      attempts: 3,
      intervalMs: 10,
      sleep: async () => {},
    });

    expect(verdict).toEqual({ ok: true });
    expect(call).toBe(2);
  });

  it('names only reasons a caller can act on', () => {
    expect([...GRACEFUL_EXIT_FAILURE_REASONS]).toEqual([
      'graceful_exit_timeout',
      'port_orphaned',
    ]);
  });
});
