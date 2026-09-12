/**
 * Pane polling cadence profiles (Issue #2511).
 *
 * Two things this suite exists to hold in place.
 *
 * **The worktree screen's rule did not change.** `selectPanePollIntervalMs`
 * replaced an inline `? :` expression in `useTerminalPanePolling`, and the whole
 * point of #2511 is that `/worktrees/<id>` must not feel different afterwards.
 * The detail half of the table below is that old expression, enumerated over
 * every combination of its four inputs rather than spot-checked — a re-derived
 * rule that agrees on the cases someone thought to write down and disagrees on
 * one nobody did is exactly the failure this is written against. The behaviour
 * is additionally pinned against the real hook in
 * `tests/unit/hooks/useTerminalPanePolling-tile-cadence-2511`.
 *
 * **The tile profile is genuinely different, in the two ways it is supposed to
 * be.** A tile earns the fast cadence only while it is generating, and a quiet
 * tile reaches the slow cadence on connectedness alone. Both are asserted as
 * differences *from* the detail profile under identical signals, so a future
 * edit that quietly makes the two profiles agree fails here.
 */

import { describe, it, expect } from 'vitest';
import {
  DETAIL_MESSAGES_POLLING_CADENCE,
  DETAIL_PANE_POLLING_CADENCE,
  TILE_MESSAGES_POLLING_CADENCE,
  TILE_PANE_POLLING_CADENCE,
  isGeneratingStatus,
  selectMessagesPollIntervalMs,
  selectPanePollIntervalMs,
  type PaneCadenceSignals,
} from '@/config/pane-polling-cadence';

/**
 * The cadence expression `useTerminalPanePolling` carried before #2511, copied
 * verbatim from the pre-change source.
 *
 * An independent statement of the old behaviour, so "the detail profile is
 * unchanged" is checked against something other than the new implementation.
 */
function legacyDetailIntervalMs(signals: PaneCadenceSignals): number {
  return signals.connected && signals.pushHealthy && !signals.interactionActive
    ? 15000
    : signals.sessionAlive || signals.interactionActive
      ? 2000
      : 5000;
}

/** Every combination of the five boolean signals. */
function allSignalCombinations(): PaneCadenceSignals[] {
  const out: PaneCadenceSignals[] = [];
  for (const connected of [false, true]) {
    for (const pushHealthy of [false, true]) {
      for (const interactionActive of [false, true]) {
        for (const sessionAlive of [false, true]) {
          for (const generating of [false, true]) {
            out.push({ connected, pushHealthy, interactionActive, sessionAlive, generating });
          }
        }
      }
    }
  }
  return out;
}

/**
 * The combinations a pane can actually be in.
 *
 * `generating` without `sessionAlive` is not one of them: both come from the
 * same `/current-output` body, and `buildCurrentOutput` publishes
 * `sessionStatus: 'idle'` (reason `session_not_running`) whenever there is no
 * healthy session to ask. Including it would make the "a tile never polls
 * faster" invariant fail on a state no server can produce — the tile's 4s
 * active cadence against the detail profile's 5s idle one.
 */
function reachableSignalCombinations(): PaneCadenceSignals[] {
  return allSignalCombinations().filter((s) => !(s.generating && !s.sessionAlive));
}

function describeSignals(s: PaneCadenceSignals): string {
  return Object.entries(s)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join('+') || 'nothing';
}

describe('pane polling cadence profiles (Issue #2511)', () => {
  describe('the worktree screen profile reproduces the pre-#2511 rule', () => {
    it('agrees with the old expression on all 32 signal combinations', () => {
      const disagreements = allSignalCombinations().filter(
        (signals) =>
          selectPanePollIntervalMs(DETAIL_PANE_POLLING_CADENCE, signals)
          !== legacyDetailIntervalMs(signals),
      );
      expect(disagreements.map(describeSignals)).toEqual([]);
    });

    it('keeps the three published constants at 2s / 5s / 15s', () => {
      expect(DETAIL_PANE_POLLING_CADENCE.activeMs).toBe(2000);
      expect(DETAIL_PANE_POLLING_CADENCE.idleMs).toBe(5000);
      expect(DETAIL_PANE_POLLING_CADENCE.wsFallbackMs).toBe(15000);
      expect(DETAIL_MESSAGES_POLLING_CADENCE.pollMs).toBe(5000);
      expect(DETAIL_MESSAGES_POLLING_CADENCE.wsFallbackMs).toBe(15000);
    });
  });

  describe('a tile does not pay the fast cadence for a session that merely exists', () => {
    const quietButAlive: PaneCadenceSignals = {
      connected: false,
      pushHealthy: false,
      interactionActive: false,
      sessionAlive: true,
      generating: false,
    };

    it('gives the worktree screen the active cadence and a tile the idle one', () => {
      // This is finding 1 of the measurement: `isRunning` is "a tmux session
      // exists", so every tile on /sessions took the 2s branch.
      expect(selectPanePollIntervalMs(DETAIL_PANE_POLLING_CADENCE, quietButAlive)).toBe(2000);
      expect(selectPanePollIntervalMs(TILE_PANE_POLLING_CADENCE, quietButAlive)).toBe(10000);
    });

    it('still gives a tile the active cadence once it is generating', () => {
      expect(
        selectPanePollIntervalMs(TILE_PANE_POLLING_CADENCE, { ...quietButAlive, generating: true }),
      ).toBe(4000);
    });
  });

  describe('a quiet tile reaches the slow cadence without a push heartbeat', () => {
    const connectedAndQuiet: PaneCadenceSignals = {
      connected: true,
      pushHealthy: false,
      interactionActive: false,
      sessionAlive: true,
      generating: false,
    };

    it('is 15s for a tile and 2s for the worktree screen', () => {
      // Finding 2: `pushHealthy` is only ever true while a turn is being
      // recorded, so gating the slow cadence on it means the fast cadence runs
      // exactly when nothing is happening.
      expect(selectPanePollIntervalMs(TILE_PANE_POLLING_CADENCE, connectedAndQuiet)).toBe(15000);
      expect(selectPanePollIntervalMs(DETAIL_PANE_POLLING_CADENCE, connectedAndQuiet)).toBe(2000);
    });

    it('drops a GENERATING tile back to the active cadence when push goes stale', () => {
      // The recovery property the heartbeat exists for. Relaxing it for a quiet
      // pane must not relax it for a live turn, or a stalled socket would leave
      // the tile 15s behind a running agent.
      expect(
        selectPanePollIntervalMs(TILE_PANE_POLLING_CADENCE, {
          ...connectedAndQuiet,
          generating: true,
        }),
      ).toBe(4000);
    });

    it('keeps the slow cadence for a generating tile while push is healthy', () => {
      expect(
        selectPanePollIntervalMs(TILE_PANE_POLLING_CADENCE, {
          ...connectedAndQuiet,
          generating: true,
          pushHealthy: true,
        }),
      ).toBe(15000);
    });
  });

  describe('a human interaction outranks everything, on both profiles', () => {
    it.each([
      ['detail', DETAIL_PANE_POLLING_CADENCE, 2000],
      ['tile', TILE_PANE_POLLING_CADENCE, 4000],
    ] as const)('%s: a visible prompt takes the active cadence', (_name, cadence, expected) => {
      expect(
        selectPanePollIntervalMs(cadence, {
          connected: true,
          pushHealthy: true,
          interactionActive: true,
          sessionAlive: true,
          generating: false,
        }),
      ).toBe(expected);
    });
  });

  describe('isGeneratingStatus', () => {
    it.each([
      ['running', true],
      ['waiting', true],
      ['ready', false],
      ['idle', false],
      // The pane's own pre-first-poll value. Not a SessionStatus at all, and it
      // must not read as generating or every tile would start fast.
      ['', false],
    ] as const)('%s -> %s', (status, expected) => {
      expect(isGeneratingStatus(status)).toBe(expected);
    });
  });

  describe('history cadence', () => {
    it('is unchanged for the worktree screen', () => {
      expect(selectMessagesPollIntervalMs(DETAIL_MESSAGES_POLLING_CADENCE, { connected: false }))
        .toBe(5000);
      expect(selectMessagesPollIntervalMs(DETAIL_MESSAGES_POLLING_CADENCE, { connected: true }))
        .toBe(15000);
    });

    it('is slower on a tile, in both connection states', () => {
      expect(selectMessagesPollIntervalMs(TILE_MESSAGES_POLLING_CADENCE, { connected: false }))
        .toBe(15000);
      expect(selectMessagesPollIntervalMs(TILE_MESSAGES_POLLING_CADENCE, { connected: true }))
        .toBe(30000);
    });
  });

  describe('the two profiles stay apart', () => {
    it('never makes a tile poll faster than the worktree screen', () => {
      const faster = reachableSignalCombinations().filter(
        (signals) =>
          selectPanePollIntervalMs(TILE_PANE_POLLING_CADENCE, signals)
          < selectPanePollIntervalMs(DETAIL_PANE_POLLING_CADENCE, signals),
      );
      expect(faster.map(describeSignals)).toEqual([]);
    });

    it('is strictly cheaper for a quiet, connected, live-session pane', () => {
      // The steady state of /sessions, and the one the measurement is about.
      const steady: PaneCadenceSignals = {
        connected: true,
        pushHealthy: false,
        interactionActive: false,
        sessionAlive: true,
        generating: false,
      };
      expect(selectPanePollIntervalMs(TILE_PANE_POLLING_CADENCE, steady))
        .toBeGreaterThan(selectPanePollIntervalMs(DETAIL_PANE_POLLING_CADENCE, steady) * 5);
    });
  });
});
