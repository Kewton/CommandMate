/**
 * Issue #2317 Phase A/D — `commandmate attach <worktree-id>`.
 *
 * The command exists because three separate things went wrong when people
 * attached by hand, and each one has its own assertion here:
 *
 *  - the session NAME had to be assembled from a naming rule and a roster;
 *  - `tmux attach -t =mcbd-…:` is eaten by zsh's equals expansion before tmux
 *    ever runs (measured, and in the Issue), so the target has to be passed as
 *    argv rather than through a shell;
 *  - a bare attach to an alternate-screen agent shows the composer and blank
 *    rows and NOTHING ELSE, which reads as a broken session rather than as the
 *    1000-row canvas it is.
 *
 * `--live` is asserted in both directions: the hand-over runs for claude, and it
 * is REFUSED for every other agent — the refusal is the acceptance condition,
 * because a silent no-op would look like a working feature that does nothing.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '@/cli/types';
import { buildAttachHints } from '@/cli/commands/attach';
import {
  buildDelegateGeometryCommands,
  buildRestoreGeometryCommands,
} from '@/lib/session/tmux-session-surface';

/** Every tmux argv the command runs, in order. */
const tmuxCalls: string[][] = [];
/** Exit status each `spawnSync` reports, keyed by the tmux subcommand. */
let tmuxStatus: (argv: string[]) => number = () => 0;

vi.mock('child_process', () => ({
  spawnSync: (_cmd: string, argv: string[]) => {
    tmuxCalls.push(argv);
    return { status: tmuxStatus(argv) };
  },
}));

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

function resolveTarget(cliToolId: string, instanceId = cliToolId) {
  return { data: { cliToolId, instanceId, resolvedBy: 'worktree-default', conflict: null } };
}

async function runAttach(argv: string[]): Promise<void> {
  const { createAttachCommand } = await import('@/cli/commands/attach');
  try {
    await createAttachCommand().parseAsync(['node', 'attach', ...argv]);
  } catch (error) {
    // `process.exit` is stubbed to throw so the action stops where it would.
    if ((error as Error).message !== 'process.exit') throw error;
  }
}

function stderr(): string {
  return mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');
}

beforeEach(() => {
  tmuxCalls.length = 0;
  tmuxStatus = () => 0;
  delete process.env.TMUX;
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleError.mockClear();
});

describe('resolving and attaching', () => {
  it('attaches to the session the roster names, with the exact-match target', async () => {
    mockFetchSequence([resolveTarget('claude')]);

    await runAttach(['wt1']);

    // `=name:` and not `name`: `mcbd-claude-wt1` is a prefix of
    // `mcbd-claude-wt1-2`, so a fuzzy target attaches to the wrong instance
    // (Issue #1156). Passed as ONE argv element, which is what makes zsh's
    // equals expansion irrelevant — there is no shell in the path at all.
    expect(tmuxCalls).toContainEqual(['has-session', '-t', '=mcbd-claude-wt1:']);
    expect(tmuxCalls).toContainEqual(['attach-session', '-t', '=mcbd-claude-wt1:']);
  });

  it('attaches to an alias instance session, not the primary one', async () => {
    mockFetchSequence([resolveTarget('codex', 'codex-2')]);

    await runAttach(['wt1', '--instance', 'codex-2']);

    expect(tmuxCalls).toContainEqual(['attach-session', '-t', '=mcbd-codex-wt1-2:']);
  });

  it('adds -r for --read-only', async () => {
    mockFetchSequence([resolveTarget('claude')]);

    await runAttach(['wt1', '--read-only']);

    expect(tmuxCalls).toContainEqual(['attach-session', '-r', '-t', '=mcbd-claude-wt1:']);
  });

  it('exits non-zero and points at `ls` when the session is not there', async () => {
    mockFetchSequence([resolveTarget('claude')]);
    tmuxStatus = (argv) => (argv[0] === 'has-session' ? 1 : 0);

    await runAttach(['wt1']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    expect(stderr()).toContain('no tmux session named mcbd-claude-wt1');
    expect(stderr()).toContain('commandmate ls');
    // And it never tried to attach to a session that is not there.
    expect(tmuxCalls.some((argv) => argv[0] === 'attach-session')).toBe(false);
  });

  it('switches the current client instead of nesting when already inside tmux', async () => {
    process.env.TMUX = '/tmp/tmux-501/default,123,0';
    mockFetchSequence([resolveTarget('claude')]);

    await runAttach(['wt1']);

    expect(tmuxCalls).toContainEqual(['switch-client', '-t', '=mcbd-claude-wt1:']);
    expect(tmuxCalls.some((argv) => argv[0] === 'attach-session')).toBe(false);
  });

  it('prints the quoted manual command when the switch fails', async () => {
    // The ambient `$TMUX` is a DIFFERENT tmux server — which is the case every
    // CommandMate agent runs under.
    process.env.TMUX = '/tmp/tmux-501/other,123,0';
    mockFetchSequence([resolveTarget('claude')]);
    tmuxStatus = (argv) => (argv[0] === 'switch-client' ? 1 : 0);

    await runAttach(['wt1']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    // Quoted, because an unquoted `=mcbd-…` is an equals expansion in zsh and
    // fails with `not found` before tmux is reached.
    expect(stderr()).toContain(`tmux attach -t '=mcbd-claude-wt1:'`);
  });
});

describe('--live', () => {
  it('hands the geometry over, attaches, and hands it back', async () => {
    mockFetchSequence([resolveTarget('claude')]);

    await runAttach(['wt1', '--live']);

    const delegate = buildDelegateGeometryCommands('mcbd-claude-wt1');
    const restore = buildRestoreGeometryCommands('mcbd-claude-wt1');
    for (const argv of [...delegate, ...restore]) {
      expect(tmuxCalls).toContainEqual(argv);
    }

    // Order: everything is handed over before the attach and taken back after.
    const attachAt = tmuxCalls.findIndex((argv) => argv[0] === 'attach-session');
    const overAt = tmuxCalls.findIndex((argv) => argv[4] === 'latest');
    const backAt = tmuxCalls.findIndex((argv) => argv[4] === 'manual');
    expect(overAt).toBeGreaterThanOrEqual(0);
    expect(overAt).toBeLessThan(attachAt);
    expect(backAt).toBeGreaterThan(attachAt);
  });

  it('hands the geometry back even when tmux exits non-zero', async () => {
    mockFetchSequence([resolveTarget('claude')]);
    tmuxStatus = (argv) => (argv[0] === 'attach-session' ? 1 : 0);

    await runAttach(['wt1', '--live']);

    expect(tmuxCalls).toContainEqual([
      'set-option', '-u', '-t', '=mcbd-claude-wt1:', '@cm_delegated',
    ]);
  });

  it('is REFUSED for every agent but claude', async () => {
    // Not a silent no-op: the detection rules of the other six were measured at
    // 200x1000 and nowhere else, and three of them have no source for a reply
    // except the pane itself.
    mockFetchSequence([resolveTarget('codex')]);

    await runAttach(['wt1', '--live']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(stderr()).toContain('--live is not supported for codex');
    expect(tmuxCalls.some((argv) => argv.includes('latest'))).toBe(false);
    expect(tmuxCalls.some((argv) => argv[0] === 'attach-session')).toBe(false);
  });
});

describe('the hint printed before the terminal is handed to tmux', () => {
  it('explains why an alt-screen session looks empty, and names three ways to read', () => {
    const hints = buildAttachHints('claude', 'wt1', 'mcbd-claude-wt1', {}).join('\n');

    expect(hints).toContain('prefix + g');
    expect(hints).toContain('commandmate capture wt1 --pane --tail 60');
    expect(hints).toContain('commandmate capture wt1 --pane --follow');
    expect(hints).toContain('commandmate attach wt1 --live');
    expect(hints).toContain("tmux ls -F '#{session_name} #{@cm_status}'");
  });

  it('says nothing about blank rows for an inline agent', () => {
    // codex renders inline: the bottom of the canvas IS the latest transcript,
    // so the warning would be false.
    const hints = buildAttachHints('codex', 'wt1', 'mcbd-codex-wt1', {}).join('\n');
    expect(hints).not.toContain('prefix + g');
    expect(hints).toContain('Detach with Ctrl+b then d');
  });

  it('offers --live only for the agent that supports it', () => {
    expect(buildAttachHints('opencode', 'wt1', 'mcbd-opencode-wt1', {}).join('\n')).not.toContain(
      '--live',
    );
  });

  it('warns that prefix + g cannot work under --read-only', () => {
    // Measured: tmux delivers no keys but the detach one to a read-only client,
    // so the popup binding is inert there and the key looks broken.
    const hints = buildAttachHints('claude', 'wt1', 'mcbd-claude-wt1', { readOnly: true }).join('\n');
    expect(hints).toContain('prefix + g does NOT open');
    expect(hints).toContain('--pane --follow');
  });

  it('says what --live will do to the web terminal', () => {
    const hints = buildAttachHints('claude', 'wt1', 'mcbd-claude-wt1', { live: true }).join('\n');
    expect(hints).toContain('200x1000');
    expect(hints).toContain('web terminal');
  });
});
