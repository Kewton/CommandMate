/**
 * The upstream-fault edge and its cooldown (Issue #2000).
 *
 * `upstreamFault` is a level that is re-read on every poll, so the property
 * under test is not "does a fault produce a decision" but "does ONE incident
 * produce ONE decision to notify". The measured failure this guards against is
 * a 529 retry storm: the banner scrolls in and out of the 100-row window the
 * match is judged on, and its wording alternates between the `overloaded` and
 * `retrying` signatures, so a pure open/close edge fires repeatedly for a single
 * incident.
 *
 * `now` is passed explicitly throughout — no fake timers — so the assertions are
 * about the boundary values rather than about how a clock was advanced.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UPSTREAM_FAULT_COOLDOWN_MS,
  clearUpstreamFaultEpisodes,
  observeUpstreamFaultEdge,
} from '@/lib/push/failure-episode-state';

const WT = 'wt-2000-edge';
const T0 = 1_800_000_000_000;

function observe(faultId: string | null, now: number, instanceId?: string) {
  return observeUpstreamFaultEdge({
    worktreeId: WT,
    cliToolId: 'claude',
    instanceId,
    faultId,
    now,
  });
}

beforeEach(() => {
  clearUpstreamFaultEpisodes();
});

afterEach(() => {
  clearUpstreamFaultEpisodes();
});

describe('observeUpstreamFaultEdge (Issue #2000)', () => {
  it('notifies once when a fault first appears', () => {
    const edge = observe('overloaded', T0);
    expect(edge).toMatchObject({ notify: true, reason: 'new-episode', since: T0 });
  });

  it('says nothing for the same fault still on the frame', () => {
    observe('overloaded', T0);

    // A 2 s poll interval over a minute of the same banner.
    for (let i = 1; i <= 30; i += 1) {
      const edge = observe('overloaded', T0 + i * 2_000);
      expect(edge.notify).toBe(false);
      expect(edge.reason).toBe('same-episode');
      // The episode's start is frozen, exactly like #1786's waiting episode.
      expect(edge.since).toBe(T0);
    }
  });

  it('reports a clean frame without notifying, and closes the episode', () => {
    observe('overloaded', T0);
    const edge = observe(null, T0 + 5_000);
    expect(edge).toMatchObject({ notify: false, reason: 'no-fault', since: null });
  });

  it('does not re-notify when the same incident scrolls back into the window', () => {
    expect(observe('overloaded', T0).notify).toBe(true);
    // The banner leaves the last 100 rows as the agent keeps printing...
    observe(null, T0 + 4_000);
    // ...and the next retry puts it straight back.
    const edge = observe('overloaded', T0 + 8_000);

    expect(edge.notify).toBe(false);
    expect(edge.reason).toBe('cooldown');
    expect(edge.cooldownRemainingMs).toBe(UPSTREAM_FAULT_COOLDOWN_MS - 8_000);
  });

  it('does not re-notify when the storm alternates between two signatures', () => {
    // Measured shape of a 529 storm (#1839): the `API Error: Repeated 529
    // Overloaded errors …` line and the `Retrying in 34s · attempt 9/10` line
    // match different entries in the table and take turns on the frame.
    expect(observe('overloaded', T0).notify).toBe(true);

    const ids = ['retrying', 'overloaded', 'retrying', 'api-error', 'retrying'];
    ids.forEach((id, i) => {
      const edge = observe(id, T0 + (i + 1) * 3_000);
      expect(edge.notify, `signature ${id} re-notified`).toBe(false);
      expect(edge.reason).toBe('cooldown');
    });
  });

  it('notifies again for an incident past the cooldown', () => {
    expect(observe('overloaded', T0).notify).toBe(true);
    observe(null, T0 + 60_000);

    // One millisecond short of the boundary is still the same incident...
    const inside = observe('overloaded', T0 + UPSTREAM_FAULT_COOLDOWN_MS - 1);
    expect(inside.notify).toBe(false);
    observe(null, T0 + UPSTREAM_FAULT_COOLDOWN_MS - 1 + 1_000);

    // ...and at the boundary it is a new one.
    const outside = observe('overloaded', T0 + UPSTREAM_FAULT_COOLDOWN_MS * 2);
    expect(outside).toMatchObject({ notify: true, reason: 'new-episode' });
  });

  it('keeps one cooldown per agent instance', () => {
    expect(observe('overloaded', T0, 'claude').notify).toBe(true);

    // A second instance in the same worktree is a separate session with a
    // separate stall, so it gets its own notification.
    expect(observe('overloaded', T0 + 1_000, 'claude-2').notify).toBe(true);

    // ...and its own cooldown afterwards.
    observe(null, T0 + 2_000, 'claude-2');
    expect(observe('overloaded', T0 + 3_000, 'claude-2').notify).toBe(false);
  });

  it('forgets a session that never notified, so a clean server keeps no state', () => {
    // A frame with no fault must not seed an entry — the poller hands every
    // session's every frame to this function.
    const edge = observe(null, T0);
    expect(edge.reason).toBe('no-fault');

    // The next fault is genuinely new: nothing was remembered to collapse it into.
    expect(observe('limit-reached', T0 + 1_000).notify).toBe(true);
  });

  it('honours an explicit cooldown, so the bound is a value and not a hard-coded rule', () => {
    expect(
      observeUpstreamFaultEdge({
        worktreeId: WT,
        cliToolId: 'claude',
        faultId: 'overloaded',
        now: T0,
        cooldownMs: 1_000,
      }).notify
    ).toBe(true);
    observeUpstreamFaultEdge({ worktreeId: WT, cliToolId: 'claude', faultId: null, now: T0 + 100 });

    expect(
      observeUpstreamFaultEdge({
        worktreeId: WT,
        cliToolId: 'claude',
        faultId: 'overloaded',
        now: T0 + 2_000,
        cooldownMs: 1_000,
      }).notify
    ).toBe(true);
  });
});
