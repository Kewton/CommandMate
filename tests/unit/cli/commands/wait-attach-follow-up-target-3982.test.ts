/**
 * Issue #3982: `wait`'s and `attach`'s `capture` hints name the target the
 * command addressed, not the worktree default.
 *
 * Positive controls: with an instance (`wait`) or `--agent` / `--instance`
 * (`attach`), the hint carries it, and `wait`'s unclassified-frame hint reads
 * enough of the pane for a dialog. Negative controls: with no target, the hints
 * name none — as before.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { buildAttachHints } from '../../../../src/cli/commands/attach';
import { commandTargetOf } from '../../../../src/cli/commands/command-target';
import { waitCommandTarget } from '../../../../src/cli/commands/wait-instance';
import { followUpCommand } from '../../../../src/cli/utils/follow-up-command';
import { ApiClient } from '../../../../src/cli/utils/api-client';

vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  vi.useRealTimers();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const unclassified = {
  isRunning: true,
  isPromptWaiting: false,
  content: 'x',
  fullOutput: 'x',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  cliToolId: 'codex',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  isUnclassifiedActive: true,
  sessionStatus: 'running' as const,
  sessionStatusReason: 'default',
};

async function unclassifiedQuestion(options: Record<string, unknown>): Promise<string> {
  vi.useFakeTimers();
  mockFetchSequence(Array.from({ length: 15 }, () => ({ data: unclassified })));
  const { pollWorktree } = await import('../../../../src/cli/commands/wait');
  const promise = pollWorktree(new ApiClient({}), 'wt1', options);
  await vi.advanceTimersByTimeAsync(70_000);
  const result = await promise;
  return String(result.output?.question ?? '');
}

describe('[#3982] wait: the capture hints name the instance waited on', () => {
  it('positive: an unclassified frame on an instance names it and reads the dialog', async () => {
    const question = await unclassifiedQuestion({ instance: 'codex-2' });
    expect(question).toContain('`commandmate capture wt1 --instance codex-2 --pane --tail 40`');
  });

  it('negative: with no instance the hint names none', async () => {
    const question = await unclassifiedQuestion({});
    expect(question).toContain('`commandmate capture wt1 --pane --tail 40`');
    expect(question).not.toContain('--instance');
  });

  it('the "turn not reported" hint: --json for the instance, none without one', () => {
    expect(followUpCommand('capture', 'wt1', waitCommandTarget({ instance: 'codex-2' }), undefined, '--json'))
      .toBe('commandmate capture wt1 --instance codex-2 --json');
    expect(followUpCommand('capture', 'wt1', waitCommandTarget({}), undefined, '--json'))
      .toBe('commandmate capture wt1 --json');
  });
});

describe('[#3982] attach: the capture hints name the target attached to', () => {
  it('positive: --agent claude is named on every capture line', () => {
    const hints = buildAttachHints('claude', 'wt1', 'mcbd-claude-wt1', {
      readOnly: true,
      target: commandTargetOf(null, 'claude'),
    }).join('\n');
    expect(hints).toContain('commandmate capture wt1 --agent claude --pane --tail 60');
    expect(hints).toContain('commandmate capture wt1 --agent claude --pane --follow');
    expect(hints).not.toContain('<id>');
  });

  it('positive: an --instance is named by its resolved id', () => {
    const hints = buildAttachHints('claude', 'wt1', 'mcbd-claude-2-wt1', {
      target: commandTargetOf({ cliToolId: 'claude', instanceId: 'claude-2' }, undefined),
    }).join('\n');
    expect(hints).toContain('commandmate capture wt1 --instance claude-2 --pane --tail 60');
    expect(hints).not.toContain('--agent');
  });

  it('negative: no target, no target flag', () => {
    const hints = buildAttachHints('claude', 'wt1', 'mcbd-claude-wt1', { target: commandTargetOf(null, undefined) }).join('\n');
    expect(hints).toContain('commandmate capture wt1 --pane --tail 60');
    expect(hints).not.toContain('--instance');
    expect(hints).not.toContain('--agent');
  });
});
