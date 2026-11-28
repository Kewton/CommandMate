/**
 * Issue #4632 (review s13 P2-1): the "the text's 2xx did not say whether it arrived" mark is the
 * page's memory keyed by the request id, in the store of `@/lib/handoff/close-rule`.
 *
 * - a mark is kept while another opening begins (the same request picked up later reads it);
 * - a different request id does not read another's mark;
 * - `resetHandoffStoreForTests` clears every mark (the tests' reset);
 * - no browser storage is written (the page's memory only — the known limit).
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginHandoffOpening,
  currentHandoffHold,
  handoffStoreSnapshot,
  patchHandoffOpening,
  resetHandoffStoreForTests,
} from '@/lib/handoff/close-rule';
import type { HandoffReadResponse, HandoffRequestView } from '@/lib/handoff/types';

const TARGET = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' };

function request(id: string): HandoffRequestView {
  return {
    id, worktreeId: 'wt-1', instanceId: 'claude', cliToolId: 'claude', branch: 'feat/x', detached: false,
    state: 'awaiting_agent', sendState: 'failed', endForced: false, endToken: null, outcome: null, outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z', extensions: 0, expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: null, endedAt: null, agentTimedOut: false, version: 1,
  };
}

const view = (id: string): HandoffReadResponse => ({ ok: true, request: request(id), proposals: [], direct: [] });

afterEach(() => {
  resetHandoffStoreForTests();
  vi.restoreAllMocks();
});

describe('[#4632 review P2-1] the text-outcome-unknown mark is per request id, in the page', () => {
  it('a mark survives another opening and is read back when the same request is picked up', () => {
    const first = beginHandoffOpening('wt-1', TARGET);
    patchHandoffOpening(first.token, { view: view('r1') });
    patchHandoffOpening(first.token, { textOutcomeUnknown: true });
    expect(currentHandoffHold().textOutcomeUnknown).toBe(true);

    // Another opening (another instance) replaces it: its request has no mark.
    const second = beginHandoffOpening('wt-1', { cliToolId: 'codex', instanceId: 'codex', label: 'Codex' });
    patchHandoffOpening(second.token, { view: view('r2') });
    expect(currentHandoffHold().textOutcomeUnknown).toBe(false);

    // Back on the first request (a 409 `request_open` picked up): its mark is there.
    patchHandoffOpening(second.token, { view: view('r1') });
    expect(currentHandoffHold().textOutcomeUnknown).toBe(true);
  });

  it('clearing the mark removes only that request id', () => {
    const opening = beginHandoffOpening('wt-1', TARGET);
    patchHandoffOpening(opening.token, { view: view('r1') });
    patchHandoffOpening(opening.token, { textOutcomeUnknown: true });
    patchHandoffOpening(opening.token, { view: view('r2') });
    patchHandoffOpening(opening.token, { textOutcomeUnknown: true });

    patchHandoffOpening(opening.token, { textOutcomeUnknown: false });
    expect(handoffStoreSnapshot().textOutcomeUnknown).toEqual({ r1: true });

    patchHandoffOpening(opening.token, { view: view('r1') });
    expect(currentHandoffHold().textOutcomeUnknown).toBe(true);
  });

  it('resetHandoffStoreForTests clears every mark', () => {
    const opening = beginHandoffOpening('wt-1', TARGET);
    patchHandoffOpening(opening.token, { view: view('r1') });
    patchHandoffOpening(opening.token, { textOutcomeUnknown: true });
    expect(handoffStoreSnapshot().textOutcomeUnknown).toEqual({ r1: true });

    resetHandoffStoreForTests();
    expect(handoffStoreSnapshot().textOutcomeUnknown).toEqual({});
  });

  it('writes no browser storage (the page’s memory only)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const opening = beginHandoffOpening('wt-1', TARGET);
    patchHandoffOpening(opening.token, { view: view('r1') });
    patchHandoffOpening(opening.token, { textOutcomeUnknown: true });
    patchHandoffOpening(opening.token, { view: view('r2') });
    expect(setItem).not.toHaveBeenCalled();
  });
});
