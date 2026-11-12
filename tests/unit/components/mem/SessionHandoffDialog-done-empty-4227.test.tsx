/**
 * G9 (Issue #4227, the UAT of G-PR1+G-PR2; design `mem-ui-4227.md` §4.2): an agent whose
 * `propose` failed and that chained `done` after it moved the request to the person's review with
 * no proposal, and the screen showed an empty review as if nothing were to be proposed. The server
 * cannot tell (a CLI parse error never reaches it), so the dialog says it: done with no proposal →
 * a proposal may have failed and not arrived; "don't end" and "end" again asks once more.
 *
 * Positive control: without the notice (the code before G9) the first case fails.
 * Negative controls: done with a proposal, still waiting for the agent, and the agent's time over
 * with nothing (no `done`: the timeout's own message) show no such notice.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

import { SessionHandoffDialog } from '@/components/mem/SessionHandoffDialog';
import { resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import type { HandoffProposalView, HandoffReadResponse, HandoffRequestView } from '@/lib/handoff/types';

let request: HandoffRequestView;
let proposals: HandoffProposalView[];

const view = (): HandoffReadResponse => ({ ok: true, request: { ...request }, proposals: proposals.map((p) => ({ ...p })), direct: [] });
const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;

function baseRequest(over: Partial<HandoffRequestView>): HandoffRequestView {
  return {
    id: 'r1',
    worktreeId: 'wt-1',
    instanceId: 'claude',
    cliToolId: 'claude',
    branch: 'feat/x',
    detached: false,
    state: 'reviewing',
    sendState: 'sent',
    endForced: false,
    endToken: null,
    outcome: null,
    outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z',
    extensions: 0,
    expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: '2026-11-10T00:01:00.000Z',
    endedAt: null,
    agentTimedOut: false,
    version: 3,
    ...over,
  };
}
const proposal = (id: string): HandoffProposalView => ({
  id,
  op: 'add',
  itemId: null,
  kind: 'note',
  baseVersion: null,
  revision: 1,
  fingerprint: `fp-${id}`,
  state: 'proposed',
  stateReason: null,
  payload: { text: `text of ${id}` },
  current: null,
  appliedItemId: null,
  appliedVersion: null,
});

beforeEach(() => {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api\/worktrees\/wt-1/, '');
    const method = init?.method ?? 'GET';
    if (path === '/send') return json(201, { id: 'm1' });
    if (path === '/mem/handoff/requests' && method === 'POST') return json(201, { ...view(), text: 'the request text' });
    return json(200, view());
  }) as unknown as typeof fetch;
});
afterEach(() => {
  resetHandoffStoreForTests();
  vi.restoreAllMocks();
});

function renderDialog(): void {
  render(
    <SessionHandoffDialog
      isOpen
      worktreeId="wt-1"
      target={{ cliToolId: 'claude', instanceId: 'claude', label: 'Claude' }}
      onClose={vi.fn()}
      onStop={vi.fn(async () => 'stopped' as const)}
    />
  );
}

describe('[#4227 G9] done with no proposal is shown to the person', () => {
  it('reviewing after done with no proposal: the notice says a proposal may not have arrived and how to ask again', async () => {
    request = baseRequest({});
    proposals = [];
    renderDialog();
    const notice = await screen.findByTestId('handoff-done-empty');
    expect(notice.textContent).toContain('届いていません');
    expect(notice.textContent).toContain('終了をやめる');
  });

  it('(negative control) done with a proposal: no notice, the proposal is listed', async () => {
    request = baseRequest({});
    proposals = [proposal('p1')];
    renderDialog();
    await screen.findByTestId('handoff-approve-p1');
    expect(screen.queryByTestId('handoff-done-empty')).toBeNull();
  });

  it('(negative control) still waiting for the agent: no notice', async () => {
    request = baseRequest({ state: 'awaiting_agent', agentDoneAt: null });
    proposals = [];
    renderDialog();
    await screen.findByTestId('handoff-state');
    expect(screen.queryByTestId('handoff-done-empty')).toBeNull();
  });

  it('(negative control) the agent’s time over with no done: the timeout’s message, not this notice', async () => {
    request = baseRequest({ state: 'awaiting_agent', agentDoneAt: null, agentTimedOut: true });
    proposals = [];
    renderDialog();
    await screen.findByTestId('handoff-agent-timeout');
    expect(screen.queryByTestId('handoff-done-empty')).toBeNull();
  });
});
