/**
 * Issue #2878: argument parsing, start-up dialog navigation and the screen
 * expectations of agent-health.
 */

import { describe, expect, it } from 'vitest';
import { parseAgentHealthArgs } from '@/lib/agent-health/cli-args';
import { selectionKeys } from '@/lib/agent-health/dialog-select';
import { countMatches, evaluateScreen, type ScreenVerdict } from '@/lib/agent-health/screen-checks';
import { AGENT_HEALTH_CHECK_IDS, AGENT_HEALTH_TOOLS } from '@/lib/agent-health/types';

describe('parseAgentHealthArgs', () => {
  it('defaults: all tools, all checks, 150 s per tool', () => {
    const parsed = parseAgentHealthArgs([]);
    expect(parsed).toEqual({
      ok: true,
      options: {
        tools: [...AGENT_HEALTH_TOOLS],
        checks: [...AGENT_HEALTH_CHECK_IDS],
        out: null,
        timeoutPerToolSec: 150,
        statePath: null,
        serverLog: null,
      },
    });
  });

  it('--tools keeps report order and --only always keeps version', () => {
    const parsed = parseAgentHealthArgs(['--tools', 'codex,claude', '--only=screen-idle', '--timeout-per-tool', '60']);
    expect(parsed.ok && parsed.options.tools).toEqual(['claude', 'codex']);
    expect(parsed.ok && parsed.options.checks).toEqual(['version', 'screen-idle']);
    expect(parsed.ok && parsed.options.timeoutPerToolSec).toBe(60);
  });

  it.each([
    [['--tools', 'gemini']],
    [['--only', 'screen-everything']],
    [['--timeout-per-tool', 'abc']],
    [['--timeout-per-tool', '5']],
    [['--out']],
    [['--bogus']],
  ])('rejects %j', (argv) => {
    const parsed = parseAgentHealthArgs(argv);
    expect(parsed.ok).toBe(false);
  });

  it('--help is not an error', () => {
    const parsed = parseAgentHealthArgs(['--help']);
    expect(parsed).toMatchObject({ ok: false, help: true });
  });
});

describe('selectionKeys', () => {
  it('moves down from a pre-selected "No, exit" (claude 2.1.283 trust screen)', () => {
    const frame = [
      ' Quick safety check: Is this a project you created or one you trust?',
      ' \u001b[36m❯ No, exit\u001b[0m',
      '   Yes, I trust this folder',
      ' Enter to confirm · Esc to cancel',
    ].join('\n');
    expect(selectionKeys(frame, /Yes, I trust this folder/)).toEqual(['Down', 'Enter']);
  });

  it('just presses Enter when the cursor is already there (antigravity)', () => {
    const frame = ['Do you trust the contents of this project?', '> Yes, I trust this folder', '  No, exit'].join('\n');
    expect(selectionKeys(frame, /Yes, I trust this folder/)).toEqual(['Enter']);
  });

  it('moves up when the option is above the cursor', () => {
    const frame = ['  1. Trust and continue', '› 2. Quit'].join('\n');
    expect(selectionKeys(frame, /Trust and continue/)).toEqual(['Up', 'Enter']);
  });

  it('returns null when the option is not on screen', () => {
    expect(selectionKeys('❯ something', /Yes, I trust/)).toBeNull();
  });
});

const verdict = (overrides: Partial<ScreenVerdict>): ScreenVerdict => ({
  status: 'ready',
  reason: 'input_prompt',
  hasActivePrompt: false,
  evidence: 'positive',
  ...overrides,
});

describe('evaluateScreen', () => {
  it('idle / quoted pass only on ready without an active prompt', () => {
    expect(evaluateScreen('screen-idle', verdict({}), 'x').status).toBe('pass');
    expect(evaluateScreen('screen-quoted-dialog', verdict({}), 'x').status).toBe('pass');
    const quoted = evaluateScreen(
      'screen-quoted-dialog',
      verdict({ status: 'waiting', reason: 'prompt_detected', hasActivePrompt: true }),
      'Would you like to run the following command?\n› 1. Yes, proceed (y)'
    );
    expect(quoted.status).toBe('fail');
    expect(quoted.evidence).toContain('Would you like to run');
  });

  it('running needs positive evidence, not the detector floor', () => {
    expect(evaluateScreen('screen-running', verdict({ status: 'running', reason: 'thinking_indicator' }), 'x').status).toBe(
      'pass'
    );
    expect(
      evaluateScreen('screen-running', verdict({ status: 'running', reason: 'unknown_frame', evidence: 'none' }), 'x').status
    ).toBe('fail');
  });

  it('approval needs waiting with an active prompt', () => {
    expect(
      evaluateScreen('screen-approval', verdict({ status: 'waiting', reason: 'prompt_detected', hasActivePrompt: true }), 'x')
        .status
    ).toBe('pass');
    expect(evaluateScreen('screen-approval', verdict({}), 'x').status).toBe('fail');
  });

  it('countMatches counts every occurrence in the stripped text', () => {
    expect(countMatches('Run this command?\n…\nRun this command?', /Run this command\?/)).toBe(2);
    expect(countMatches('nothing', /Run this command\?/)).toBe(0);
  });
});
