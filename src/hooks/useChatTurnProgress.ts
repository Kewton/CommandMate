/**
 * useChatTurnProgress (Issue #2199).
 *
 * The client half of `chat_turn_progress`: the body of the turn that is being
 * generated right now, for the surface that otherwise has nothing to show until
 * the turn ends.
 *
 * ## Three rules, and what each one is protecting against
 *
 *  1. **Drop anything at or below the version already rendered.** opencode's SSE
 *     re-sends its boundary frames (measured, `sources/opencode/transcript`), and
 *     the server pushes into a room rather than down one ordered pipe, so an
 *     older body arriving after a newer one is a shape that actually occurs.
 *     Rendering it would make the reply appear to shrink.
 *  2. **Nothing while the push connection is down.** There is no replay: the
 *     server publishes the next frame it produces and never the one that was
 *     missed. Holding the last body across a drop would leave a stale paragraph
 *     on screen claiming to be live, so the surface falls back to the plain
 *     "Responding…" indicator instead — which is exactly what it showed before
 *     this Issue.
 *  3. **Nothing while the caller says the session is not generating.** The hook
 *     cannot see a turn end; the settled `chat_messages` row is what ends it, and
 *     that arrives on a different event. `enabled` is the caller's answer to
 *     "should anything live be on screen at all", and flipping it clears what is
 *     held so the next turn starts from nothing.
 *
 * The fourth rule — *replace the live body with the settled row* — deliberately
 * lives at the call site rather than here: it is a question about the message
 * array (`requestId === turnKey`), and this hook does not take one. See
 * `ChatSurface`.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { useRealtime } from '@/hooks/useRealtimeConnection';
import {
  CHAT_TURN_PROGRESS_EVENT_TYPE,
  type ChatTurnProgressEvent,
  type RealtimeEvent,
} from '@/lib/realtime/types';
import type { CLIToolType } from '@/lib/cli-tools/types';

/** The live body currently held for one instance. */
export interface ChatTurnProgressView {
  /** The `requestId` the settled row will carry; the join key for the swap. */
  readonly turnKey: string;
  readonly body: string;
  /** True when the body does not start at the beginning of the turn. */
  readonly partial: boolean;
  readonly version: number;
}

export interface UseChatTurnProgressOptions {
  worktreeId: string;
  /** Absent means "no instance to match against", and nothing is ever accepted. */
  cliToolId?: CLIToolType;
  /** Defaults to `cliToolId`, the way the server resolves it before broadcasting. */
  instanceId?: string;
  /** False suppresses and clears the live body. Defaults to true. */
  enabled?: boolean;
}

/**
 * Whether a realtime frame is a `chat_turn_progress` for this exact instance.
 *
 * Exported for the unit tests, and a function rather than an inline chain
 * because it is the only thing standing between two agent instances in one
 * worktree: they share a room, so every frame for the sibling arrives here too,
 * and matching on `worktreeId` alone would paint one instance's reply into the
 * other's surface.
 */
export function isChatTurnProgressFor(
  event: RealtimeEvent,
  worktreeId: string,
  cliToolId: CLIToolType | undefined,
  resolvedInstanceId: string | undefined,
): event is ChatTurnProgressEvent {
  if (event.type !== CHAT_TURN_PROGRESS_EVENT_TYPE) return false;
  if (cliToolId === undefined || resolvedInstanceId === undefined) return false;
  const frame = event as Partial<ChatTurnProgressEvent>;
  if (frame.worktreeId !== worktreeId) return false;
  if (frame.cliToolId !== cliToolId) return false;
  if (frame.instanceId !== resolvedInstanceId) return false;
  if (typeof frame.turnKey !== 'string' || frame.turnKey.length === 0) return false;
  if (typeof frame.body !== 'string') return false;
  return typeof frame.version === 'number' && Number.isFinite(frame.version);
}

export function useChatTurnProgress({
  worktreeId,
  cliToolId,
  instanceId,
  enabled = true,
}: UseChatTurnProgressOptions): ChatTurnProgressView | null {
  const { addListener, connected } = useRealtime();
  const [progress, setProgress] = useState<ChatTurnProgressView | null>(null);
  const versionRef = useRef(0);

  const resolvedInstanceId = instanceId ?? cliToolId;

  // The version counter is per (worktree, tool, instance) on the server, so a
  // surface that starts pointing at a different one has to start counting again
  // — otherwise the new instance's frame 1 is dropped as older than the previous
  // instance's frame 40.
  useEffect(() => {
    versionRef.current = 0;
    setProgress(null);
  }, [worktreeId, cliToolId, resolvedInstanceId]);

  // Rules 2 and 3. Both clear rather than merely hide, so that whatever the next
  // turn publishes is the first thing this hook holds.
  useEffect(() => {
    if (connected && enabled) return;
    versionRef.current = 0;
    setProgress(null);
  }, [connected, enabled]);

  useEffect(() => {
    if (!enabled || cliToolId === undefined) return;
    return addListener((event: RealtimeEvent) => {
      if (!isChatTurnProgressFor(event, worktreeId, cliToolId, resolvedInstanceId)) return;
      // Rule 1. `<=` and not `<`: a re-sent boundary frame carries the version it
      // was first sent with.
      if (event.version <= versionRef.current) return;
      versionRef.current = event.version;
      setProgress({
        turnKey: event.turnKey,
        body: event.body,
        partial: event.partial === true,
        version: event.version,
      });
    });
  }, [addListener, enabled, worktreeId, cliToolId, resolvedInstanceId]);

  // Read at render time as well as cleared in an effect: the effect runs after
  // the paint that would have shown a stale body, and "the connection just
  // dropped" has to be one frame, not two.
  if (!connected || !enabled) return null;
  return progress;
}

export default useChatTurnProgress;
