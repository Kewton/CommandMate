/**
 * Issue #3798: a waiting episode's identity, binding, version and last close,
 * kept beside the `{ since, kind }` #1786 published (design §2.2–§2.3).
 *
 * The published shapes do not move — `getWaitingEpisode` and the transition
 * `onWaitingTransition` delivers are compared whole by the #1786 suite — so
 * the new facts are read through `getWaitingEpisodeRecord` and
 * `onWaitingEpisodeTransition`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  closeEpisode,
  getEpisodeVersion,
  getLastClosedEpisode,
  getWaitingEpisode,
  getWaitingEpisodeRecord,
  observeWaitingEdge,
  onWaitingEpisodeTransition,
  onWaitingTransition,
  openEpisode,
  rebindEpisode,
  replaceEpisode,
  type WaitingEpisodeTransition,
  type WaitingTransition,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-identity';
const PARTS = { worktreeId: WT, cliToolId: 'claude' as const, instanceId: 'claude' };
const NOW = 1_800_000_000_000;
const UNBOUND = { kind: 'unattributed' as const, generation: { kind: 'none' as const }, lastClosedTurnId: null };

beforeEach(() => {
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
});

afterEach(() => {
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
});

describe('[#3798] identity beside the published shape', () => {
  it('getWaitingEpisode and onWaitingTransition keep #1786\'s shape; the record carries the rest', () => {
    const plain: WaitingTransition[] = [];
    const rich: WaitingEpisodeTransition[] = [];
    onWaitingTransition((t) => plain.push(t));
    onWaitingEpisodeTransition((t) => rich.push(t));

    observeWaitingEdge({ ...PARTS, waiting: true, kind: 'prompt', now: NOW });
    expect(getWaitingEpisode(WT, 'claude', 'claude')).toEqual({ since: NOW, kind: 'prompt' });
    const record = getWaitingEpisodeRecord(WT, 'claude', 'claude')!;
    expect(record).toMatchObject({ since: NOW, kind: 'prompt', openedAt: NOW, boundAt: NOW, openedBy: 'legacy-edge' });
    expect(record.episodeId).toMatch(/^wep-/);

    observeWaitingEdge({ ...PARTS, waiting: false, now: NOW + 1_000 });
    expect(plain).toEqual([
      { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude', waiting: true, since: NOW, kind: 'prompt', at: NOW },
      { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude', waiting: false, since: null, kind: null, at: NOW + 1_000 },
    ]);
    expect(rich.map((t) => [t.cause, t.episodeId, t.previousEpisodeId, t.closeReason])).toEqual([
      ['opened', record.episodeId, null, null],
      ['closed', null, record.episodeId, 'screen-cleared'],
    ]);
  });

  it('an episode opened by the edge is bound from the turn model', () => {
    recordAgentEvent(WT, 'claude', 'claude', { event: 'user_prompt_submit', at: NOW, detail: null, sessionId: 's' });
    observeWaitingEdge({ ...PARTS, waiting: true, kind: 'prompt', now: NOW + 1 });
    expect(getWaitingEpisodeRecord(WT, 'claude', 'claude')?.binding).toMatchObject({ kind: 'turn' });
  });

  it('two episodes with the same since have different ids', () => {
    const a = openEpisode(PARTS, { since: NOW, kind: 'prompt', binding: UNBOUND, openedBy: 'status-probe' }, NOW);
    closeEpisode(PARTS, a.episodeId, 'screen-cleared', NOW);
    const b = openEpisode(PARTS, { since: NOW, kind: 'prompt', binding: UNBOUND, openedBy: 'status-probe' }, NOW);
    expect(b.since).toBe(a.since);
    expect(b.episodeId).not.toBe(a.episodeId);
  });
});

describe('[#3798] writes name the episode they decided about', () => {
  it('close and rebind act only on the expected id; each change moves the version', () => {
    const v0 = getEpisodeVersion(WT, 'claude', 'claude');
    const a = openEpisode(PARTS, { since: NOW, kind: 'prompt', binding: UNBOUND, openedBy: 'status-probe', promptScreenKey: 'k1' }, NOW);
    expect(getEpisodeVersion(WT, 'claude', 'claude')).toBe(v0 + 1);

    expect(rebindEpisode(PARTS, 'wep-not-this-one', { ...UNBOUND, lastClosedTurnId: 'x' }, NOW + 1)).toBe(false);
    expect(closeEpisode(PARTS, 'wep-not-this-one', 'turn-stop', NOW + 1)).toBe(false);
    expect(getEpisodeVersion(WT, 'claude', 'claude')).toBe(v0 + 1);

    const binding = { kind: 'turn' as const, generation: { kind: 'none' as const }, turnId: 't' };
    expect(rebindEpisode(PARTS, a.episodeId, binding, NOW + 2)).toBe(true);
    expect(getWaitingEpisodeRecord(WT, 'claude', 'claude')).toMatchObject({ binding, boundAt: NOW + 2, since: NOW });
    expect(getEpisodeVersion(WT, 'claude', 'claude')).toBe(v0 + 2);

    // `kind` refreshes are not a version change.
    observeWaitingEdge({ ...PARTS, waiting: true, kind: 'menu', now: NOW + 3 });
    expect(getEpisodeVersion(WT, 'claude', 'claude')).toBe(v0 + 2);

    expect(closeEpisode(PARTS, a.episodeId, 'turn-stop', NOW + 4)).toBe(true);
    expect(getEpisodeVersion(WT, 'claude', 'claude')).toBe(v0 + 3);
    expect(getLastClosedEpisode(WT, 'claude', 'claude')).toEqual({ at: NOW + 4, promptScreenKey: 'k1' });
  });

  it('a replacement is one edge: no closing edge in between, the old one recorded as closed', () => {
    const a = openEpisode(PARTS, { since: NOW, kind: 'prompt', binding: UNBOUND, openedBy: 'status-probe', promptScreenKey: 'k1' }, NOW);
    const plain: WaitingTransition[] = [];
    const rich: WaitingEpisodeTransition[] = [];
    onWaitingTransition((t) => plain.push(t));
    onWaitingEpisodeTransition((t) => rich.push(t));

    const b = replaceEpisode(
      PARTS,
      a.episodeId,
      { since: NOW + 10, kind: 'prompt', binding: UNBOUND, openedBy: 'response-checker' },
      'turn-superseded',
      NOW + 10
    )!;
    expect(plain.map((t) => t.waiting)).toEqual([true]);
    expect(rich).toEqual([
      expect.objectContaining({ cause: 'replaced', episodeId: b.episodeId, previousEpisodeId: a.episodeId, since: NOW + 10 }),
    ]);
    expect(getLastClosedEpisode(WT, 'claude', 'claude')).toEqual({ at: NOW + 10, promptScreenKey: 'k1' });
    expect(replaceEpisode(PARTS, a.episodeId, { since: 0, kind: null, binding: UNBOUND, openedBy: 'status-probe' }, 'turn-stop', 0)).toBeNull();
  });

  it('an episode written into the map directly (a test seam) is still addressable', () => {
    globalThis.__sessionWaitingEpisodes!.set(`${WT}:claude`, { since: NOW, kind: 'prompt' });
    const record = getWaitingEpisodeRecord(WT, 'claude', 'claude')!;
    expect(record.binding.kind).toBe('unattributed');
    expect(closeEpisode(PARTS, record.episodeId, 'screen-cleared', NOW + 1)).toBe(true);
    expect(getWaitingEpisode(WT, 'claude', 'claude')).toBeNull();
  });
});
