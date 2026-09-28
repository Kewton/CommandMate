/**
 * Deciding the server-side checks of OpenCode V2 (Issue #2937).
 *
 * OpenCode V2 fires no hooks (`configScope: 'none'`): CommandMate reads its
 * state from the SSE stream of an `opencode2 serve` that
 * `scripts/opencode-v2/launch.sh` starts next to the TUI. So for this tool the
 * `hook-correlation` slot of the report checks that stream instead — the event
 * names CommandMate maps (`session.execution.*`) are what an update would
 * break. The check id is reused on purpose: the report shape and the daily
 * triage prompt already know it.
 *
 * Everything here is pure; `scripts/agent-health/opencode-v2-server.ts` does
 * the I/O.
 */

import type { AgentHealthCheckStatus } from './types';

/** The frames a running turn must produce, in the order they arrive. */
export const OPENCODE_V2_REQUIRED_EVENT_TYPES: readonly string[] = [
  'session.execution.started',
  'session.execution.succeeded',
];

/** The launch wrapper's file name — what a production launch line runs. */
export const OPENCODE_V2_LAUNCH_SCRIPT_NAME = 'launch.sh';

/** One frame the recorder received, reduced to what the verdict needs. */
export interface ReceivedServerEvent {
  /** The frame's `type`, or null when it had none. */
  type: string | null;
  receivedAt: number;
}

export interface ServerEventVerdict {
  status: Exclude<AgentHealthCheckStatus, 'skip'>;
  summary: string;
  evidence?: string;
}

/** Every distinct `type`, in first-arrival order. */
export function distinctEventTypes(events: readonly ReceivedServerEvent[]): string[] {
  const seen: string[] = [];
  for (const event of events) {
    const type = event.type ?? '(type なし)';
    if (!seen.includes(type)) seen.push(type);
  }
  return seen;
}

/**
 * Whether the required events arrived while the running turn was on.
 *
 * @param events - Everything the recorder received, in arrival order
 * @param options.window - The running turn (request sent → turn judged over).
 *   Omitted when no running turn was driven; then the whole recording counts
 * @param options.streamError - Why the stream could not be opened or broke, if it did
 */
export function evaluateServerEvents(
  events: readonly ReceivedServerEvent[],
  options: { window?: { from: number; to: number }; streamError?: string | null } = {}
): ServerEventVerdict {
  const expected = `${OPENCODE_V2_REQUIRED_EVENT_TYPES.join(' と ')} が自前 serve の SSE（/api/event）に届く`;
  if (options.streamError) {
    return {
      status: 'fail',
      summary: `期待: ${expected}。実際: SSE の購読に失敗した（${options.streamError}）`,
    };
  }
  const types = distinctEventTypes(events);
  const listed = types.length === 0 ? '(なし)' : types.join(', ');
  const window = options.window;
  const inWindow = window
    ? events.filter((event) => event.receivedAt >= window.from && event.receivedAt <= window.to)
    : events;
  const missing = OPENCODE_V2_REQUIRED_EVENT_TYPES.filter(
    (type) => !inWindow.some((event) => event.type === type)
  );
  if (missing.length > 0) {
    return {
      status: 'fail',
      summary: `期待: ${expected}${window ? '（running のターンの間）' : ''}。実際: ${missing.join(' / ')} が未着（受信 ${events.length} 件、受け取った type: ${listed}）`,
      evidence: `受け取った type: ${listed}`,
    };
  }
  return {
    status: 'pass',
    summary: `${expected}（受信 ${events.length} 件、受け取った type: ${listed}）`,
  };
}

/**
 * Whether a rendered launch line is the production one — the wrapper with a
 * port and a password file — rather than the `--standalone` fallback, which
 * starts no server CommandMate can read.
 */
export function evaluateOpencodeV2LaunchLine(
  command: string
): { ok: true } | { ok: false; reason: string } {
  const viaWrapper =
    command.includes(OPENCODE_V2_LAUNCH_SCRIPT_NAME) &&
    /--port \d+/.test(command) &&
    command.includes('--password-file');
  if (viaWrapper && !command.includes('--standalone')) return { ok: true };
  return {
    ok: false,
    reason: command.includes('--standalone')
      ? `起動行が --standalone に落ちた（launch.sh と自前 serve を通らない）: ${command}`
      : `起動行が launch.sh を通らない: ${command}`,
  };
}

/** What was still there after the session was killed. */
export interface ServerLeftovers {
  port: number;
  /** Something still accepts connections on the port. */
  portBound: boolean;
  /** `opencode2 serve` processes for the port that were still alive. */
  pids: number[];
}

/** null when nothing was left; otherwise the fail that overrides the server check. */
export function evaluateServerLeftovers(leftovers: ServerLeftovers): ServerEventVerdict | null {
  if (!leftovers.portBound && leftovers.pids.length === 0) return null;
  const parts = [
    ...(leftovers.portBound ? [`ポート ${leftovers.port} が使われたまま`] : []),
    ...(leftovers.pids.length > 0 ? [`serve のプロセスが残った（pid ${leftovers.pids.join(', ')}）`] : []),
  ];
  return {
    status: 'fail',
    summary: `期待: セッション終了で launch.sh が opencode2 serve を止める（#1905 の型）。実際: ${parts.join('、')}`,
  };
}
