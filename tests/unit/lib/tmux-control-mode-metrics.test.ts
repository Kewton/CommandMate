import { beforeEach, describe, expect, it } from 'vitest';
import {
  getTmuxControlModeMetrics,
  incrementTmuxControlCapturePaneCalls,
  incrementTmuxControlCleanupCount,
  observeTmuxControlFirstOutputLatency,
  resetTmuxControlModeMetrics,
  setTmuxControlActiveSessions,
  setTmuxControlSubscriberCount,
} from '@/lib/tmux/tmux-control-mode-metrics';

describe('tmux-control-mode-metrics', () => {
  beforeEach(() => {
    resetTmuxControlModeMetrics();
  });

  it('tracks counters and latency aggregates', () => {
    incrementTmuxControlCapturePaneCalls();
    incrementTmuxControlCapturePaneCalls();
    incrementTmuxControlCleanupCount();
    setTmuxControlActiveSessions(3);
    setTmuxControlSubscriberCount(5);
    observeTmuxControlFirstOutputLatency(22);
    observeTmuxControlFirstOutputLatency(38);

    expect(getTmuxControlModeMetrics()).toEqual({
      capturePaneCalls: 2,
      activeControlSessions: 3,
      subscriberCount: 5,
      cleanupCount: 1,
      firstOutputLatency: {
        count: 2,
        lastMs: 38,
        minMs: 22,
        maxMs: 38,
        avgMs: 30,
      },
    });
  });

  it('resets state', () => {
    incrementTmuxControlCapturePaneCalls();
    observeTmuxControlFirstOutputLatency(10);

    resetTmuxControlModeMetrics();

    expect(getTmuxControlModeMetrics()).toEqual({
      capturePaneCalls: 0,
      activeControlSessions: 0,
      subscriberCount: 0,
      cleanupCount: 0,
      firstOutputLatency: {
        count: 0,
        lastMs: null,
        minMs: null,
        maxMs: null,
        avgMs: null,
      },
    });
  });
});
