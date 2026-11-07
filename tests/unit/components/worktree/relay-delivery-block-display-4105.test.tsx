/**
 * The requester's own dialog stopping a delivery is shown on the requester's
 * row, apart from the worker's `prompt` state (Issue #4105) — PC roster, phone
 * roster and the chat strip, through the shared hook and the API's shape.
 *
 * Positive controls fail before the change (no `blocked` tone existed: a relay
 * stopped by A's dialog read as an ordinary wait). Negative controls (B's
 * prompt alone, `generating`, an older server without the field, a held
 * relay) render as before.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => <div data-testid="chat-transcript"><div data-testid="chat-transcript-scroll-container" /></div>,
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

import { resetSessionRelayStores } from '@/lib/relay/use-session-relays';
import { resolveRelayBadges, resolveRelayStrip } from '@/lib/relay/relay-badges';
import { relayBadgeClassName, AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { MobileAgentInstancesPane } from '@/components/worktree/MobileAgentInstancesPane';
import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';
import {
  LEGACY_RELAY_BINDING_FIELDS,
  type RelayLastDeliveryBlock,
  type SessionRelay,
} from '@/lib/relay/types';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

const WT = 'wt-a';
const A = { worktreeId: WT, instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

function block(reason: RelayLastDeliveryBlock['reason']): RelayLastDeliveryBlock {
  return { reason, kind: 'reply', payloadId: 'p1', observedAt: 1 };
}

function relay(overrides: Partial<SessionRelay> = {}): SessionRelay {
  return {
    id: 'r1',
    from: A,
    to: B,
    state: 'pending',
    hops: 1,
    sentRequestId: null,
    pendingKind: 'reply',
    createdAt: 0,
    updatedAt: 0,
    expiresAt: 0,
    deliveredAt: null,
    ...LEGACY_RELAY_BINDING_FIELDS,
    ...overrides,
  };
}

const mockFetch = vi.fn();

function serve(open: SessionRelay[], held: SessionRelay[] = []): void {
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve(
      String(url).startsWith('/api/relays')
        ? { ok: true, json: () => Promise.resolve({ owed: [], awaiting: [], open, held }) }
        : { ok: true, json: () => Promise.resolve({}) }
    )
  );
}

beforeAll(() => installRadixJsdomPolyfills());

beforeEach(() => {
  resetSessionRelayStores();
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  resetSessionRelayStores();
});

const aliasOf = (endpoint: { instanceId: string }) => endpoint.instanceId;

describe('the badge rule (Issue #4105)', () => {
  it('A blocked by its own dialog: a `blocked` badge, warning colour, strip wording', () => {
    const badges = resolveRelayBadges({
      owed: [],
      awaiting: [relay({ lastDeliveryBlock: block('prompt_waiting') })],
      aliasOf,
    });
    expect(badges.map((b) => b.tone)).toEqual(['blocked', 'awaiting']);
    expect(badges[0]).toMatchObject({
      key: 'badgeBlockedByPrompt',
      params: { alias: 'codex' },
      titleKey: 'blockedByPromptTitle',
      count: 1,
    });
    expect(relayBadgeClassName(badges[0])).toBe('text-warning');
    expect(resolveRelayStrip(badges)?.key).toBe('stripBlockedByPrompt');
  });

  it('B on a confirmation only: `prompt`, never `blocked`', () => {
    const badges = resolveRelayBadges({ owed: [], awaiting: [relay({ state: 'prompt' })], aliasOf });
    expect(badges.map((b) => b.tone)).toEqual(['prompt']);
  });

  it('both: two separate badges, A\'s dialog first', () => {
    const badges = resolveRelayBadges({
      owed: [],
      awaiting: [relay({ state: 'prompt', lastDeliveryBlock: block('prompt_waiting') })],
      aliasOf,
    });
    expect(badges.map((b) => b.tone)).toEqual(['blocked', 'prompt']);
  });

  it('several relays stopped on the same session are counted as relays', () => {
    const badges = resolveRelayBadges({
      owed: [],
      awaiting: [
        relay({ id: 'r1', lastDeliveryBlock: block('prompt_waiting') }),
        relay({ id: 'r2', lastDeliveryBlock: block('prompt_waiting') }),
        relay({ id: 'r3' }),
      ],
      aliasOf,
    });
    expect(badges[0]).toMatchObject({ tone: 'blocked', key: 'badgeBlockedByPromptMany', params: { count: 2 }, count: 2 });
    // The waits are still counted as waits: nothing subtracted.
    expect(badges[1]).toMatchObject({ tone: 'awaiting', params: { count: 3 } });
    expect(resolveRelayStrip(badges)?.key).toBe('stripBlockedByPromptMany');
  });

  it('a held (uncertain) payload stays first, ahead of the dialog', () => {
    const badges = resolveRelayBadges({
      owed: [],
      awaiting: [relay({ id: 'r2', lastDeliveryBlock: block('prompt_waiting') })],
      held: [relay({ id: 'h' })],
      aliasOf,
    });
    expect(badges.map((b) => b.tone)).toEqual(['held', 'blocked', 'awaiting']);
    expect(resolveRelayStrip(badges)?.key).toBe('stripHeld');
  });

  it('negative controls: generating, session_stopped, null and absent draw no `blocked` badge', () => {
    for (const lastDeliveryBlock of [block('generating'), block('session_stopped'), null, undefined]) {
      const badges = resolveRelayBadges({ owed: [], awaiting: [relay({ lastDeliveryBlock })], aliasOf });
      expect(badges.map((b) => b.tone)).toEqual(['awaiting']);
    }
  });
});

describe('PC, phone and chat surfaces (Issue #4105)', () => {
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

  it('PC and phone rosters: the badge is on A\'s row, in the warning colour', async () => {
    serve([relay({ lastDeliveryBlock: block('prompt_waiting') })]);
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
    const phone = screen.getByTestId('mobile-visible-instance-relay-blocked-claude');
    expect(phone.className).toContain('text-warning');
    // The wait is still shown, and B's row says nothing about A's dialog.
    expect(screen.getByTestId('agent-instance-relay-awaiting-claude')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-instance-relay-blocked-codex')).toBeNull();
  });

  it('negative control: an older server (no field) renders the plain wait only', async () => {
    serve([relay()]);
    render(<AgentInstancesPane {...paneProps} />);
    expect(await screen.findByTestId('agent-instance-relay-awaiting-claude')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-instance-relay-blocked-claude')).toBeNull();
  });

  it('chat strip: A\'s surface says its dialog stops the delivery, as a warning', async () => {
    serve([relay({ lastDeliveryBlock: block('prompt_waiting') })]);
    render(
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
    const strip = await screen.findByTestId('chat-surface-relay');
    expect(strip.getAttribute('data-relay-tone')).toBe('blocked');
    expect(strip.className).toContain('bg-warning-subtle');
    expect(strip.textContent).toContain('worktree.relay.stripBlockedByPrompt');
  });
});
