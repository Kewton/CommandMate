/**
 * Realtime (WebSocket) message contracts shared by the server broadcasters and
 * the client consumers. Issue #1120.
 *
 * Server broadcasts are double-wrapped by `handleBroadcast` into an envelope:
 *   { type: 'broadcast', worktreeId, data: { type: '<realType>', ...payload } }
 * `parseRealtimeEvent` unwraps that envelope and returns the inner payload as
 * the canonical {@link RealtimeEvent}.
 */

import type { ChatMessage, PromptData } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * Client → server hello carrying the client bundle version, sent on every
 * (re)connect so the server can detect a version drift (#1356). Kept as a shared
 * constant so the client sender and the server handler cannot drift apart.
 */
export const CLIENT_VERSION_MESSAGE_TYPE = 'client_version' as const;

/**
 * Server → client notice that the running server version differs from this
 * tab's bundle version (#1338/#1356). Drives the reload banner.
 */
export const VERSION_MISMATCH_EVENT_TYPE = 'version_mismatch' as const;

/**
 * Whether the running server version and this tab's bundle version have drifted
 * apart and the user should be nudged to reload (#1338/#1356).
 *
 * Conservative on purpose (受入条件: 版が一致している間は誤検知しない): an empty or
 * `'0.0.0'` fallback on either side means "version unknown" and is never treated
 * as a mismatch, so a server that cannot resolve its own version stays silent.
 */
export function isVersionMismatch(serverVersion: string, clientVersion: string): boolean {
  if (!serverVersion || !clientVersion) return false;
  if (serverVersion === '0.0.0' || clientVersion === '0.0.0') return false;
  return serverVersion !== clientVersion;
}

/** Session running/stopped transition (sidebar status dots). */
export interface SessionStatusEvent {
  type: 'session_status_changed';
  worktreeId: string;
  isRunning: boolean;
  cliTool?: string | null;
  instance?: string | null;
  messagesCleared?: boolean;
}

/** New / updated chat message. */
export interface MessageBroadcastEvent {
  type: 'message' | 'message_updated';
  worktreeId: string;
  message: ChatMessage;
}

/**
 * Terminal output snapshot pushed from the server-side response poller while a
 * session is generating. Mirrors the `/current-output` payload. `version` is a
 * monotonic counter per (worktreeId, cliToolId, instanceId) so the client can
 * drop out-of-order deliveries (stale-response parity with the polling guard).
 */
export interface TerminalSnapshotEvent {
  type: 'terminal_snapshot';
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
  output: string;
  isRunning: boolean;
  thinking: boolean;
  isPromptWaiting: boolean;
  promptData?: PromptData | null;
  isSelectionListActive: boolean;
  isPagerActive: boolean;
  isUnclassifiedActive: boolean;
  version: number;
}

export interface RepositoryDeletedEvent {
  type: 'repository_deleted';
  worktreeId?: string;
  repositoryPath?: string;
  deletedWorktreeIds?: string[];
}

/**
 * Server-initiated notice that the running server version no longer matches the
 * version this tab's bundle was built from (#1338/#1356). Sent directly (not via
 * the room broadcast envelope) in response to the client's {@link
 * CLIENT_VERSION_MESSAGE_TYPE} hello. The reload banner listens for this.
 */
export interface VersionMismatchEvent {
  type: typeof VERSION_MISMATCH_EVENT_TYPE;
  serverVersion: string;
  clientVersion: string;
}

export type RealtimeEvent =
  | SessionStatusEvent
  | MessageBroadcastEvent
  | TerminalSnapshotEvent
  | RepositoryDeletedEvent
  | VersionMismatchEvent
  | { type: string; worktreeId?: string; [key: string]: unknown };

/**
 * Parse a raw WebSocket frame into the inner realtime event.
 *
 * Handles both the room broadcast envelope ({ type:'broadcast', data:{...} })
 * and (defensively) already-unwrapped frames. Returns null on malformed input
 * or frames without a usable inner `type`.
 */
export function parseRealtimeEvent(raw: string): RealtimeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const env = parsed as Record<string, unknown>;

  if (env.type === 'broadcast') {
    const inner = env.data;
    if (!inner || typeof inner !== 'object') return null;
    const innerObj = inner as Record<string, unknown>;
    if (typeof innerObj.type !== 'string') return null;
    // Ensure worktreeId is present even if the payload omitted it.
    if (innerObj.worktreeId === undefined && typeof env.worktreeId === 'string') {
      innerObj.worktreeId = env.worktreeId;
    }
    return innerObj as RealtimeEvent;
  }

  if (typeof env.type === 'string') {
    return env as RealtimeEvent;
  }
  return null;
}
