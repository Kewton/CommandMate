/**
 * What `wait` is told it can do about an unreadable dialog (Issue #1898).
 *
 * #1725 publishes a degraded `unclassified` prompt for a dialog only the
 * structured layer can see, and it publishes it with **no options** on purpose:
 * an option number written against a screen nobody parsed is an answer to the
 * wrong question, because the picker renumbers and Enter takes whatever is
 * highlighted (#1681).
 *
 * That reasoning does not hold for a source whose approvals are answered by
 * decision id over its own API. There the number is a verdict, not a line, and
 * withholding it left `wait` reporting exit 10 with an empty `options` array —
 * "a human is needed and there is nothing you can do about it" — for a dialog
 * `commandmate respond <id> 1` could have answered all along.
 *
 * So the options are published on a field of their own, gated on the
 * `eventIdentity` capability, and `options` stays empty. Both halves are pinned
 * here: publishing into `options` would hand the answerable payload to every
 * path that types option numbers at a pane.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));
vi.mock('@/lib/db', () => ({
  getSessionState: vi.fn(() => null),
  createMessage: vi.fn(),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:opencode'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  clearAgentStopEvents,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import {
  buildStructuredPromptData,
  buildStructuredPromptQuestion,
  STRUCTURED_DECISION_OPTIONS,
} from '@/lib/session/structured-prompt';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import type { StructuredPromptWaitingData } from '@/lib/session/structured-prompt';

const FACTS = {
  source: 'notification' as const,
  message: 'touch /tmp/marker.txt',
  toolName: 'bash',
};

describe('the payload a decision-answerable dialog publishes', () => {
  it('carries the three verdicts, and still carries no screen options', () => {
    const data = buildStructuredPromptData('wt-1', {
      ...FACTS,
      decisionOptions: STRUCTURED_DECISION_OPTIONS,
    });

    expect(data.decisionOptions).toEqual([
      { number: 1, label: 'Allow once', reply: 'once' },
      { number: 2, label: 'Allow always', reply: 'always' },
      { number: 3, label: 'Reject', reply: 'reject' },
    ]);
    // The safety property #1725 established, unchanged: nothing that answers a
    // prompt by typing an option number may find one here.
    expect(data.options).toEqual([]);
    expect(data.type).toBe('unclassified');
  });

  it('publishes nothing extra for a dialog that has no decision behind it', () => {
    const data = buildStructuredPromptData('wt-1', FACTS);
    expect(data.decisionOptions).toBeUndefined();
    expect(data.options).toEqual([]);
  });

  it('tells the operator which number to send, instead of warning them off', () => {
    const withOptions = buildStructuredPromptQuestion('wt-1', {
      ...FACTS,
      decisionOptions: STRUCTURED_DECISION_OPTIONS,
    });
    expect(withOptions).toContain('commandmate respond wt-1 <number>');
    expect(withOptions).toContain('1 = Allow once (once)');
    expect(withOptions).toContain('3 = Reject (reject)');
    // The #1681 warning is for a numbered dialog on a screen. It is wrong here
    // — nothing is typed at a pane — and leaving it in would tell an operator
    // the only thing that works cannot be trusted.
    expect(withOptions).not.toContain('Issue #1681');

    const without = buildStructuredPromptQuestion('wt-1', FACTS);
    expect(without).toContain('Issue #1681');
    expect(without).not.toContain('Allow once');
  });
});

describe('which sources may publish them', () => {
  it('is decided by the declared `eventIdentity`, and only opencode declares one', () => {
    // The gate `current-output-builder` reads. Stated as a property of the
    // capability table rather than as a tool list, so a second source that
    // gains a per-decision id inherits this without a code change here.
    const withIdentity = (['claude', 'codex', 'copilot', 'gemini', 'antigravity', 'opencode'] as const)
      .filter((tool) => getAgentEventSource(tool).capabilities.eventIdentity !== null);
    expect(withIdentity).toEqual(['opencode']);
    expect(getAgentEventSource('opencode').capabilities.eventIdentity).toBe('permission-id');
  });
});

describe('what `buildCurrentOutput` actually publishes', () => {
  const db = {} as Database.Database;
  /** A frame the scraper reads as busy — no prompt of its own in it. */
  const BUSY_FRAME = 'writing files\nediting src/app/page.tsx\n';

  beforeEach(() => {
    vi.clearAllMocks();
    clearAgentStopEvents();
    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
  });

  function openDialog(cliToolId: 'opencode' | 'claude'): void {
    recordAgentEvent('wt-1', cliToolId, cliToolId, {
      event: 'notification',
      at: Date.now() - 1_000,
      detail: 'permission_prompt',
      sessionId: 'ses-1',
      message: 'touch /tmp/marker.txt',
      ...(cliToolId === 'opencode' ? { decisionId: 'per_0000000000000000000000000' } : {}),
    });
  }

  it('attaches the verdicts for a source that declares a decision identity', async () => {
    openDialog('opencode');
    const payload = await buildCurrentOutput(db, 'wt-1', 'opencode', 'opencode');
    const promptData = payload.promptData as StructuredPromptWaitingData;

    expect(payload.isPromptWaiting).toBe(true);
    expect(promptData.decisionOptions).toEqual(STRUCTURED_DECISION_OPTIONS);
    expect(promptData.options).toEqual([]);
  });

  it('attaches nothing for a source that declares none', async () => {
    // claude's dialog is on a screen. Publishing "send 1 for Allow once" for it
    // would be publishing an option number for a picker nobody parsed — the
    // exact thing #1725 refused to do, and #1898 does not reopen.
    openDialog('claude');
    const payload = await buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
    const promptData = payload.promptData as StructuredPromptWaitingData;

    expect(payload.isPromptWaiting).toBe(true);
    expect(promptData.decisionOptions).toBeUndefined();
  });
});
