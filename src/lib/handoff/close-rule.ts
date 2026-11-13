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
 * clears one, and on any path that does not ask the rule.
 *
 * G-PR3 (design §4.1.1・§2.4.1 (4e), "one rule for the whole screen"): the items panel's (G-1)
 * units — a write being sent (`sending`) and the writes whose result is unknown (`unknown`, one
 * per operation slot) — live in this store too, keyed by the worktree id each was sent for.
 * Written by {@link startMemItemsWrite}, {@link settleMemItemsWrite} and {@link dropMemItemsUnit}
 * only (a {@link SentMemItemsWrite}, made by the start only, names what it settles or drops). The
 * write lock both screens read ({@link memItemsUnitsLock}, {@link handoffUnitsLock}) is the
 * store's, so a unit outlives the panel (a remount, a page left and come back to) as the
 * dialog's does, and a decide is not started while an item write is sent or unknown (nor the
 * other way round).
 *
 * pr2f (PM decision in `pm-return-4227-pr2e-codex.md`; codex review-4227-pr2d P2-1・P2-2, PM
 * Claude pr2e P3-1): what runs after an await (a decide's settle, a close, a patch of the
 * opening) carries the unit it started (a {@link SentHandoffDecide}, made by
 * {@link startHandoffDecide} only) and the opening it was for (a {@link HandoffOpeningToken},
 * made by {@link beginHandoffOpening} only), and does nothing when they are not the current
 * ones. The store has no settle, close nor patch without them: they are required by the types.
 * A stop's and a cancel's flags carry their worktree id, their unit's id (a start is refused
 * while one is set, so an end is always its own start's). Other sources import this module's
 * functions by name only: no alias (`as`) nor namespace (`* as`) — the guard fails on them.
 *
 * pr2g (codex review-4227-pr2e P2, PM Claude pr2f P3-3): the store's writers (its starts, settle,
 * drop, close, hide, patch and the flags' ends) are called where they are imported and handed on
 * nowhere — no re-export of one (same name or not, from here or from a bridge), no import of one
 * under an alias from any module, no reference that is not a call — and `import()` / `require()`
 * take a plain string. The store still hands the current opening and units to the dialog's render
 * (`handoffStoreSnapshot`, `handoffUnitsOf`, `liveHandoffOpeningFor`): a dialog drawn again and the
 * person's drop / resend of the unit shown need them (PM Claude pr2f P3-1, tracked in #4289).
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

declare const SENT_BRAND: unique symbol;
declare const OPENING_BRAND: unique symbol;
declare const ITEMS_BRAND: unique symbol;

/** A decide whose result is unknown (status 0) is sent again as it was (rule (4)). */
export interface HandoffDecideUnit {
  /** The worktree it was sent for: it is sent again there only. */
  worktreeId: string;
  requestId: string;
  ifVersion: number;
  decisions: HandoffDecision[];
}

/**
 * One sending of a decide (pr2f): made by {@link startHandoffDecide} only, a new identity per
 * sending. Its settle and its drop name it, so an old sending's settle never reaches the next one.
 */
export type SentHandoffDecide = HandoffDecideUnit & { readonly [SENT_BRAND]: true };

/** The identity of one opening (pr2f): made by {@link beginHandoffOpening} only. */
export type HandoffOpeningToken = { readonly [OPENING_BRAND]: true };

/** The units of one worktree: what may not be dropped without the person's choice. */
export interface HandoffUnits {
  readonly inflight: SentHandoffDecide | null;
  readonly pending: SentHandoffDecide | null;
  readonly stopping: boolean;
  readonly cancelling: boolean;
}

export interface HandoffOpeningTarget {
  cliToolId: string;
  instanceId: string;
  label: string;
}

/**
 * Issue #4346: one choice the person made on a proposal and has not confirmed yet, with the
 * fingerprint of what was shown when it was made (what a confirm sends).
 */
export interface HandoffChoice {
  readonly choice: 'approve' | 'discard';
  readonly fingerprint: string;
}

/** One opening of the dialog: its request as read, its text, whether it was closed. */
export interface HandoffOpening {
  /** The identity of this opening; work started for it answers nothing to another. */
  readonly token: HandoffOpeningToken;
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
  /**
   * Issue #4346: the person's choices not confirmed yet, by proposal id. The opening's, not the
   * dialog's mount: the host draws 0 dialogs on another worktree or route and the dialog is
   * unmounted, so a component state lost them on the way back to the same opening. A new opening
   * starts with none.
   */
  readonly choices: Readonly<Record<string, HandoffChoice>>;
  /**
   * Issue #4345 1b 再指示 1: the request's text is being sent for this opening (from the send to its
   * `sent` / `send-failed` answered). The opening's, not the dialog's mount: a 401 hides the dialog
   * (the host unmounts it) and the session may recover before the send's record is answered — the
   * dialog drawn again must neither offer nor send the text a second time meanwhile.
   */
  readonly textSending: boolean;
  /** Issue #4345 1b 再指示 1: an extend or a rebase of this opening is answered (the same reason). */
  readonly writing: boolean;
}

/**
 * G-PR3: one write of the items panel (G-1): the worktree it is sent to, its operation slot
 * (`add`, `update:<id>`, `close:<id>`, rule (4)(b)) and the request as the panel built it (sent
 * again as it is, rule (4)).
 */
export interface MemItemsUnit {
  readonly worktreeId: string;
  readonly slot: string;
  readonly request: unknown;
}

/** G-PR3: one sending of an items write, made by {@link startMemItemsWrite} only. */
export type SentMemItemsWrite = MemItemsUnit & { readonly [ITEMS_BRAND]: true };

/** G-PR3: the items panel's units of one worktree. */
export interface MemItemsUnits {
  readonly sending: SentMemItemsWrite | null;
  /** By slot: the writes whose result is unknown. */
  readonly unknown: Readonly<Record<string, SentMemItemsWrite>>;
}

export interface HandoffStoreState {
  /** Keyed by worktree id. */
  readonly units: Readonly<Record<string, HandoffUnits>>;
  readonly opening: HandoffOpening | null;
  /** G-PR3: the items panel's units, keyed by worktree id. */
  readonly items: Readonly<Record<string, MemItemsUnits>>;
}

const NO_UNITS: HandoffUnits = { inflight: null, pending: null, stopping: false, cancelling: false };
const NO_ITEM_UNITS: MemItemsUnits = { sending: null, unknown: {} };
const EMPTY: HandoffStoreState = { units: {}, opening: null, items: {} };
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

/**
 * Starts sending `unit` for its worktree: refused (null) while one is sent or a cancel waits
 * (condition 4). The sending it returns — a new identity, also when `unit` is the pending one
 * sent again — is what its settle names.
 */
export function startHandoffDecide(unit: HandoffDecideUnit): SentHandoffDecide | null {
  const units = handoffUnitsOf(unit.worktreeId);
  if (units.inflight !== null || units.cancelling) return null;
  // G-PR3 (rule (4)(e), one store): an items write being sent or unknown holds every decide.
  if (memItemsUnitsLock() !== null) return null;
  const sending = { worktreeId: unit.worktreeId, requestId: unit.requestId, ifVersion: unit.ifVersion, decisions: unit.decisions } as SentHandoffDecide;
  commit({ ...state, units: { ...state.units, [unit.worktreeId]: { ...units, inflight: sending } } });
  return sending;
}

/**
 * A decide's answer (the only clear but the person's drop): `unknown` keeps the sending to be sent
 * again; `answered` (applied, or refused and shown) clears it. Only for `sending` while it is the
 * one in flight (pr2f, codex P2-1): an old sending's settle (its `finally` after a reload) leaves
 * the next sending, and anything else, as it is.
 */
export function settleHandoffDecide(sending: SentHandoffDecide, outcome: 'unknown' | 'answered'): void {
  const units = handoffUnitsOf(sending.worktreeId);
  if (units.inflight !== sending) return;
  commit({
    ...state,
    units: { ...state.units, [sending.worktreeId]: { ...units, inflight: null, pending: outcome === 'unknown' ? sending : null } },
  });
}

/** The person's drop of the unknown decide shown (`unit`, "do not send it again"); another is kept. */
export function dropHandoffUnit(unit: SentHandoffDecide): void {
  const units = handoffUnitsOf(unit.worktreeId);
  if (units.pending !== unit) return;
  commit({ ...state, units: { ...state.units, [unit.worktreeId]: { ...units, pending: null } } });
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
  return { token: {} as HandoffOpeningToken, worktreeId, target: { ...target }, closed: false, created: 'no', view: null, text: null, plainOnly: null, plainStopped: false, choices: {}, textSending: false, writing: false };
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
  token: HandoffOpeningToken,
  patch: Partial<Pick<HandoffOpening, 'created' | 'view' | 'text' | 'plainOnly' | 'plainStopped' | 'choices' | 'textSending' | 'writing'>>
): void {
  if (state.opening?.token !== token) return;
  commit({ ...state, opening: { ...state.opening, ...patch } });
}

/** The opening `token` is the dialog's and has not been closed. */
export function isLiveHandoffOpening(token: HandoffOpeningToken | null): boolean {
  return token !== null && state.opening?.token === token && !state.opening.closed;
}

/**
 * The request's text may be sent for `token` (pr2e, PM P3-2): the opening is live and no cancel
 * of its worktree has started (the text after a cancel would ask the agent to propose to a
 * request that is over). Issue #4345 1b 再指示 1: nor while a send of its text has not been
 * recorded yet (`textSending`, kept over a remount of the dialog).
 */
export function handoffTextSendable(token: HandoffOpeningToken | null): boolean {
  return isLiveHandoffOpening(token) && !state.opening!.textSending && !handoffUnitsOf(state.opening!.worktreeId).cancelling;
}

function markClosed(token: HandoffOpeningToken): void {
  if (state.opening?.token === token && !state.opening.closed) commit({ ...state, opening: { ...state.opening, closed: true } });
}

/**
 * The page hid the dialog that showed the opening `token` (its `isOpen` went false): that opening
 * is over. Work started for it (a stop whose `end` answers later) goes no further. The units stay.
 * Another opening (begun since) is not touched.
 */
export function noteHandoffHidden(token: HandoffOpeningToken): void {
  markClosed(token);
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

/** G-PR3: the items panel's units of `worktreeId`. */
export function memItemsUnitsOf(worktreeId: string, snapshot: HandoffStoreState = state): MemItemsUnits {
  return snapshot.items[worktreeId] ?? NO_ITEM_UNITS;
}

/** G-PR3: every items write being sent, then every one whose result is unknown (any worktree). */
export function memItemsUnitsAll(snapshot: HandoffStoreState = state): { sending: SentMemItemsWrite | null; unknown: SentMemItemsWrite[] } {
  const all = Object.values(snapshot.items);
  return {
    sending: all.find((units) => units.sending !== null)?.sending ?? null,
    unknown: all.flatMap((units) => Object.values(units.unknown)),
  };
}

/** G-PR3: the write lock the items panel's units hold (any worktree's): sending, else unknown. */
export function memItemsUnitsLock(snapshot: HandoffStoreState = state): 'sending' | 'unknown' | null {
  const { sending, unknown } = memItemsUnitsAll(snapshot);
  if (sending !== null) return 'sending';
  return unknown.length > 0 ? 'unknown' : null;
}

/**
 * G-PR3 (rule (4)(e)): starts sending an items write. Refused (null) while any items write is
 * sent, while an unknown one of another slot or worktree waits (only its own resend is left),
 * and while a decide of the hand-off is sent or unknown. The sending it returns names its settle.
 */
export function startMemItemsWrite(unit: MemItemsUnit): SentMemItemsWrite | null {
  const { sending, unknown } = memItemsUnitsAll();
  if (sending !== null) return null;
  if (unknown.some((other) => other.worktreeId !== unit.worktreeId || other.slot !== unit.slot)) return null;
  if (handoffUnitsLock() !== null) return null;
  const started = { worktreeId: unit.worktreeId, slot: unit.slot, request: unit.request } as SentMemItemsWrite;
  const units = memItemsUnitsOf(unit.worktreeId);
  commit({ ...state, items: { ...state.items, [unit.worktreeId]: { ...units, sending: started } } });
  return started;
}

/**
 * G-PR3: an items write's answer — `unknown` keeps it for the next press (its slot's earlier one
 * replaced), `answered` clears its slot. Only for `sending` while it is the one in flight.
 */
export function settleMemItemsWrite(sending: SentMemItemsWrite, outcome: 'unknown' | 'answered'): void {
  const units = memItemsUnitsOf(sending.worktreeId);
  if (units.sending !== sending) return;
  const rest = { ...units.unknown };
  delete rest[sending.slot];
  const next = outcome === 'unknown' ? { ...rest, [sending.slot]: sending } : rest;
  commit({ ...state, items: { ...state.items, [sending.worktreeId]: { sending: null, unknown: next } } });
}

/** G-PR3: the person's "drop it without sending it again" of the unknown items write `unit`. */
export function dropMemItemsUnit(unit: SentMemItemsWrite): void {
  const units = memItemsUnitsOf(unit.worktreeId);
  if (units.unknown[unit.slot] !== unit) return;
  const rest = { ...units.unknown };
  delete rest[unit.slot];
  commit({ ...state, items: { ...state.items, [unit.worktreeId]: { ...units, unknown: rest } } });
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

/**
 * What {@link closeHandoffOpening} answers: the rule's block, or `stale` — the opening asked for
 * is not the current one (another began since), so nothing was asked nor closed.
 */
export type HandoffCloseAnswer = HandoffCloseBlock | 'stale';

/**
 * Asks the rule for `path` on behalf of the opening `token`; allowed, that opening is closed (the
 * units are not touched). pr2f (codex P2-2): the close after an await (the cancel's answer, the
 * plain stop's end) names the opening it was started for, so it never closes a newer one.
 */
export function closeHandoffOpening(token: HandoffOpeningToken, path: HandoffClosePath): HandoffCloseAnswer {
  if (state.opening?.token !== token) return 'stale';
  const block = askHandoffClose(path);
  if (block === null) markClosed(token);
  return block;
}

/** Tests only: the store as at load. */
export function resetHandoffStoreForTests(): void {
  commit(EMPTY);
}
