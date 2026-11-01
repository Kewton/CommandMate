/**
 * A held (`uncertain`) relay is shown apart from pending — through the API
 * answer, the shared hook's state and the PC and phone parents' rendering
 * (Issue #4082, work item b).
 *
 * Positive controls fail before this change (the hook kept only `open`, so a
 * closed relay's hold never showed and an open one read as "waiting"). The
 * negative controls (an `attempting` hold, no hold, an older server without
 * `held`) pass before and after.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import {
  resetSessionRelayStores,
  useSessionRelays,
} from '@/lib/relay/use-session-relays';
import { resolveRelayBadges, resolveRelayStrip } from '@/lib/relay/relay-badges';
import { relayBadgeClassName, AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { MobileAgentInstancesPane } from '@/components/worktree/MobileAgentInstancesPane';
import {
  LEGACY_RELAY_BINDING_FIELDS,
  type RelayDeliveryHold,
  type SessionRelay,
} from '@/lib/relay/types';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import en from '../../../../locales/en/worktree.json';
import ja from '../../../../locales/ja/worktree.json';

const WT = 'wt-a';
const A = { worktreeId: WT, instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

function hold(state: RelayDeliveryHold['state']): RelayDeliveryHold {
  return {
    state,
    payloadId: 'p1',
    attemptId: 't1',
    kind: 'reply',
    reason: 'send-error',
    at: 1,
    checkCommand: 'commandmate capture wt-a --instance claude --pane',
  };
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

type Answer = { open?: SessionRelay[]; held?: SessionRelay[] };

const mockFetch = vi.fn();

function answerWith(answer: Answer) {
  return { ok: true, json: () => Promise.resolve({ owed: [], awaiting: [], counts: undefined, ...answer }) };
}

/** Answer every relay read with `answer`; everything else with `{}`. */
function serve(answer: Answer): void {
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve(String(url).startsWith('/api/relays') ? answerWith(answer) : { ok: true, json: () => Promise.resolve({}) })
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

describe('useSessionRelays keeps the held relays (Issue #4082)', () => {
  it('first read: an open uncertain relay is held, not awaited; a closed one is held too', async () => {
    const openHeld = relay({ id: 'open-held', deliveryHold: hold('uncertain') });
    const closedHeld = relay({ id: 'closed-held', state: 'expired', deliveryHold: hold('uncertain') });
    serve({ open: [openHeld], held: [openHeld, closedHeld] });

    const { result } = renderHook(() => useSessionRelays(WT));
    await waitFor(() => expect(result.current.held).toHaveLength(2));

    expect(result.current.heldFor('claude').map((r) => r.id)).toEqual(['open-held', 'closed-held']);
    expect(result.current.awaitedBy('claude')).toEqual([]);
    expect(result.current.owedBy('codex')).toEqual([]);
  });

  it('negative control: attempting stays pending (awaited), and is not held', async () => {
    const attempting = relay({ id: 'att', deliveryHold: hold('attempting') });
    serve({ open: [attempting], held: [attempting] });

    const { result } = renderHook(() => useSessionRelays(WT));
    await waitFor(() => expect(result.current.open).toHaveLength(1));

    expect(result.current.held).toEqual([]);
    expect(result.current.awaitedBy('claude').map((r) => r.id)).toEqual(['att']);
  });

  it('an older server without `held` shows nothing held', async () => {
    serve({ open: [relay()] });
    const { result } = renderHook(() => useSessionRelays(WT));
    await waitFor(() => expect(result.current.open).toHaveLength(1));
    expect(result.current.held).toEqual([]);
    expect(result.current.awaitedBy('claude')).toHaveLength(1);
  });

  it('heldUnplaced lists holds whose requester is not in the roster; never another worktree as requester', async () => {
    const orphan = relay({ id: 'orphan', from: { worktreeId: WT, instanceId: 'gone' }, deliveryHold: hold('uncertain') });
    const foreign = relay({ id: 'foreign', from: B, to: A, deliveryHold: hold('uncertain') });
    serve({ held: [orphan, foreign] });

    const { result } = renderHook(() => useSessionRelays(WT));
    await waitFor(() => expect(result.current.held).toHaveLength(2));

    expect(result.current.heldUnplaced(['claude']).map((r) => r.id)).toEqual(['orphan']);
    expect(result.current.heldFor('claude')).toEqual([]);
  });

  it('a poll and an explicit refresh keep `held` up to date', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serve({ open: [] });
      const { result } = renderHook(() => useSessionRelays(WT));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      serve({ held: [relay({ state: 'cancelled', deliveryHold: hold('uncertain') })] });
      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
      await waitFor(() => expect(result.current.held).toHaveLength(1));

      serve({ held: [] });
      act(() => result.current.refresh());
      await waitFor(() => expect(result.current.held).toEqual([]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('an older answer landing after a newer one does not bring a settled hold back', async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mockFetch.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));

    const { result } = renderHook(() => useSessionRelays(WT));
    await waitFor(() => expect(resolvers).toHaveLength(1));
    act(() => result.current.refresh());
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // The newer read (after the resolve) answers first: nothing held.
    await act(async () => resolvers[1](answerWith({ held: [] })));
    // The older read (before the resolve) answers late, still holding.
    await act(async () => resolvers[0](answerWith({ held: [relay({ deliveryHold: hold('uncertain') })] })));

    expect(result.current.held).toEqual([]);
  });

  it('a failed read keeps the last answer', async () => {
    serve({ held: [relay({ deliveryHold: hold('uncertain') })] });
    const { result } = renderHook(() => useSessionRelays(WT));
    await waitFor(() => expect(result.current.held).toHaveLength(1));

    mockFetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    act(() => result.current.refresh());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.held).toHaveLength(1);
  });

  it('two surfaces share one poll for the worktree', async () => {
    serve({ held: [] });
    renderHook(() => {
      useSessionRelays(WT);
      useSessionRelays(WT);
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('the badge rule puts held first, in the warning colour (Issue #4082)', () => {
  const aliasOf = (endpoint: { instanceId: string }) => endpoint.instanceId;

  it('held outranks prompt and awaiting; the strip says held', () => {
    const badges = resolveRelayBadges({
      owed: [],
      awaiting: [relay({ id: 'p', state: 'prompt' }), relay({ id: 'w' })],
      held: [relay({ id: 'h', deliveryHold: hold('uncertain') })],
      aliasOf,
    });

    expect(badges.map((b) => b.tone)).toEqual(['held', 'prompt', 'awaiting']);
    expect(badges[0]).toMatchObject({ key: 'badgeHeld', params: { alias: 'codex' }, titleKey: 'heldTitle' });
    expect(relayBadgeClassName(badges[0])).toBe('text-warning');
    expect(resolveRelayStrip(badges)?.key).toBe('stripHeld');
  });

  it('several held are counted', () => {
    const badges = resolveRelayBadges({
      owed: [],
      awaiting: [],
      held: [relay({ id: 'h1' }), relay({ id: 'h2' })],
      aliasOf,
    });
    expect(badges[0]).toMatchObject({ key: 'badgeHeldMany', params: { count: 2 } });
    expect(resolveRelayStrip(badges)?.key).toBe('stripHeldMany');
  });

  it('negative control: no held input renders exactly as before', () => {
    expect(resolveRelayBadges({ owed: [], awaiting: [relay()], aliasOf }).map((b) => b.tone)).toEqual(['awaiting']);
  });

  it('every held key exists in both dictionaries, with matching placeholders', () => {
    const dictionaries = [
      (en as unknown as Record<string, Record<string, string>>).relay,
      (ja as unknown as Record<string, Record<string, string>>).relay,
    ];
    for (const key of ['badgeHeld', 'badgeHeldMany', 'heldTitle', 'stripHeld', 'stripHeldMany', 'unplacedHeldHeading', 'unplacedHeldLine']) {
      const [enText, jaText] = dictionaries.map((d) => d[key]);
      expect(typeof enText, key).toBe('string');
      expect(typeof jaText, key).toBe('string');
      const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(names(jaText), key).toEqual(names(enText));
    }
  });
});

describe('PC and phone parents render the hold on the requester row (Issue #4082)', () => {
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

  const heldOpen = relay({ id: 'held-open', deliveryHold: hold('uncertain') });
  const heldClosed = relay({ id: 'held-closed', state: 'expired', deliveryHold: hold('uncertain') });
  const orphan = relay({ id: 'held-orphan', from: { worktreeId: WT, instanceId: 'deleted' }, deliveryHold: hold('uncertain') });

  it('PC roster: held badge on A, no waiting badge for the same relay, orphan listed below', async () => {
    serve({ open: [heldOpen], held: [heldOpen, heldClosed, orphan] });
    render(<AgentInstancesPane {...paneProps} />);

    const badge = await screen.findByTestId('agent-instance-relay-held-claude');
    expect(badge.textContent).toContain('worktree.relay.badgeHeldMany'.replace('{count}', '2'));
    expect(badge.className).toContain('text-warning');
    expect(screen.queryByTestId('agent-instance-relay-awaiting-claude')).toBeNull();
    expect(screen.queryByTestId('agent-instance-relay-owed-codex')).toBeNull();
    expect(screen.getByTestId('relay-unplaced-held-held-orphan')).toBeInTheDocument();
  });

  it('phone roster: the same badge on the same row, the same colour', async () => {
    serve({ open: [heldOpen], held: [heldOpen] });
    render(
      <MobileAgentInstancesPane
        {...paneProps}
        visibleInstanceIds={['claude', 'codex']}
        onToggleInstanceVisible={vi.fn()}
      />
    );

    const badge = await screen.findByTestId('mobile-visible-instance-relay-held-claude');
    expect(badge.textContent).toContain('worktree.relay.badgeHeld');
    expect(badge.className).toContain('text-warning');
    expect(screen.queryByTestId('mobile-visible-instance-relay-awaiting-claude')).toBeNull();
  });

  it('negative control: an attempting relay is still drawn as waiting on both', async () => {
    const attempting = relay({ id: 'att', deliveryHold: hold('attempting') });
    serve({ open: [attempting], held: [attempting] });
    render(
      <MobileAgentInstancesPane
        {...paneProps}
        visibleInstanceIds={['claude', 'codex']}
        onToggleInstanceVisible={vi.fn()}
      />
    );

    expect(await screen.findByTestId('agent-instance-relay-awaiting-claude')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-visible-instance-relay-awaiting-claude')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-instance-relay-held-claude')).toBeNull();
    expect(screen.queryByTestId('relay-unplaced-held')).toBeNull();
  });
});
