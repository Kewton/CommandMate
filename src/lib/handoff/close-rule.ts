/**
 * The one rule for making the hand-off dialog (G-4) go away, and the store of what it holds
 * (Issue #4227 G-PR2 pr2d・pr2e, design `mem-ui-4227.md` §4.1.1; PM decisions in
 * `pm-return-4227-pr2c-codex.md` and `pm-review-4227-pr2d-claude.md`).
 *
 * The invariant: a decide being sent or whose result is unknown is never dropped by any
 * path that makes the dialog go away without the person's choice (send it again / drop it),
 * and while there is one the dialog stays; once a cancel has started, no new decide nor the
 * request's text is sent. Every path — the person's (Esc, ×, the backdrop, "cancel the end",
 * "close", "keep the session"), the cancel's answer, the plain stop's end, a switch of
 * worktree, and the page opening another "end" — asks {@link askHandoffClose} with its name.
 *
 * pr2e (PM P2-1, codex P2-1): what the dialog holds — the units (a decide being sent, one
 * whose result is unknown, a stop running, a cancel waiting) and the opening (its request,
 * its text, its target) — lives here, keyed by the worktree id, not in the dialog's state.
 * The dialog drawn again (PC ↔ phone, a turn of the device, a change of width, the page's
 * Loading between two worktrees) reads the same store, so nothing is lost and no second
 * request is made. A unit is cleared by two functions only: {@link settleHandoffDecide} (a
 * decide's answer) and {@link dropHandoffUnit} (the person's drop). The guard
 * `tests/unit/guards/handoff-close-paths-4227.test.ts` fails on any other reference that
 * clears one, and on any path that does not ask the rule. G-PR3 puts the items panel's units
 * in the same store.
 *
 * @module lib/handoff/close-rule
 */
import type { HandoffDecision } from './screen-client';
import type { HandoffReadResponse } from './types';

/** What the dialog holds now. */
export interface HandoffHold {
  /** The stop is being declared or run (`end` → the existing stop → `end/observe`). */
  stopping: boolean;
  /** A decide is being sent (it may come back unknown). */
  sending: boolean;
  /** A decide whose result is unknown is kept. */
  unknown: boolean;
  /** The request's cancel has been sent and not answered. */
  cancelling?: boolean;
}

/**
 * Why the dialog may not go away now: `stopping`, `unknown` (being sent or unknown),
 * `cancelling`, or `null` (it may).
 */
export type HandoffCloseBlock = 'stopping' | 'unknown' | 'cancelling' | null;

export function handoffCloseBlock(state: HandoffHold): HandoffCloseBlock {
  if (state.stopping) return 'stopping';
  if (state.sending || state.unknown) return 'unknown';
  if (state.cancelling) return 'cancelling';
  return null;
}

/**
 * Every path that makes the dialog go away. `person`, `cancel-answer` and `plain-stop-done`
 * are the dialog's own; `worktree-switch` and `page-end` are the page's; `dialog` is the
 * page closing it when the dialog asked (the dialog has asked already, and the page asks again).
 */
export const HANDOFF_CLOSE_PATHS = ['person', 'cancel-answer', 'plain-stop-done', 'worktree-switch', 'page-end', 'dialog'] as const;
export type HandoffClosePath = (typeof HANDOFF_CLOSE_PATHS)[number];

/** The paths the page takes without the dialog having asked: a refusal is told to the dialog. */
const PAGE_PATHS: ReadonlySet<HandoffClosePath> = new Set(['worktree-switch', 'page-end']);

/**
 * What the existing stop (kill-session) answered (pr2e, codex P2-2): only `stopped` is a stop;
 * `refused` and `failed` leave the session running, `unknown` says nothing (offline, past the
 * deadline, or another kill in flight). The plain stop says "stopped" for `stopped` only.
 */
export type SessionStopResult = 'stopped' | 'refused' | 'failed' | 'unknown';

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

/** A decide whose result is unknown (status 0) is sent again as it was (rule (4)). */
export interface HandoffDecideUnit {
  /** The worktree it was sent for: it is sent again there only. */
  worktreeId: string;
  requestId: string;
  ifVersion: number;
  decisions: HandoffDecision[];
}

/** The units of one worktree: what may not be dropped without the person's choice. */
export interface HandoffUnits {
  readonly inflight: HandoffDecideUnit | null;
  readonly pending: HandoffDecideUnit | null;
  readonly stopping: boolean;
  readonly cancelling: boolean;
}

export interface HandoffOpeningTarget {
  cliToolId: string;
  instanceId: string;
  label: string;
}

/** One opening of the dialog: its request as read, its text, whether it was closed. */
export interface HandoffOpening {
  /** The identity of this opening; work started for it answers nothing to another. */
  readonly token: object;
  /** The worktree it was opened for (kept over a switch of worktree: "foreign" on another's page). */
  readonly worktreeId: string;
  readonly target: HandoffOpeningTarget;
  /** The page closed it (through the rule) or it was hidden; a new opening starts afresh. */
  readonly closed: boolean;
  /** `create` not sent / in flight / answered: drawn again, the dialog does not create twice. */
  readonly created: 'no' | 'creating' | 'done';
  readonly view: HandoffReadResponse | null;
  readonly text: string | null;
  /** No request could be made: the plain stop only (the reason to show). */
  readonly plainOnly: string | null;
  /** The plain stop stopped the session but a decide is unknown, so the dialog stayed. */
  readonly plainStopped: boolean;
}

export interface HandoffStoreState {
  /** Keyed by worktree id. */
  readonly units: Readonly<Record<string, HandoffUnits>>;
  readonly opening: HandoffOpening | null;
}

const NO_UNITS: HandoffUnits = { inflight: null, pending: null, stopping: false, cancelling: false };
const EMPTY: HandoffStoreState = { units: {}, opening: null };
let state: HandoffStoreState = EMPTY;
const listeners = new Set<() => void>();

function commit(next: HandoffStoreState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

/** For `useSyncExternalStore`. */
export function subscribeHandoffStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function handoffStoreSnapshot(): HandoffStoreState {
  return state;
}

export function handoffUnitsOf(worktreeId: string): HandoffUnits {
  return state.units[worktreeId] ?? NO_UNITS;
}

/**
 * The flags of a worktree's units. The decide's units (`inflight`, `pending`) are written by
 * {@link startHandoffDecide}, {@link settleHandoffDecide} and {@link dropHandoffUnit} only.
 */
function writeFlags(worktreeId: string, flags: Partial<Pick<HandoffUnits, 'stopping' | 'cancelling'>>): void {
  commit({ ...state, units: { ...state.units, [worktreeId]: { ...handoffUnitsOf(worktreeId), ...flags } } });
}

/** Starts sending `unit` for its worktree: refused while one is sent or a cancel waits (condition 4). */
export function startHandoffDecide(unit: HandoffDecideUnit): boolean {
  const units = handoffUnitsOf(unit.worktreeId);
  if (units.inflight !== null || units.cancelling) return false;
  commit({ ...state, units: { ...state.units, [unit.worktreeId]: { ...units, inflight: unit } } });
  return true;
}

/**
 * A decide's answer (the only clear but the person's drop): `unknown` keeps the unit that was
 * sent to be sent again; `answered` (applied, or refused and shown) clears it. Nothing in flight:
 * nothing changes.
 */
export function settleHandoffDecide(worktreeId: string, outcome: 'unknown' | 'answered'): void {
  const units = handoffUnitsOf(worktreeId);
  if (units.inflight === null) return;
  commit({
    ...state,
    units: { ...state.units, [worktreeId]: { ...units, inflight: null, pending: outcome === 'unknown' ? units.inflight : null } },
  });
}

/** The person's drop of the unknown decide ("do not send it again"). */
export function dropHandoffUnit(worktreeId: string): void {
  const units = handoffUnitsOf(worktreeId);
  if (units.pending === null) return;
  commit({ ...state, units: { ...state.units, [worktreeId]: { ...units, pending: null } } });
}

/** Starts the stop: refused while one runs or a cancel waits. */
export function startHandoffStop(worktreeId: string): boolean {
  const units = handoffUnitsOf(worktreeId);
  if (units.stopping || units.cancelling) return false;
  writeFlags(worktreeId, { stopping: true });
  return true;
}

export function endHandoffStop(worktreeId: string): void {
  writeFlags(worktreeId, { stopping: false });
}

/** Starts the cancel: refused while one waits. While it waits no decide, text nor stop is sent. */
export function startHandoffCancel(worktreeId: string): boolean {
  if (handoffUnitsOf(worktreeId).cancelling) return false;
  writeFlags(worktreeId, { cancelling: true });
  return true;
}

export function endHandoffCancel(worktreeId: string): void {
  writeFlags(worktreeId, { cancelling: false });
}

function freshOpening(worktreeId: string, target: HandoffOpeningTarget): HandoffOpening {
  return { token: {}, worktreeId, target: { ...target }, closed: false, created: 'no', view: null, text: null, plainOnly: null, plainStopped: false };
}

/**
 * A new opening of the dialog for `target` on `worktreeId` (the page's "end", or the dialog shown
 * again). It replaces the opening, never the units: an unknown decide of the worktree stays.
 */
export function beginHandoffOpening(worktreeId: string, target: HandoffOpeningTarget): HandoffOpening {
  const opening = freshOpening(worktreeId, target);
  commit({ ...state, opening });
  return opening;
}

/**
 * The opening the dialog drawn again finds (PC ↔ phone, the page's Loading, a remount): the
 * current one while it is not closed and is for the same instance.
 */
export function liveHandoffOpeningFor(instanceId: string): HandoffOpening | null {
  const current = state.opening;
  return current && !current.closed && current.target.instanceId === instanceId ? current : null;
}

/** Writes what the opening `token` learnt (nothing once another opening started). */
export function patchHandoffOpening(
  token: object,
  patch: Partial<Pick<HandoffOpening, 'created' | 'view' | 'text' | 'plainOnly' | 'plainStopped'>>
): void {
  if (state.opening?.token !== token) return;
  commit({ ...state, opening: { ...state.opening, ...patch } });
}

/** The opening `token` is the dialog's and has not been closed. */
export function isLiveHandoffOpening(token: object | null): boolean {
  return token !== null && state.opening?.token === token && !state.opening.closed;
}

/**
 * The request's text may be sent for `token` (pr2e, PM P3-2): the opening is live and no cancel
 * of its worktree has started (the text after a cancel would ask the agent to propose to a
 * request that is over).
 */
export function handoffTextSendable(token: object | null): boolean {
  return isLiveHandoffOpening(token) && !handoffUnitsOf(state.opening!.worktreeId).cancelling;
}

function markClosed(): void {
  if (state.opening && !state.opening.closed) commit({ ...state, opening: { ...state.opening, closed: true } });
}

/**
 * The page hid the dialog (its `isOpen` went false): the opening is over. Work started for it
 * (a stop whose `end` answers later) goes no further. The units stay.
 */
export function noteHandoffHidden(): void {
  markClosed();
}

/** What the open dialog holds now: the units of the worktree it was opened for. */
export function currentHandoffHold(): HandoffHold {
  const opening = state.opening;
  const units = opening ? handoffUnitsOf(opening.worktreeId) : NO_UNITS;
  return { stopping: units.stopping, sending: units.inflight !== null, unknown: units.pending !== null, cancelling: units.cancelling };
}

/** The write lock the dialog's units hold over mem items (any worktree's): sending, else unknown. */
export function handoffUnitsLock(snapshot: HandoffStoreState = state): 'sending' | 'unknown' | null {
  const all = Object.values(snapshot.units);
  if (all.some((units) => units.inflight !== null)) return 'sending';
  if (all.some((units) => units.pending !== null)) return 'unknown';
  return null;
}

type RefusalListener = (path: HandoffClosePath, block: Exclude<HandoffCloseBlock, null>) => void;
const refusalListeners = new Set<RefusalListener>();

/** The mounted dialog is told when a page path was refused, so it can say why. */
export function listenHandoffRefusal(listener: RefusalListener): () => void {
  refusalListeners.add(listener);
  return () => {
    refusalListeners.delete(listener);
  };
}

/**
 * Asks the rule for `path`. `hold` defaults to what the open dialog holds now. A page path
 * that is refused is told to the dialog.
 */
export function askHandoffClose(path: HandoffClosePath, hold: HandoffHold = currentHandoffHold()): HandoffCloseBlock {
  const block = handoffCloseBlock(hold);
  if (block !== null && PAGE_PATHS.has(path)) for (const listener of [...refusalListeners]) listener(path, block);
  return block;
}

/** Asks the rule for `path`; allowed, the opening is closed (the units are not touched). */
export function closeHandoffOpening(path: HandoffClosePath): HandoffCloseBlock {
  const block = askHandoffClose(path);
  if (block === null) markClosed();
  return block;
}

/** Tests only: the store as at load. */
export function resetHandoffStoreForTests(): void {
  commit(EMPTY);
}
