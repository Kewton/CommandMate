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
 *  2. **Nothing LIVE while the push connection is down.** There is no replay: the
 *     server publishes the next frame it produces and never the one that was
 *     missed. Presenting the last body across a drop would leave a stale
 *     paragraph on screen claiming to be live, so the surface falls back to the
 *     plain "Responding…" indicator instead — which is exactly what it showed
 *     before this Issue.
 *  3. **`enabled` turning false ends the LIVE body, not the body.** The hook
 *     cannot see a turn end; the settled `chat_messages` row is what ends it, and
 *     that arrives on a different event. `enabled` is the caller's answer to
 *     "is the agent generating right now".
 *
 * The fourth rule — *replace the live body with the settled row* — deliberately
 * lives at the call site rather than here: it is a question about the message
 * array (`requestId === turnKey`), and this hook does not take one. See
 * `ChatSurface`.
 *
 * ## The hold (Issue #2248)
 *
 * Rule 3 used to *clear* on `enabled` going false, and that is the defect this
 * Issue fixes. Between "the session stopped generating" and "the settled row
 * arrived" there was nowhere for the body to be, and the gap is unbounded: a
 * turn whose row is never written (#2246's Stop-triggered write, #2247's
 * missed turns, a scrape failure, hooks not installed) took a paragraph the
 * reader had already watched being written off the screen for good.
 *
 * So the last frame is now HELD, flagged {@link ChatTurnProgressView.settling}
 * — "on screen, but not yet confirmed by a saved row". The caller draws it
 * WITHOUT the spinner and without "Responding…" (#2238's defect was a surface
 * that claimed to be generating when it was not, and a hold must not re-create
 * it). Three things end the hold, whichever comes first:
 *
 *  (a) the settled row for the same `turnKey` lands — the pre-existing swap in
 *      `ChatSurface`, which needs no change to also cover a held body;
 *  (b) a new turn starts on the same instance: `enabled` rising here, or a new
 *      row appended to the transcript, which `ChatSurface` owns;
 *  (c) {@link CHAT_TURN_SETTLING_GRACE_MS} passes.
 *
 * ## What a dropped connection does to a hold
 *
 * Nothing. Rule 2 is about a body that *claims to be live*, and a held body
 * claims the opposite; meanwhile a drop is precisely the moment there is no
 * second copy to fall back to, because there is no replay. So the drop clears a
 * LIVE body exactly as before (`enabled === true`), and leaves a held one alone.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRealtime } from '@/hooks/useRealtimeConnection';
import {
  CHAT_TURN_PROGRESS_EVENT_TYPE,
  type ChatTurnProgressEvent,
  type RealtimeEvent,
} from '@/lib/realtime/types';
import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * How long a held body may outlive its turn (Issue #2248).
 *
 * Ten minutes, and both bounds are real. Shorter and the hold expires before
 * the write that would have ended it: #2246's settled row is written from the
 * `Stop` hook, which is minutes late on a turn that ends in a long tool call.
 * Longer and a paragraph nobody confirmed sits at the end of the conversation
 * indefinitely — a hold is a bridge to the saved row, not a second history.
 */
export const CHAT_TURN_SETTLING_GRACE_MS = 10 * 60 * 1000;

/** The body currently held for one instance. */
export interface ChatTurnProgressView {
  /** The `requestId` the settled row will carry; the join key for the swap. */
  readonly turnKey: string;
  readonly body: string;
  /** True when the body does not start at the beginning of the turn. */
  readonly partial: boolean;
  readonly version: number;
  /**
   * Issue #2248: the turn is no longer generating and no settled row has
   * replaced this body yet. The caller must draw it as prose alone — no
   * spinner, no "Responding…" — because nothing is running.
   */
  readonly settling: boolean;
}

export interface UseChatTurnProgressOptions {
  worktreeId: string;
  /** Absent means "no instance to match against", and nothing is ever accepted. */
  cliToolId?: CLIToolType;
  /** Defaults to `cliToolId`, the way the server resolves it before broadcasting. */
  instanceId?: string;
  /**
   * Whether the agent is generating right now. Defaults to true. False no
   * longer discards the body — it HOLDS it (Issue #2248); see the file header.
   */
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

  // Release (b), the half this hook owns: `enabled` RISING is a new turn
  // starting on this instance, and the previous turn's held body must not be
  // what the reader sees underneath it. Clearing rather than hiding is what
  // makes the next turn's first frame the first thing on screen.
  useEffect(() => {
    if (!enabled) return;
    versionRef.current = 0;
    setProgress(null);
  }, [enabled]);

  // Rule 2, and only for a LIVE body (`enabled`). The version counter has to go
  // with it: a dropped socket is what a server restart looks like from here, and
  // the server's per-instance counter restarts at 1, which a client still
  // holding 40 would drop as stale. A HELD body survives — see the file header.
  useEffect(() => {
    if (connected || !enabled) return;
    versionRef.current = 0;
    setProgress(null);
  }, [connected, enabled]);

  // Release (c). Armed only while something is actually held, so a generating
  // surface never carries a timer, and re-armed from scratch whenever the held
  // body changes.
  useEffect(() => {
    if (enabled || progress === null) return;
    const timer = setTimeout(() => setProgress(null), CHAT_TURN_SETTLING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [enabled, progress]);

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
        settling: false,
      });
    });
  }, [addListener, enabled, worktreeId, cliToolId, resolvedInstanceId]);

  // Memoised, not rebuilt per render: `ChatSurface` memoises the object it hands
  // the transcript on this one's identity, so a fresh copy every render would
  // re-run the transcript's virtualizer for a body that has not changed.
  const held = useMemo<ChatTurnProgressView | null>(
    () => (progress === null ? null : { ...progress, settling: true }),
    [progress],
  );

  // Read at render time as well as cleared in an effect: the effect runs after
  // the paint that would have shown a stale body, and "the connection just
  // dropped" has to be one frame, not two.
  if (!enabled) return held;
  if (!connected) return null;
  return progress;
}

export default useChatTurnProgress;
