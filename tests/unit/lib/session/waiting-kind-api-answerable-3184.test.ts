/**
 * A wait the app answers over the agent's API is a `prompt` (Issue #3184,
 * design §6-2, decided 2026-10-04): for the sidebar dots and the push body,
 * not for the relay.
 *
 * OpenCode V2's approval strip reads to the scraper as a selection list
 * (`opencode_permission_prompt` ∈ SELECTION_LIST_REASONS → `menu`, see
 * `tests/unit/session/opencode-v2-approval-frame-3184.test.ts`), and a dialog
 * the scraper cannot see at all as `unclassified`; both made the push say
 * "check the terminal" about a dialog the panel draws buttons for.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { deriveWaitingKind } from '@/lib/session/waiting-kind';
import {
  isApiAnswerableStructuredWait,
  isApiAnswerableWaitNow,
} from '@/lib/session/prompt-waiting-composition';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import { buildPushPayload } from '@/lib/push/push-sender';
import { STATUS_REASON } from '@/lib/detection/status-reason';

const WT = 'wt-3184-kind';
const PERMISSION_ID = 'per_3184kindPermission0000000';

afterEach(() => {
  clearAgentStopEvents();
});

describe('deriveWaitingKind with apiAnswerable (#3184)', () => {
  const menuFrame = {
    waiting: true,
    hasActivePrompt: false,
    scraperStatus: 'waiting' as const,
    scraperReason: STATUS_REASON.OPENCODE_PERMISSION_PROMPT,
  };
  const blindFrame = {
    waiting: true,
    hasActivePrompt: false,
    scraperStatus: 'running' as const,
    scraperReason: 'default',
  };

  it('lifts the V2 approval strip from menu to prompt', () => {
    expect(deriveWaitingKind(menuFrame)).toBe('menu');
    expect(deriveWaitingKind({ ...menuFrame, apiAnswerable: true })).toBe('prompt');
  });

  it('lifts a dialog the scraper cannot see from unclassified to prompt', () => {
    expect(deriveWaitingKind(blindFrame)).toBe('unclassified');
    expect(deriveWaitingKind({ ...blindFrame, apiAnswerable: true })).toBe('prompt');
  });

  it('negative control: absent or false keeps the scraper’s reading, and not waiting stays null', () => {
    expect(deriveWaitingKind({ ...menuFrame, apiAnswerable: false })).toBe('menu');
    expect(deriveWaitingKind({ ...menuFrame, waiting: false, apiAnswerable: true })).toBeNull();
  });
});

describe('isApiAnswerableStructuredWait — the builder’s decisionId gate (#3184)', () => {
  const record = { source: 'notification' as const, decisionId: PERMISSION_ID };

  it('needs a notification record, a permission-id source and an addressable id', () => {
    expect(isApiAnswerableStructuredWait(record, 'permission-id')).toBe(true);
    expect(isApiAnswerableStructuredWait(null, 'permission-id')).toBe(false);
    expect(isApiAnswerableStructuredWait({ ...record, source: 'permission-request' }, 'permission-id')).toBe(false);
    expect(isApiAnswerableStructuredWait(record, null)).toBe(false);
    expect(isApiAnswerableStructuredWait(record, 'tool-call-id')).toBe(false);
    expect(isApiAnswerableStructuredWait({ ...record, decisionId: null }, 'permission-id')).toBe(false);
    expect(isApiAnswerableStructuredWait({ ...record, decisionId: '' }, 'permission-id')).toBe(false);
  });

  it('reads the live record: an OpenCode V2 approval yes, a Claude permission no', () => {
    for (const tool of ['opencode-v2', 'claude'] as const) {
      recordAgentEvent(WT, tool, tool, {
        event: 'notification',
        at: Date.now() - 1_000,
        detail: 'permission_prompt',
        sessionId: 'ses-3184',
        message: 'edit hello.txt',
        decisionId: PERMISSION_ID,
      });
    }
    const identity = (tool: 'opencode-v2' | 'claude') => getAgentEventSource(tool).capabilities.eventIdentity;
    expect(isApiAnswerableWaitNow(WT, 'opencode-v2', 'opencode-v2', identity('opencode-v2'))).toBe(true);
    expect(isApiAnswerableWaitNow(WT, 'claude', 'claude', identity('claude'))).toBe(false);
    expect(isApiAnswerableWaitNow('wt-3184-none', 'opencode-v2', 'opencode-v2', identity('opencode-v2'))).toBe(false);
  });
});

describe('the push body follows the kind (#3184)', () => {
  const base = { worktreeId: WT, worktreeName: 'wt', kind: 'prompt' as const, excerpt: 'edit hello.txt' };

  it('a `prompt` wait is not told to go to the terminal, a `menu` one is', () => {
    const asPrompt = buildPushPayload({ ...base, waitingKind: 'prompt' }, 'en').body;
    const asMenu = buildPushPayload({ ...base, waitingKind: 'menu' }, 'en').body;
    expect(asPrompt).not.toBe(asMenu);
    expect(asMenu.toLowerCase()).toContain('terminal');
    expect(asPrompt.toLowerCase()).not.toContain('terminal');
  });
});
