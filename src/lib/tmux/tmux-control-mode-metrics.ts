export interface TmuxControlModeMetricsSnapshot {
  capturePaneCalls: number;
  activeControlSessions: number;
  subscriberCount: number;
  cleanupCount: number;
  firstOutputLatency: {
    count: number;
    lastMs: number | null;
    minMs: number | null;
    maxMs: number | null;
    avgMs: number | null;
  };
}

interface TmuxControlModeMetricsState {
  capturePaneCalls: number;
  activeControlSessions: number;
  subscriberCount: number;
  cleanupCount: number;
  firstOutputLatencyCount: number;
  firstOutputLatencyTotalMs: number;
  firstOutputLatencyLastMs: number | null;
  firstOutputLatencyMinMs: number | null;
  firstOutputLatencyMaxMs: number | null;
}

const state: TmuxControlModeMetricsState = {
  capturePaneCalls: 0,
  activeControlSessions: 0,
  subscriberCount: 0,
  cleanupCount: 0,
  firstOutputLatencyCount: 0,
  firstOutputLatencyTotalMs: 0,
  firstOutputLatencyLastMs: null,
  firstOutputLatencyMinMs: null,
  firstOutputLatencyMaxMs: null,
};

export function incrementTmuxControlCapturePaneCalls(): void {
  state.capturePaneCalls += 1;
}

export function setTmuxControlActiveSessions(count: number): void {
  state.activeControlSessions = Math.max(0, count);
}

export function setTmuxControlSubscriberCount(count: number): void {
  state.subscriberCount = Math.max(0, count);
}

export function incrementTmuxControlCleanupCount(): void {
  state.cleanupCount += 1;
}

export function observeTmuxControlFirstOutputLatency(durationMs: number): void {
  const normalized = Math.max(0, Math.round(durationMs));
  state.firstOutputLatencyCount += 1;
  state.firstOutputLatencyTotalMs += normalized;
  state.firstOutputLatencyLastMs = normalized;
  state.firstOutputLatencyMinMs = state.firstOutputLatencyMinMs === null
    ? normalized
    : Math.min(state.firstOutputLatencyMinMs, normalized);
  state.firstOutputLatencyMaxMs = state.firstOutputLatencyMaxMs === null
    ? normalized
    : Math.max(state.firstOutputLatencyMaxMs, normalized);
}

export function getTmuxControlModeMetrics(): TmuxControlModeMetricsSnapshot {
  return {
    capturePaneCalls: state.capturePaneCalls,
    activeControlSessions: state.activeControlSessions,
    subscriberCount: state.subscriberCount,
    cleanupCount: state.cleanupCount,
    firstOutputLatency: {
      count: state.firstOutputLatencyCount,
      lastMs: state.firstOutputLatencyLastMs,
      minMs: state.firstOutputLatencyMinMs,
      maxMs: state.firstOutputLatencyMaxMs,
      avgMs: state.firstOutputLatencyCount > 0
        ? Math.round(state.firstOutputLatencyTotalMs / state.firstOutputLatencyCount)
        : null,
    },
  };
}

export function resetTmuxControlModeMetrics(): void {
  state.capturePaneCalls = 0;
  state.activeControlSessions = 0;
  state.subscriberCount = 0;
  state.cleanupCount = 0;
  state.firstOutputLatencyCount = 0;
  state.firstOutputLatencyTotalMs = 0;
  state.firstOutputLatencyLastMs = null;
  state.firstOutputLatencyMinMs = null;
  state.firstOutputLatencyMaxMs = null;
}
