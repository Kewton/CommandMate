/**
 * An expiry notice stopped by the requester's own dialog is shown on the
 * requester's row after the relay closed (Issue #4193) — PC roster, phone
 * roster and the chat strip, from the server's actual answer.
 *
 * The browser's `fetch` is answered by the real `GET /api/relays` handler over
 * a real ledger (a file DB under `fs.mkdtempSync(os.tmpdir())`, removed in
 * `afterEach`) after the real pump ran into A's dialog. Positive cases fail
 * before the fix (the closed relay was in no list the hook read); the
 * negative controls (delivered, nothing stopped, the worker's row, the plain
 * badge rule) render as before.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => <div data-testid="chat-transcript"><div data-testid="chat-transcript-scroll-container" /></div>,
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

let db: Database.Database;
const sendUserMessage = vi.fn();
const findRelayHoldReason = vi.fn();

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({
  findRelayHoldReason: (...args: unknown[]) => findRelayHoldReason(...args),
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { createRelay } from '@/lib/db/relay-db';
import { resetRelayServerBootId } from '@/lib/relay/relay-boot';
import { pumpRelayDeliveries, resetRelayDeliveryState, sweepExpiredRelays } from '@/lib/relay/relay-delivery';
import { GET as listRoute } from '@/app/api/relays/route';
import { resetSessionRelayStores } from '@/lib/relay/use-session-relays';
import { resolveRelayBadges, resolveRelayStrip } from '@/lib/relay/relay-badges';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { MobileAgentInstancesPane } from '@/components/worktree/MobileAgentInstancesPane';
import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';
import { LEGACY_RELAY_BINDING_FIELDS, type SessionRelay } from '@/lib/relay/types';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const WT = 'wt-a';
const A = { worktreeId: WT, instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

type Attempt = { state: string; reason: string };
const PROMPT_WAITING = async (_db: unknown, params: { onAttempt?: (a: Attempt) => void }) => {
  params.onAttempt?.({ state: 'not-sent', reason: 'prompt-waiting' });
  return { ok: false, stage: 'prompt_waiting', error: 'prompt open' };
};

let dir: string;
const mockFetch = vi.fn();

/** The browser's fetch, answered by the real route handler. */
function serveFromRoute(): void {
  mockFetch.mockImplementation(async (url: string) => {
    if (!String(url).startsWith('/api/relays')) return { ok: true, json: () => Promise.resolve({}) };
    const response = await listRoute(new NextRequest(`http://localhost${url}`));
    const body = await response.json();
    return { ok: response.ok, json: () => Promise.resolve(body) };
  });
}

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, cliToolId, NOW);
}

async function expiredNoticeStoppedOnDialog(): Promise<string> {
  const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW - 1, now: NOW - DAY_MS });
  expect(sweepExpiredRelays(db, NOW)).toBe(1);
  sendUserMessage.mockImplementation(PROMPT_WAITING);
  await pumpRelayDeliveries();
  return relay.id;
}

beforeAll(() => installRadixJsdomPolyfills());

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-4193-ui-'));
  db = new Database(path.join(dir, 'cm.db'));
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  resetRelayDeliveryState();
  resetRelayServerBootId();
  sendUserMessage.mockReset();
  sendUserMessage.mockResolvedValue({ ok: true, message: { id: 'm1' } });
  findRelayHoldReason.mockReset();
  findRelayHoldReason.mockResolvedValue(null);
  resetSessionRelayStores();
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
  serveFromRoute();
});

afterEach(() => {
  resetSessionRelayStores();
  resetRelayDeliveryState();
  resetRelayServerBootId();
  if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ROSTER: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
];
const paneProps = {
  worktreeId: WT,
  instances: ROSTER,
  onInstancesChange: vi.fn(),
  vibeLocalModel: null as string | null,
  onVibeLocalModelChange: vi.fn(),
  vibeLocalContextWindow: null as number | null,
  onVibeLocalContextWindowChange: vi.fn(),
};
const IDLE: ChatSurfaceLiveState = {
  isRunning: true,
  sessionStatus: 'ready',
  isThinking: false,
  isPromptWaiting: false,
  promptData: null,
  isSelectionListActive: false,
  isPagerActive: false,
  isUnclassifiedActive: false,
};

function renderChat() {
  return render(
    <ChatSurface
      messages={[]}
      worktreeId={WT}
      cliToolId="claude"
      instanceId="claude"
      live={IDLE}
      onSurfaceModeChange={vi.fn()}
      frame=""
    />
  );
}

describe('a closed relay\'s stopped expiry notice on screen (Issue #4193)', () => {
  it('PC and phone rosters: `blocked` on A\'s row, nothing on B\'s (positive)', async () => {
    await expiredNoticeStoppedOnDialog();
    render(
      <MobileAgentInstancesPane
        {...paneProps}
        visibleInstanceIds={['claude', 'codex']}
        onToggleInstanceVisible={vi.fn()}
      />
    );

    const pc = await screen.findByTestId('agent-instance-relay-blocked-claude');
    expect(pc.className).toContain('text-warning');
    expect(pc.textContent).toContain('worktree.relay.badgeBlockedByPrompt');
    expect(screen.getByTestId('mobile-visible-instance-relay-blocked-claude').className).toContain('text-warning');
    // The relay is closed: no wait is shown, and B's row says nothing.
    expect(screen.queryByTestId('agent-instance-relay-awaiting-claude')).toBeNull();
    expect(screen.queryByTestId('agent-instance-relay-blocked-codex')).toBeNull();
  });

  it('chat strip: A\'s surface says its dialog stops the notice (positive)', async () => {
    await expiredNoticeStoppedOnDialog();
    renderChat();
    const strip = await screen.findByTestId('chat-surface-relay');
    expect(strip.getAttribute('data-relay-tone')).toBe('blocked');
    expect(strip.textContent).toContain('worktree.relay.stripBlockedByPrompt');
  });

  it('negative control: once the notice is delivered nothing is shown', async () => {
    await expiredNoticeStoppedOnDialog();
    sendUserMessage.mockReset();
    sendUserMessage.mockResolvedValue({ ok: true, message: { id: 'm2' } });
    await pumpRelayDeliveries();

    render(<AgentInstancesPane {...paneProps} />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    // Let the read land.
    await waitFor(() => expect(mockFetch.mock.results[0]?.value).toBeDefined());
    await mockFetch.mock.results[0].value;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('agent-instance-relay-blocked-claude')).toBeNull();
  });

  it('negative control: an expired relay nothing stopped draws no strip', async () => {
    createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW - 1, now: NOW - DAY_MS });
    expect(sweepExpiredRelays(db, NOW)).toBe(1);
    renderChat();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await mockFetch.mock.results[0].value;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('chat-surface-relay')).toBeNull();
  });
});

describe('the badge rule for closed relays (Issue #4193)', () => {
  function closed(overrides: Partial<SessionRelay> = {}): SessionRelay {
    return {
      id: 'r1',
      from: A,
      to: B,
      state: 'expired',
      hops: 1,
      sentRequestId: null,
      pendingKind: 'expired',
      createdAt: 0,
      updatedAt: 0,
      expiresAt: 0,
      deliveredAt: null,
      ...LEGACY_RELAY_BINDING_FIELDS,
      lastDeliveryBlock: { reason: 'prompt_waiting', kind: 'expired', payloadId: 'p1', observedAt: 1 },
      ...overrides,
    };
  }
  const aliasOf = (endpoint: { instanceId: string }) => endpoint.instanceId;

  it('feeds `blocked` only — no awaiting, the same tone and strip as an open relay', () => {
    const badges = resolveRelayBadges({ owed: [], awaiting: [], closedBlocked: [closed()], aliasOf });
    expect(badges.map((b) => b.tone)).toEqual(['blocked']);
    expect(badges[0]).toMatchObject({ key: 'badgeBlockedByPrompt', params: { alias: 'codex' }, count: 1 });
    expect(resolveRelayStrip(badges)?.key).toBe('stripBlockedByPrompt');
  });

  it('counted with the open ones as relays', () => {
    const open = closed({ id: 'r2', state: 'pending', pendingKind: 'reply' });
    const badges = resolveRelayBadges({ owed: [], awaiting: [open], closedBlocked: [closed()], aliasOf });
    expect(badges[0]).toMatchObject({ tone: 'blocked', key: 'badgeBlockedByPromptMany', count: 2 });
    // The wait counts the open relay only.
    expect(badges[1]).toMatchObject({ tone: 'awaiting', count: 1 });
  });

  it('negative control: another reason, or absent, draws nothing', () => {
    const generating = closed({ lastDeliveryBlock: { reason: 'generating', kind: 'expired', payloadId: 'p1', observedAt: 1 } });
    expect(resolveRelayBadges({ owed: [], awaiting: [], closedBlocked: [generating], aliasOf })).toEqual([]);
    expect(resolveRelayBadges({ owed: [], awaiting: [], aliasOf })).toEqual([]);
  });
});
