/**
 * Issue #4134: the frames the live check of Epic #4112 could not read, captured
 * on opencode 1.18.35, codex-cli 0.166.0 and Claude Code 2.1.318
 * (`tests/fixtures/{opencode-live-4134,codex-dialogs-0166,claude-auto-default-nudge-4134}`).
 *
 * @vitest-environment node
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PROMPT_PATTERN,
  getCodexActiveDialog,
  getCodexLifecycleDialog,
  isClaudeAutoDefaultNudgeOpen,
  isClaudeTrustDialogOpen,
  OPENCODE_TURN_COMPLETE_PATTERN,
  readCodexEnterConfirmedCursor,
  resolveClaudeAutoDefaultNudgeKey,
  stripAnsi,
} from '@/lib/detection/cli-patterns';
import { buildDetectPromptOptions } from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { extractModelInfo } from '@/lib/detection/model-info-extractor';

const FIXTURES = join(process.cwd(), 'tests/fixtures');
const read = (dir: string, name: string): string => readFileSync(join(FIXTURES, dir, name), 'utf8');
const codex = (name: string): string => read('codex-dialogs-0166', `${name}.txt`);
const nudge = (name: string): string => read('claude-auto-default-nudge-4134', `${name}.txt`);

describe('opencode: every duration the finished-turn row can carry', () => {
  const row = (duration: string): string => `     ▣  Build · mock-model · ${duration}`;

  it.each(['turn-done-subsecond.txt', 'turn-done-subsecond-local-model.txt'])(
    'reads the captured sub-second turn %s as finished',
    (name) => {
      const status = detectSessionStatus(read('opencode-live-4134', name), 'opencode');
      expect(status.status).toBe('ready');
      expect(status.reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
    }
  );

  it.each(['0ms', '836ms', '5.2s', '45.2s', '1m 5s', '59m 59s', '1h 5m', '2d 3h'])('accepts %s', (duration) => {
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test(row(duration))).toBe(true);
  });

  it.each(['interrupted', '836 tokens', '836msg', 'ms', '12m', ''])('does not take "%s" for a duration', (text) => {
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test(row(text))).toBe(false);
  });

  it('a step still open has no duration and is not a completion', () => {
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test('     ▣  Build · mock-model')).toBe(false);
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test('  ┃  Build · mock-model mock')).toBe(false);
  });

  it.each(['836ms', '5.2s', '1m 5s', '1h 5m', '2d 3h'])('reads the model off a row ending in %s', (duration) => {
    expect(extractModelInfo('opencode', `${row(duration)}\n`)?.model).toBe('mock-model');
  });
});

describe('codex 0.166.0: the hook review screens', () => {
  it.each([
    ['hooks-review', 'hooks-review'],
    ['hooks-review-cursor-2', 'hooks-review'],
    ['hooks-list', 'hooks-list'],
    ['hooks-detail', 'hooks-detail'],
    ['hooks-list-trusted', 'hooks-settled'],
    ['hooks-detail-trusted', 'hooks-settled'],
    ['trust', 'trust'],
    ['update', 'update'],
    ['ready', null],
  ])('%s reads as %s', (frame, expected) => {
    expect(getCodexLifecycleDialog(stripAnsi(codex(frame)))).toBe(expected);
  });

  it.each(['hooks-list', 'hooks-detail', 'hooks-list-trusted', 'hooks-detail-trusted'])(
    '%s blocks on a key, so it is waiting and not running',
    (frame) => {
      const status = detectSessionStatus(codex(frame), 'codex');
      expect(status.status).toBe('waiting');
      expect(status.reason).toBe(STATUS_REASON.CODEX_HOOKS_REVIEW);
    }
  );

  it('a footer quoted in a reply is not a hooks screen', () => {
    const pane = ['• It says:', '  t trust all · enter review · esc close', '', '› ', '  mock-model default · /repo'].join('\n');
    expect(getCodexLifecycleDialog(pane)).toBeNull();
  });

  describe('readCodexEnterConfirmedCursor', () => {
    it('names the option the cursor is on, where the footer says Enter confirms', () => {
      expect(readCodexEnterConfirmedCursor(stripAnsi(codex('hooks-review')))).toBe(1);
      expect(readCodexEnterConfirmedCursor(stripAnsi(codex('hooks-review-cursor-2')))).toBe(2);
      expect(readCodexEnterConfirmedCursor(stripAnsi(codex('trust')))).toBe(1);
    });

    it('is null on a screen where a digit confirms by itself', () => {
      const old = ['  Hooks need review', '› 1. Review hooks', '  2. Trust all and continue', "  3. Continue without trusting (hooks won't run)", '  Press enter to confirm or esc to go back'];
      expect(readCodexEnterConfirmedCursor(old.join('\n'))).toBeNull();
      // Measured: the digit alone answers the update offer on 0.166.0, under a footer of the same shape.
      expect(readCodexEnterConfirmedCursor(stripAnsi(codex('update')))).toBeNull();
    });

    it('is null without a dialog on screen', () => {
      expect(readCodexEnterConfirmedCursor(stripAnsi(codex('ready')))).toBeNull();
      expect(readCodexEnterConfirmedCursor(['  enter confirm · esc skip', '› '].join('\n'))).toBeNull();
    });
  });

  it('still calls the trust dialog what the launch calls it', () => {
    expect(getCodexActiveDialog(stripAnsi(codex('trust')))).toBe('trust');
  });
});

describe('Claude Code 2.1.318: Make auto mode your default permission mode?', () => {
  it('is open in both captures, and neither reads as a ready prompt or the trust dialog', () => {
    for (const name of ['cursor-yes', 'cursor-no']) {
      const frame = stripAnsi(nudge(name));
      expect(isClaudeAutoDefaultNudgeOpen(frame)).toBe(true);
      expect(CLAUDE_PROMPT_PATTERN.test(frame)).toBe(false);
      expect(isClaudeTrustDialogOpen(frame)).toBe(false);
    }
  });

  it('moves off Yes, and presses Enter only on No', () => {
    expect(resolveClaudeAutoDefaultNudgeKey(stripAnsi(nudge('cursor-yes')))).toBe('Down');
    expect(resolveClaudeAutoDefaultNudgeKey(stripAnsi(nudge('cursor-no')))).toBe('Enter');
  });

  it('reads the option whichever mode the operator keeps', () => {
    const frame = stripAnsi(nudge('cursor-no')).replace('No, keep manual mode', 'No, keep accept edits');
    expect(resolveClaudeAutoDefaultNudgeKey(frame)).toBe('Enter');
  });

  it('answers nothing when the cursor cannot be read', () => {
    const frame = stripAnsi(nudge('cursor-no')).replace('❯ No, keep', '  No, keep');
    expect(resolveClaudeAutoDefaultNudgeKey(frame)).toBeNull();
  });

  it('a quotation of the question above a live composer is not the dialog', () => {
    const quoted = [
      '⏺ It asks: Make auto mode your default permission mode?',
      '   ❯ Yes, set auto mode as my default permission mode',
      '     No, keep manual mode',
      '',
      '─'.repeat(40),
      '❯ ',
      '─'.repeat(40),
      '  ⏸ manual mode on · ? for shortcuts',
    ].join('\n');
    expect(isClaudeAutoDefaultNudgeOpen(quoted)).toBe(false);
    expect(resolveClaudeAutoDefaultNudgeKey(quoted)).toBeNull();
  });

  it('Auto-Yes cannot take the default, which is Yes: the frame offers it no numbered choice', () => {
    const frame = stripAnsi(nudge('cursor-yes'));
    expect(detectPrompt(frame, buildDetectPromptOptions('claude')).isPrompt).toBe(false);
  });

  it('a question without its two options is not the dialog', () => {
    expect(isClaudeAutoDefaultNudgeOpen('Make auto mode your default permission mode?\n')).toBe(false);
  });
});
