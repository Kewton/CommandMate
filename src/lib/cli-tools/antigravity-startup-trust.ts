/**
 * agy's startup folder-trust confirmation that the launch window did not see
 * (Issue #3757).
 *
 * `AntigravityTool.waitForReady` confirms the trust screen with one Enter, but
 * only inside its ~34 s window, and agy's start-up time varies from about one
 * second to more than a minute (measured: the screen appeared 61 s after the
 * launch). A window that ends before agy has drawn anything leaves the screen
 * unanswered, and the launch still reports success.
 *
 * This records that one Enter is still owed to the session, so the next send's
 * readiness wait can deliver it — exactly once. The claim is synchronous and
 * removes the record, so two waits racing over one pane cannot both send it,
 * and a window that already sent its Enter never records one.
 *
 * It also knows whether the launch window is still open (review of #3757): a
 * trust screen inside it is the window's to confirm within a second or two, so
 * the Auto-Yes poller records no `startup-trust-unhandled` for it.
 *
 * And it keeps the owed Enter and the strict `respond` (Issue #3756) from both
 * answering one trust screen: while a strict answer holds the session
 * ({@link holdStartupTrust}), the Enter cannot be claimed, and a strict answer
 * refuses a session whose Enter was claimed moments ago
 * ({@link wasStartupTrustClaimedWithin}) — the two are serialised per session
 * name here, where both sides look.
 *
 * Keyed by tmux session name. Reached through `globalThis` because the writer
 * (the launch) and the reader (a send, from another route handler) may be
 * bundled separately under `next dev` (Issue #1736).
 *
 * @module lib/cli-tools/antigravity-startup-trust
 */

import { getOrInitGlobal } from '../global-state';

declare global {
  // eslint-disable-next-line no-var
  var __antigravityStartupTrustPending: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __antigravityStartupWindows: Set<string> | undefined;
  // eslint-disable-next-line no-var
  var __antigravityStartupTrustHolds: Set<string> | undefined;
  // eslint-disable-next-line no-var
  var __antigravityStartupTrustClaims: Map<string, number> | undefined;
}

/** sessionName -> epoch ms the launch window ended without confirming trust. */
const pendingStartupTrust = getOrInitGlobal('__antigravityStartupTrustPending', () => new Map<string, number>());

/** Sessions whose launch window (launch line typed → `waitForReady` returned) is open. */
const openStartupWindows = getOrInitGlobal('__antigravityStartupWindows', () => new Set<string>());

/** Sessions a strict `respond` is answering right now (Issue #3756). */
const strictAnswerHolds = getOrInitGlobal('__antigravityStartupTrustHolds', () => new Set<string>());

/** sessionName -> epoch ms the owed Enter was last claimed. */
const lastClaims = getOrInitGlobal('__antigravityStartupTrustClaims', () => new Map<string, number>());

/** The launch window opened: the launch confirms any trust screen in it. */
export function beginStartupWindow(sessionName: string): void {
  openStartupWindows.add(sessionName);
}

/** The launch window closed, however it ended. */
export function endStartupWindow(sessionName: string): void {
  openStartupWindows.delete(sessionName);
}

/**
 * @returns True while the launch window is open. A session this process never
 *   launched (a server restart, another launcher) has none open.
 */
export function isStartupWindowOpen(sessionName: string): boolean {
  return openStartupWindows.has(sessionName);
}

/** Record that the launch window ended with the trust screen not yet confirmed. */
export function markStartupTrustPending(sessionName: string, at: number = Date.now()): void {
  pendingStartupTrust.set(sessionName, at);
}

/** @returns True while the launch's trust Enter is still owed to this session. */
export function isStartupTrustPending(sessionName: string): boolean {
  return pendingStartupTrust.has(sessionName);
}

/**
 * Take the owed Enter. True at most once per record: the caller that gets true
 * is the one that sends it. False while a strict `respond` holds the session
 * (Issue #3756): the record is kept, and is the strict answer's to discard.
 */
export function claimStartupTrust(sessionName: string, at: number = Date.now()): boolean {
  if (strictAnswerHolds.has(sessionName)) return false;
  const claimed = pendingStartupTrust.delete(sessionName);
  if (claimed) lastClaims.set(sessionName, at);
  return claimed;
}

/**
 * Whether the owed Enter was claimed within the last `ms` — its Enter may be
 * on its way, or agy may not have redrawn after it yet (Issue #3756).
 */
export function wasStartupTrustClaimedWithin(sessionName: string, ms: number, now: number = Date.now()): boolean {
  const at = lastClaims.get(sessionName);
  return at !== undefined && now - at < ms;
}

/**
 * Hold the session for a strict `respond` (Issue #3756): until the returned
 * release is called, {@link claimStartupTrust} answers false for it.
 */
export function holdStartupTrust(sessionName: string): () => void {
  strictAnswerHolds.add(sessionName);
  return () => {
    strictAnswerHolds.delete(sessionName);
  };
}

/** Drop the record: the session was relaunched, killed, or reached its prompt. */
export function forgetStartupTrust(sessionName: string): void {
  pendingStartupTrust.delete(sessionName);
}

/** Drop every record. Test seam. */
export function clearStartupTrust(): void {
  pendingStartupTrust.clear();
  openStartupWindows.clear();
  strictAnswerHolds.clear();
  lastClaims.clear();
}
