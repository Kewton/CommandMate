/**
 * G-4: the hand-off before a session ends, on a branch set to be attended with mode `on`
 * (Issue #4227, design `mem-ui-4227.md` §4.1, 6th edition: the hand-off never kills).
 *
 * The request is made when the dialog opens; its text is sent to the agent; the agent's
 * proposals are shown as differences; a person approves or discards each and confirms;
 * then the person presses the existing stop. Only the stop button's handler stops the
 * session, in this order: `end` (the declaration) → `onStop` (the existing stop, the same
 * one the plain "end" confirmation runs) → `end/observe` (the server sees whether it
 * stopped and records it). Nothing else here — no effect, timer, decide's answer or
 * expiry — reaches `onStop` (H15(f)).
 *
 * The approval writes items, so it follows the items panel's rules (§2.4.1): the
 * decide sent with the selections the person made only, the request's version as read,
 * a result that is unknown kept and sent again as it was, and while one is being sent
 * or unknown no other write of items (rule (4)(e)) — here and in the items panel (the
 * shared lock, PM P3-3). Cancelling and stopping are not writes of items and stay.
 *
 * Going away (pr2d, design §4.1.1): every path — the person's, the cancel's answer, the plain
 * stop's end, and the page's switch of worktree and other "end" — asks the one rule in
 * `@/lib/handoff/close-rule`; a decide being sent or unknown is never dropped without the
 * person's choice, and once a cancel has started no decide nor the request's text is sent.
 *
 * What it holds (pr2e, design §4.1.1): the units and the opening live in the store of
 * `@/lib/handoff/close-rule`, keyed by the worktree id — not in this component's state — so
 * the dialog drawn again (PC ↔ phone, the page's Loading between worktrees, a remount) keeps
 * them and makes no second request. The person's choices not confirmed yet are the opening's too
 * (Issue #4346: kept over another worktree or route, where the host draws no dialog); only the
 * notice is local (Issue #4345 1b 再指示 1: the text's send in flight and an extend / rebase in flight
 * are the opening's too — a 401 unmounts the dialog, and the one drawn again after the recovery
 * must not send them again before the first is answered).
 *
 * After an await (pr2f, design §4.1.1): every continuation — a decide's settle, a close, a patch
 * of the opening, a notice — carries the sending it started and the opening it was for, and does
 * nothing once they are not the current ones (the store's API requires them).
 *
 * The page's registration (Issue #4317 PR1, `@/lib/handoff/page-registration`): a page hands the
 * dialog its `registration`. The dialog starts nothing new — no close (×, Escape, the backdrop and
 * the buttons alike), stop, decide, write, text or drop — unless that registration is the current
 * one and the session is not expired (再指示 2, `handoffPageMayStart`), checked when pressed and again after each await before anything new begins (the stop after
 * `end`'s answer, the close after a cancel's or a plain stop's answer). Meanwhile it is still drawn,
 * its buttons disabled. What was already sent finishes for its own unit and destination: a decide's
 * settle, the answer of `end` / a cancel / a kill adopted into the opening and `end/observe` sent.
 *
 * Issue #4345 1b: every request of the dialog (create, read, the text and its `sent` /
 * `send-failed`, decide, extend, rebase, cancel, end, observe) belongs to the registration the
 * dialog was handed when its operation started — the page that shows it, also for a foreign
 * opening (never one looked up from the opening's worktree) — and reports its answer through the
 * gateway of `@/lib/handoff/page-registration` (`@/lib/handoff/screen-client` reports a 401 before
 * the body is read). Taking that report is apart from {@link handoffPageMayStart}: an expiry taken
 * stops what is new (the host draws no dialog, `registered()` is false), never what was sent — the
 * text's `sent` / `send-failed`, a decide's settle and `end/observe` still go to their own opening.
 * A create answered by a 401 taken leaves its opening as before the create (`created: 'no'`), so
 * the same opening makes its request once the page's detail read recovers the session.
 *
 * @module components/mem/SessionHandoffDialog
 */
'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Modal } from '@/components/ui';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useMemWriteLock } from '@/components/mem/mem-write-lock';
import { handoffApi, type HandoffDecision, type HandoffResult } from '@/lib/handoff/screen-client';
import {
  handoffPageMayStart,
  handoffRegistrySnapshot,
  subscribeHandoffRegistry,
  beginHandoffPageOperationFor,
  type HandoffPageOperation,
  type HandoffPageRegistration,
} from '@/lib/handoff/page-registration';
import {
  askHandoffClose,
  beginHandoffOpening,
  closeHandoffOpening,
  dropHandoffUnit,
  endHandoffCancel,
  endHandoffStop,
  handoffStoreSnapshot,
  handoffTextSendable,
  handoffUnitsLock,
  memItemsUnitsLock,
  handoffUnitsOf,
  isLiveHandoffOpening,
  listenHandoffRefusal,
  liveHandoffOpeningFor,
  noteHandoffHidden,
  patchHandoffOpening,
  settleHandoffDecide,
  startHandoffCancel,
  startHandoffDecide,
  startHandoffStop,
  subscribeHandoffStore,
  type HandoffCloseBlock,
  type HandoffClosePath,
  type HandoffChoice,
  type HandoffDecideUnit,
  type HandoffOpening,
  type HandoffOpeningToken,
  type SessionStopResult,
} from '@/lib/handoff/close-rule';
import type { HandoffProposalView, HandoffReadResponse } from '@/lib/handoff/types';
import type { MemCloseWhen, MemItemView } from '@/types/mem';

export interface SessionHandoffTarget {
  cliToolId: string;
  instanceId: string;
  label: string;
}

export interface SessionHandoffDialogProps {
  isOpen: boolean;
  worktreeId: string;
  target: SessionHandoffTarget | null;
  onClose: () => void;
  /**
   * The existing stop (kill-session). Called from the stop buttons' handlers only. It says how
   * it ended (pr2e, codex P2-2): the plain stop says "stopped" for `stopped` only.
   */
  onStop: () => Promise<SessionStopResult>;
  /**
   * Issue #4317 PR1: the page's registration (`null`: the page has none yet). While it is not the
   * current one nothing new starts here. Left out (`undefined`), the dialog is used without a page
   * (no registration to answer to); the page always hands it (the guard `handoff-close-paths-4227`).
   */
  registration?: HandoffPageRegistration | null;
}

/** The dialog's name in the shared write lock of mem items. */
export const HANDOFF_LOCK_OWNER = 'handoff';
/** The screen reads the request again while it waits for the agent (the server never waits). */
export const HANDOFF_REFRESH_MS = 3000;

/** The refusals with their own wording (`mem.handoff.refusal.*`); any other shows its code. */
const REFUSAL_CODES = new Set([
  'disabled',
  'session_changed',
  'request_closed',
  'version_conflict',
  'proposal_changed',
  'state_forbids',
  'extend_limit',
  'not_stopped',
  'end_token_changed',
  'already_recorded',
  'screen_only',
  'not_found',
]);

type Choice = HandoffChoice['choice'];

/** No choice made (the value for no opening; one object, so the render reads a stable value). */
const NO_CHOICES: Readonly<Record<string, HandoffChoice>> = {};
type Notice = { tone: 'status' | 'alert'; text: string } | null;

/**
 * The rule for closing lives in `@/lib/handoff/close-rule` (pr2d): every path that makes this
 * dialog go away — the person's, the cancel's answer, the plain stop's end, the page's switch
 * of worktree and its other "end" — asks it. Re-exported for the screens that read it here.
 */
export { handoffCloseBlock, type HandoffCloseBlock } from '@/lib/handoff/close-rule';

const CLOSE_NOTICE: Record<Exclude<HandoffCloseBlock, null>, string> = {
  stopping: 'mem.handoff.closeWhileStopping',
  unknown: 'mem.handoff.closeWhileUnknown',
  cancelling: 'mem.handoff.closeWhileCancelling',
};

/** The store of `@/lib/handoff/close-rule`, as this render reads it. */
function useHandoffStore() {
  return useSyncExternalStore(subscribeHandoffStore, handoffStoreSnapshot, handoffStoreSnapshot);
}

export function SessionHandoffDialog({ isOpen, worktreeId, target, onClose, onStop, registration }: SessionHandoffDialogProps) {
  const t = useTranslations('common');
  const isMobile = useIsMobile();
  const store = useHandoffStore();
  const registry = useSyncExternalStore(subscribeHandoffRegistry, handoffRegistrySnapshot, handoffRegistrySnapshot);
  /**
   * Issue #4317 PR1: this render may start something — its page's registration is the current one
   * and (再指示 2) the session is not expired: one condition, `handoffPageMayStart`, for every start.
   */
  const actionable = registration === undefined || handoffPageMayStart(registration, registry);
  /** The same, read now (after an await): never the render's value. */
  const registered = useCallback((): boolean => registration === undefined || handoffPageMayStart(registration), [registration]);
  const [notice, setNotice] = useState<Notice>(null);
  /**
   * Issue #4345 1c 再指示 2 (K1): an operation pressed now — the token the gate reads (this dialog's
   * registration, fixed at the press). Its record capability lets the records of what it sent leave
   * even once the session expired. Drawn without a page (`registration` undefined): nothing is gated.
   */
  const pressOperation = useCallback(
    (): HandoffPageOperation | undefined => (registration === undefined ? undefined : beginHandoffPageOperationFor(registration)),
    [registration]
  );

  /** This dialog's opening, once its effect has made (or found) it for the target. */
  const opening: HandoffOpening | null =
    isOpen && target && store.opening && !store.opening.closed && store.opening.target.instanceId === target.instanceId ? store.opening : null;
  const token = opening?.token ?? null;
  /**
   * Issue #4346: the person's choices are the opening's (in the store), not this mount's: the host
   * draws 0 dialogs on another worktree or route, so a state here was lost on the way back to the
   * same opening. A new opening starts with none.
   */
  const choices = opening?.choices ?? NO_CHOICES;
  /**
   * pr2e P3-3 (G-PR3): the text is being sent (no second send from the button meanwhile), and an
   * extend or a rebase is answered. Issue #4345 1b 再指示 1: the opening's (the store), not this
   * mount's — kept when a 401 unmounts the dialog and it is drawn again after the recovery.
   */
  const textSending = opening?.textSending ?? false;
  const writing = opening?.writing ?? false;
  /**
   * Issue #4317 PR2: the host beside the shell keeps this instance (and its DOM) over route and
   * width changes, so what is local here — the notice — is per opening: set afresh when
   * another opening is shown, kept while the same one is (and while none is). The person's choices
   * moved to the opening itself (Issue #4346): the host draws 0 dialogs on another worktree, and
   * this instance's state does not outlive that.
   */
  const [localFor, setLocalFor] = useState<HandoffOpeningToken | null>(token);
  if (token !== null && token !== localFor) {
    setLocalFor(token);
    if (localFor !== null) setNotice(null);
  }
  /**
   * The worktree the dialog was opened for (pr2d). The page keeps the dialog over a switch of
   * worktree while it holds something; on another worktree's page it is "foreign": its request
   * is still addressed to that worktree, and no stop nor write of this dialog's runs there
   * (the page's stop is the other worktree's).
   */
  const forWorktree = opening?.worktreeId ?? worktreeId;
  const foreign = opening !== null && opening.worktreeId !== worktreeId;
  const units = store.units[forWorktree] ?? handoffUnitsOf(forWorktree);
  const view = opening?.view ?? null;
  const text = opening?.text ?? null;
  const plainOnly = opening?.plainOnly ?? null;
  const plainStopped = opening?.plainStopped ?? false;
  /**
   * pr2e P3-2 (G-PR3): after the page itself was made again (back / forward), the store may hold
   * another worktree's unknown unit that locks this dialog's writes (`handoffUnitsLock` reads every
   * worktree) while no page shows it. With none of its own, the dialog shows that one as "another
   * worktree's unknown result": dropping it is all it allows (never sent from here).
   */
  const otherWorktreePending =
    units.pending === null
      ? (Object.entries(store.units).find(([id, other]) => id !== forWorktree && other.pending !== null)?.[1].pending ?? null)
      : null;
  const pending = units.pending ?? otherWorktreePending;
  const stopping = units.stopping;
  const cancelling = units.cancelling;
  const busy = writing || units.inflight !== null;

  useEffect(() => listenHandoffRefusal((_path, block) => setNotice({ tone: 'alert', text: t(CLOSE_NOTICE[block]) })), [t]);

  const ownLock = handoffUnitsLock(store);
  // G-PR3: the items panel's units are the store's too — they hold the decide even while no panel is drawn.
  const otherLock = useMemWriteLock(HANDOFF_LOCK_OWNER, ownLock) ?? memItemsUnitsLock(store);
  const lock = ownLock ?? otherLock;

  const requestId = view?.request.id ?? null;
  const state = view?.request.state ?? null;

  const refusal = useCallback(
    (result: Extract<HandoffResult<unknown>, { ok: false }>) => {
      const code = result.code ?? '';
      return REFUSAL_CODES.has(code) ? t(`mem.handoff.refusal.${code}`) : t('mem.handoff.refusal.other', { code: code || String(result.status) });
    },
    [t]
  );

  const adopt = useCallback(
    (next: HandoffReadResponse | undefined) => {
      if (token && next?.request) patchHandoffOpening(token, { view: next });
    },
    [token]
  );

  const reload = useCallback(async () => {
    if (!requestId) return;
    const result = await handoffApi.read(forWorktree, requestId, registration);
    if (result.ok) adopt(result.body);
  }, [adopt, requestId, forWorktree, registration]);

  /**
   * ②: send the request's text to the agent, for the opening `of` (its worktree and target).
   * Not once the opening closed or a cancel started (pr2e, PM P3-2): checked before the text goes.
   */
  const sendText = useCallback(
    async (of: HandoffOpening, requestIdToSend: string, body: string) => {
      if (!handoffTextSendable(of.token)) return;
      // Issue #4345 1b 再指示 1: held by the opening until the send is recorded (a remount meanwhile
      // offers no "send again" and `handoffTextSendable` refuses a second send).
      patchHandoffOpening(of.token, { textSending: true });
      try {
        const operation = pressOperation();
        const sent = await handoffApi.sendText(
          of.worktreeId,
          body,
          { cliToolId: of.target.cliToolId, instanceId: of.target.instanceId },
          operation ?? registration
        );
        // Issue #4345 1c 再指示 2: not sent (the gate refused it) — nothing happened: no record of a
        // failure, no notice; the request stays `unsent` for "send again".
        if (sent.refused) return;
        // Issue #4345 1b: what the send said is recorded for this opening whatever the session's state
        // now (an expiry taken meanwhile, this send's own 401 included) — a record, not a new send.
        // 再指示 2: with the capability the allowed send handed over.
        const recordOwner = operation ? (operation.record() ?? registration) : registration;
        const marked = sent.ok
          ? await handoffApi.sent(of.worktreeId, requestIdToSend, recordOwner)
          : await handoffApi.sendFailed(of.worktreeId, requestIdToSend, recordOwner);
        if (marked.ok && marked.body?.request) patchHandoffOpening(of.token, { view: marked.body });
        if (isLiveHandoffOpening(of.token)) setNotice(sent.ok ? null : { tone: 'alert', text: t('mem.handoff.sendFailed') });
      } finally {
        patchHandoffOpening(of.token, { textSending: false });
      }
    },
    [pressOperation, registration, t]
  );

  /**
   * The opening this instance shows (set on showing, cleared on hiding). pr2f: hidden, it closes
   * that opening only — never one begun since (another page's, or this page's next).
   */
  const shownRef = useRef<HandoffOpeningToken | null>(null);
  useEffect(() => {
    if (!isOpen || !target) {
      if (shownRef.current !== null) noteHandoffHidden(shownRef.current);
      shownRef.current = null;
      return;
    }
    // pr2e: drawn again (PC ↔ phone, the page's Loading, a remount), the opening is found in the
    // store and nothing is made again. Shown anew (the dialog hook-less, or reopened), it begins
    // one; an opening that closed while still shown begins none (the page hides it). A new
    // opening never drops a unit (pr2c (10)・pr2d).
    let current = liveHandoffOpeningFor(target.instanceId);
    if (!current) {
      if (shownRef.current !== null) return;
      // Issue #4317 PR1: no opening begins without the current registration. PR2: read again now (the
      // render's registration may have been left since — the host's dialog outlives the pages).
      if (!actionable || !registered()) return;
      current = beginHandoffOpening(worktreeId, target);
    }
    shownRef.current = current.token;
    if (current.created !== 'no') return;
    // Issue #4317 PR1: the request is made once the page's registration is the current one (and the
    // session not expired), read again right before it is sent (再指示 2).
    if (!actionable || !registered()) return;
    const of = current;
    patchHandoffOpening(of.token, { choices: {} });
    setNotice(null);
    patchHandoffOpening(of.token, { created: 'creating' });
    void (async () => {
      const created = await handoffApi.create(of.worktreeId, of.target.instanceId, registration);
      // The answer belongs to the opening, not to this component: drawn again meanwhile, it lands.
      if (!isLiveHandoffOpening(of.token)) return;
      // Issue #4345 1c 再指示 2: not sent (the gate refused it): nothing was made — as before the create.
      if (created.refused) {
        patchHandoffOpening(of.token, { created: 'no' });
        return;
      }
      // Issue #4345 1b: the create's own 401 taken — nothing was made. The opening is left as it was
      // before the create (not "the plain stop only"): the dialog is hidden, and drawn again once the
      // page's detail read recovers the session, it makes the request then (once).
      if (!created.ok && created.expired) {
        patchHandoffOpening(of.token, { created: 'no' });
        return;
      }
      if (created.ok) {
        patchHandoffOpening(of.token, { created: 'done', view: created.body, text: created.body.text });
        // Issue #4317 PR1 (再指示 2): the text is a new send. It goes while the registration the
        // request was made under is still the current one and the session not expired — not merely
        // a page of the same worktree. Otherwise it is not sent, and the request stays `unsent` for
        // the current page's "send the request again".
        if (!registered()) return;
        await sendText(of, created.body.request.id, created.body.text);
        return;
      }
      const body = created.body as (Partial<HandoffReadResponse> & { text?: unknown }) | undefined;
      if (created.code === 'request_open' && body?.request) {
        // pr2e P3-3 (G-PR3): the request picked up keeps its text, so an `unsent` one can be sent again.
        const pickedText = typeof body.text === 'string' ? body.text : null;
        patchHandoffOpening(of.token, { created: 'done', view: body as HandoffReadResponse, ...(pickedText !== null ? { text: pickedText } : {}) });
        return;
      }
      patchHandoffOpening(of.token, {
        created: 'done',
        plainOnly: created.code === 'session_unknown' ? t('mem.handoff.sessionUnknown') : refusal(created),
      });
    })();
    // The request is made once per opening (the store's token) for its target. A switch of
    // worktree while it is open (the page keeps it only while it holds something) makes no request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Issue #4345 1b 再指示 1: `created` too — a create answered by a 401 taken goes back to 'no' while
    // a dialog drawn again after the recovery already found it 'creating' and returned; going back to
    // 'no' makes the request then (once: 'creating' at once, and the effect returns for anything else).
  }, [isOpen, target?.instanceId, store.opening?.token, store.opening?.created, actionable]);

  // The screen reads again while the agent works (the server keeps no timer; §4.3).
  useEffect(() => {
    if (!isOpen || state !== 'awaiting_agent' || foreign) return;
    const timer = setInterval(() => void reload(), HANDOFF_REFRESH_MS);
    return () => clearInterval(timer);
  }, [foreign, isOpen, reload, state]);

  /**
   * Sends one decide as the one in flight: one at a time, none while another screen's item
   * write is open, and none once a cancel has started or the dialog closed (pr2d, condition 4).
   */
  const decide = useCallback(
    async (unit: HandoffDecideUnit) => {
      const of = token;
      if (of === null || !isLiveHandoffOpening(of) || otherLock !== null || !registered()) return;
      // pr2f (codex P2-1): this sending — its settle, its `finally` included, names it.
      const sending = startHandoffDecide(unit);
      if (sending === null) return;
      setNotice(null);
      try {
        const result = await handoffApi.decide(
          sending.worktreeId,
          sending.requestId,
          { ifVersion: sending.ifVersion, decisions: sending.decisions },
          registration
        );
        // Issue #4345 1c 再指示 2: not sent (the gate refused it) — nothing was asked: the sending is let
        // go (no unknown unit to send again, no notice), the person's choices stay.
        if (result.refused) {
          settleHandoffDecide(sending, 'answered');
          return;
        }
        if (!result.ok && result.status === 0) {
          // Rule (4): not known whether it was written. Kept as it was, to send again.
          settleHandoffDecide(sending, 'unknown');
          if (isLiveHandoffOpening(of)) setNotice({ tone: 'alert', text: t('mem.handoff.unknown') });
          return;
        }
        settleHandoffDecide(sending, 'answered');
        // Another opening began meanwhile: what this answer says is not shown on it.
        if (!isLiveHandoffOpening(of)) return;
        if (result.ok) {
          adopt(result.body);
          patchHandoffOpening(of, { choices: {} });
          const failed = result.body.results.filter((entry) => entry.result !== 'applied' && entry.result !== 'discarded');
          setNotice({ tone: failed.length > 0 ? 'alert' : 'status', text: failed.length > 0 ? t('mem.handoff.someNotApplied') : t('mem.handoff.decided') });
          return;
        }
        // Rule (4)(c): a refusal (a resend's version conflict included) is not read as success:
        // what the server holds now is shown, and the person chooses again.
        adopt(result.body as unknown as HandoffReadResponse);
        patchHandoffOpening(of, { choices: {} });
        setNotice({ tone: 'alert', text: refusal(result) });
        if (!result.body?.request) await reload();
      } finally {
        // Whatever went wrong, a decide that did not say how it ended is kept as unknown — this
        // sending only: settled already (or another sending in flight since), nothing changes.
        settleHandoffDecide(sending, 'unknown');
      }
    },
    [adopt, otherLock, refusal, registered, registration, reload, t, token]
  );

  /**
   * Issue #4346: the person chooses (or, pressing the same again, takes it back) on the opening
   * this render shows — written to the store, read back through it.
   */
  const choose = useCallback(
    (proposal: HandoffProposalView, choice: Choice) => {
      if (token === null) return;
      const current = handoffStoreSnapshot().opening;
      if (current === null || current.token !== token) return;
      const was = current.choices;
      if (was[proposal.id]?.choice === choice) {
        const rest = { ...was };
        delete rest[proposal.id];
        patchHandoffOpening(token, { choices: rest });
        return;
      }
      patchHandoffOpening(token, { choices: { ...was, [proposal.id]: { choice, fingerprint: proposal.fingerprint } } });
    },
    [token]
  );

  const confirm = useCallback(() => {
    if (!view || lock !== null || foreign) return;
    // Rule (2): only what the person chose is sent, with the fingerprint of what was shown.
    const decisions: HandoffDecision[] = Object.entries(choices).map(([proposalId, entry]) => ({
      proposalId,
      fingerprint: entry.fingerprint,
      action: entry.choice,
    }));
    void decide({ worktreeId: forWorktree, requestId: view.request.id, ifVersion: view.request.version, decisions });
  }, [choices, decide, foreign, forWorktree, lock, view]);

  const goOn = useCallback(() => {
    if (!view || lock !== null || foreign) return;
    void decide({ worktreeId: forWorktree, requestId: view.request.id, ifVersion: view.request.version, decisions: [] });
  }, [decide, foreign, forWorktree, lock, view]);

  const simpleWrite = useCallback(
    async (run: () => Promise<HandoffResult<HandoffReadResponse>>, success?: string) => {
      const of = token;
      if (of === null || !isLiveHandoffOpening(of) || handoffUnitsOf(forWorktree).cancelling || !registered()) return;
      if (handoffStoreSnapshot().opening?.writing) return;
      // Issue #4345 1b 再指示 1: the opening's, kept over a remount until this write is answered.
      patchHandoffOpening(of, { writing: true });
      try {
        const result = await run();
        if (!isLiveHandoffOpening(of)) return;
        // Issue #4345 1c 再指示 2: not sent (the gate refused it) — nothing happened, nothing is said.
        if (result.refused) return;
        if (result.ok) {
          adopt(result.body);
          setNotice(success ? { tone: 'status', text: success } : null);
        } else {
          setNotice({ tone: 'alert', text: refusal(result) });
          await reload();
        }
      } finally {
        patchHandoffOpening(of, { writing: false });
      }
    },
    [adopt, forWorktree, refusal, registered, reload, token]
  );

  const extend = useCallback(() => {
    if (!view || lock !== null || foreign) return;
    void simpleWrite(() => handoffApi.extend(forWorktree, view.request.id, view.request.version, registration), t('mem.handoff.extended'));
  }, [foreign, forWorktree, lock, registration, simpleWrite, t, view]);

  const rebase = useCallback(
    (proposal: HandoffProposalView) => {
      if (!view || lock !== null || foreign) return;
      void simpleWrite(() =>
        handoffApi.rebase(forWorktree, view.request.id, proposal.id, { ifVersion: view.request.version, fingerprint: proposal.fingerprint }, registration)
      );
    },
    [foreign, forWorktree, lock, registration, simpleWrite, view]
  );

  /**
   * The dialog's only call of `onClose` (pr2d): asks the rule ({@link closeHandoffOpening}) for
   * `path` on behalf of the opening `of`; refused, it stays and says why. pr2f (codex P2-2): `of`
   * is the opening the work was started for — after an await another may have begun, and then
   * nothing is closed (`stale`). No opening yet (`null`, before the store has one for the target):
   * the page closes it, asking the rule itself. The guard `handoff-close-paths-4227` keeps it the only one.
   */
  const closeBy = useCallback(
    (of: HandoffOpeningToken | null, path: HandoffClosePath): 'closed' | 'refused' | 'stale' => {
      const answer = of === null ? null : closeHandoffOpening(of, path);
      if (answer === 'stale') return 'stale';
      if (answer !== null) {
        setNotice({ tone: 'alert', text: t(CLOSE_NOTICE[answer]) });
        return 'refused';
      }
      onClose();
      return 'closed';
    },
    [onClose, t]
  );

  /**
   * The person's ways of closing (Esc, ×, the backdrop, "cancel the end", "close", "keep the
   * session"): refused while the rule says so; otherwise the open request is cancelled
   * (`cancel`) or the dialog just closed (`close`). While the cancel is answered no decide, no
   * text and no stop is sent and nothing else closes it; its answer asks the rule again (`cancel-answer`).
   */
  const requestClose = useCallback(
    async (how: 'cancel' | 'close') => {
      const of = token;
      // Issue #4317 PR1: ×, Escape, the backdrop and the buttons alike — no close nor cancel starts.
      if (!registered()) return;
      if (how === 'close' || !view || !['awaiting_agent', 'reviewing', 'applying', 'ending'].includes(view.request.state)) {
        closeBy(of, 'person');
        return;
      }
      const block = askHandoffClose('person');
      if (block !== null) {
        setNotice({ tone: 'alert', text: t(CLOSE_NOTICE[block]) });
        return;
      }
      if (!startHandoffCancel(forWorktree)) return;
      try {
        await handoffApi.cancel(forWorktree, view.request.id, registration);
      } finally {
        endHandoffCancel(forWorktree);
      }
      // Issue #4317 PR1: the registration lapsed while the cancel was answered — the answer is
      // read into its opening (what the server holds now), and nothing is closed from here.
      if (!registered()) {
        await reload();
        return;
      }
      // Not refused while no decide can start after the cancel; kept for the rule's sake. pr2f:
      // the opening the cancel was sent for — another begun meanwhile is neither closed nor read.
      if (closeBy(of, 'cancel-answer') === 'refused') await reload();
    },
    [closeBy, forWorktree, registered, registration, reload, t, token, view]
  );

  const resendText = useCallback(() => {
    if (opening && view && text && registered()) void sendText(opening, view.request.id, text);
  }, [opening, registered, sendText, text, view]);

  /** The opening is over, or a cancel of its worktree started: what was started goes no further. */
  const stopped = useCallback((): boolean => !isLiveHandoffOpening(token) || handoffUnitsOf(forWorktree).cancelling, [forWorktree, token]);

  /**
   * The stop button's handler (§4.1 ⑥): the declaration, the existing stop, the
   * observation — in this order, once each. The only place `onStop` is called with a request.
   */
  const stop = useCallback(
    async (force: boolean) => {
      // Not from another worktree's page: the page's stop is that worktree's (pr2d).
      if (stopped() || !view || foreign || !token || !registered()) return;
      if (!startHandoffStop(forWorktree)) return;
      setNotice(null);
      try {
        let endToken = view.request.state === 'ending' ? view.request.endToken : null;
        // Issue #4345 1c 再指示 2: the stop's operation (fixed at the press). The observation of the
        // kill it sends is a record, on the capability the allowed `end` hands over.
        const operation = pressOperation();
        if (!endToken) {
          const ended = await handoffApi.end(
            forWorktree,
            view.request.id,
            { ifVersion: view.request.version, ...(force ? { force: true } : {}) },
            operation ?? registration
          );
          // Not sent (the gate refused it): nothing happened, nothing is said.
          if (ended.refused) return;
          if (!ended.ok) {
            if (ended.code === 'session_changed') {
              patchHandoffOpening(token, { plainOnly: t('mem.handoff.sessionChanged') });
            } else {
              setNotice({ tone: 'alert', text: refusal(ended) });
              await reload();
            }
            return;
          }
          adopt(ended.body);
          endToken = ended.body.endToken;
        }
        // pr2c (1): the dialog closed (or its request cancelled) while `end` was answered — no stop.
        // Issue #4317 PR1: nor once the page's registration lapsed meanwhile (`end`'s answer is
        // adopted above; the kill, not started, is the person's to press again).
        if (stopped() || !registered()) return;
        // Issue #4345 1c 再指示 2: the kill not sent (the page's gate refused it) — nothing to observe.
        if ((await onStop()) === 'not-sent') return;
        // Issue #4345 1b: the kill was sent — its observation is recorded for this request whatever
        // the session's state or the page registered now (the kill's own 401 included).
        // 再指示 2: on the capability of the stop's operation (an `end` sent before — a resumed
        // `ending` — hands none: the observation is then gated like a new request).
        const recordOwner = operation ? (operation.record() ?? registration) : registration;
        const observed = await handoffApi.observe(forWorktree, view.request.id, endToken, recordOwner);
        if (observed.ok) {
          adopt(observed.body);
        } else {
          adopt(observed.body as unknown as HandoffReadResponse);
          setNotice({ tone: 'alert', text: observed.code === 'not_stopped' ? t('mem.handoff.notStopped') : refusal(observed) });
        }
      } finally {
        endHandoffStop(forWorktree);
      }
    },
    [adopt, foreign, forWorktree, onStop, pressOperation, refusal, registered, registration, reload, stopped, t, token, view]
  );

  /**
   * No request: the existing stop only (no `end`, nothing recorded, §4.1 ①・H15(g)). Stopped, it
   * closes the dialog through the rule (`plain-stop-done`): a decide still unknown keeps it open
   * for the person's choice (pr2d, codex P2 2). Not stopped (refused, failed, unknown — pr2e,
   * codex P2-2): it says so and the stop stays, to be pressed again here.
   */
  const plainStop = useCallback(async () => {
    const of = token;
    if (stopped() || foreign || of === null || !registered()) return;
    if (!startHandoffStop(forWorktree)) return;
    setNotice(null);
    let result: SessionStopResult = 'unknown';
    try {
      result = await onStop();
    } finally {
      endHandoffStop(forWorktree);
    }
    // pr2f (codex P2-2): the opening this stop was pressed in is over — nothing more of it here.
    if (!isLiveHandoffOpening(of)) return;
    // Issue #4345 1c 再指示 2: the kill was not sent (the page's gate refused it): nothing is said.
    if (result === 'not-sent') return;
    if (result !== 'stopped') {
      setNotice({ tone: 'alert', text: t(result === 'unknown' ? 'mem.handoff.plainStopUnknown' : 'mem.handoff.plainStopFailed') });
      return;
    }
    // Issue #4317 PR1: the registration lapsed while the kill was answered — "stopped" is kept on
    // its opening, and nothing is closed from here.
    if (!registered()) {
      patchHandoffOpening(of, { plainStopped: true });
      return;
    }
    if (closeBy(of, 'plain-stop-done') === 'refused') patchHandoffOpening(of, { plainStopped: true });
  }, [closeBy, foreign, forWorktree, onStop, registered, stopped, t, token]);

  if (!isOpen || !target) return null;

  const request = view?.request ?? null;
  const proposals = view?.proposals ?? [];
  const ended = request?.state === 'ended';
  const over = request !== null && ['ended', 'cancelled', 'expired'].includes(request.state);
  const beforeConfirm = proposals.every((proposal) => proposal.state !== 'applied');
  const canStop = request !== null && ['awaiting_agent', 'reviewing', 'ending'].includes(request.state);
  const canForce = request !== null && ['awaiting_agent', 'reviewing', 'applying', 'ending'].includes(request.state);
  /** pr2d (condition 2): another worktree's unit (or this one's on another worktree's page) is dropped only. */
  const pendingSendable = pending !== null && !foreign && pending.worktreeId === worktreeId;

  return (
    <Modal isOpen={isOpen} onClose={() => void requestClose(foreign ? 'close' : 'cancel')} title={t('mem.handoff.title', { label: target.label })} size={isMobile ? 'full' : 'lg'}>
      <div className="space-y-3 text-sm" data-testid="handoff-dialog" data-layout={isMobile ? 'mobile' : 'desktop'}>
        {notice && (
          <p role={notice.tone} className={notice.tone === 'alert' ? 'text-danger-foreground' : 'text-success-foreground'} data-testid="handoff-notice">
            {notice.text}
          </p>
        )}
        {lock && (
          <p role="status" className="text-xs text-warning-foreground" data-testid="handoff-write-locked">
            {ownLock === null ? t('mem.handoff.lockedElsewhere') : lock === 'sending' ? t('mem.handoff.lockedSending') : t('mem.handoff.lockedUnknown')}
          </p>
        )}

        {/* pr2c (10): shown whatever else is drawn — kept over a reopening, even when no request could be made. */}
        {pending && (
          <div className="space-y-1 rounded border border-warning-border bg-warning-subtle p-2" data-testid="handoff-pending">
            <p className="text-xs text-foreground">{t('mem.handoff.unknown')}</p>
            {otherWorktreePending !== null ? (
              <p className="text-xs text-muted-foreground" data-testid="handoff-pending-other-worktree">
                {t('mem.handoff.pendingOtherWorktree', { worktree: pending.worktreeId })}
              </p>
            ) : (
              !pendingSendable && (
                <p className="text-xs text-muted-foreground" data-testid="handoff-pending-elsewhere">
                  {t('mem.handoff.pendingElsewhere', { worktree: pending.worktreeId })}
                </p>
              )
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  if (pendingSendable) void decide(pending);
                }}
                disabled={busy || cancelling || !pendingSendable || !actionable}
                data-testid="handoff-pending-resend"
              >
                {t('mem.handoff.resend')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !actionable}
                onClick={() => {
                  if (!registered()) return;
                  dropHandoffUnit(pending);
                  setNotice(null);
                  void reload();
                }}
                data-testid="handoff-pending-drop"
              >
                {t('mem.handoff.drop')}
              </Button>
            </div>
          </div>
        )}

        {foreign ? (
          // pr2d: kept over a switch of worktree while it held something. Nothing of this
          // dialog runs on another worktree's page but the unit's drop and closing.
          <div className="space-y-2" data-testid="handoff-foreign">
            <p className="text-foreground">{t('mem.handoff.foreign', { worktree: forWorktree })}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={!actionable} onClick={() => void requestClose('close')} data-testid="handoff-foreign-close">
                {t('mem.handoff.close')}
              </Button>
            </div>
          </div>
        ) : plainOnly !== null ? (
          <div className="space-y-2" data-testid="handoff-plain">
            <p className="text-foreground">{plainStopped ? t('mem.handoff.plainStopped') : plainOnly}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={!actionable} onClick={() => void requestClose('close')} data-testid="handoff-plain-cancel">
                {plainStopped ? t('mem.handoff.close') : t('mem.handoff.keepSession')}
              </Button>
              {!plainStopped && (
                <Button variant="danger" disabled={stopping || !actionable} onClick={() => void plainStop()} data-testid="handoff-plain-stop">
                  {t('mem.handoff.stop')}
                </Button>
              )}
            </div>
          </div>
        ) : request === null ? (
          <p className="text-muted-foreground" data-testid="handoff-loading">
            {t('mem.handoff.creating')}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-foreground" data-testid="handoff-state">
                {t(`mem.handoff.state.${request.state}`)}
                {request.endForced ? ` ${t('mem.handoff.forcedMark')}` : ''}
              </p>
              <Button size="sm" variant="ghost" onClick={() => void reload()} data-testid="handoff-reload">
                {t('mem.handoff.reload')}
              </Button>
            </div>
            {request.state === 'awaiting_agent' && (request.sendState === 'failed' || (request.sendState === 'unsent' && !textSending)) && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={resendText} disabled={busy || cancelling || text === null || !actionable} data-testid="handoff-resend-text">
                  {t('mem.handoff.resendText')}
                </Button>
              </div>
            )}
            {request.state === 'awaiting_agent' && request.agentTimedOut && (
              <div className="space-y-1 rounded border border-warning-border bg-warning-subtle p-2" data-testid="handoff-agent-timeout">
                <p className="text-xs text-foreground">{t('mem.handoff.agentTimeout')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={extend} disabled={busy || lock !== null || request.extensions >= 2 || !actionable} data-testid="handoff-extend">
                    {t('mem.handoff.extend')}
                  </Button>
                  <Button size="sm" onClick={goOn} disabled={busy || lock !== null || !actionable} data-testid="handoff-go-on">
                    {t('mem.handoff.goOn')}
                  </Button>
                </div>
              </div>
            )}

            {/* G9 (design §4.2): the agent said done with no proposal. The server cannot tell whether a
                propose failed (a CLI parse error never reaches it), so the person is told that one may
                not have arrived, and how to ask again ("don't end", then "end" again). */}
            {request.state === 'reviewing' && request.agentDoneAt !== null && proposals.length === 0 && (
              <p className="rounded border border-warning-border bg-warning-subtle p-2 text-xs text-foreground" data-testid="handoff-done-empty">
                {t('mem.handoff.doneEmpty')}
              </p>
            )}
            {proposals.length > 0 && (
              <ul className="space-y-2" data-testid="handoff-proposals">
                {proposals.map((proposal) => (
                  <ProposalRow
                    key={proposal.id}
                    proposal={proposal}
                    choice={choices[proposal.id]?.choice ?? null}
                    disabled={busy || cancelling || lock !== null || request.state !== 'reviewing'}
                    onChoose={(choice) => choose(proposal, choice)}
                    onRebase={() => rebase(proposal)}
                    rebaseDisabled={busy || lock !== null || request.state !== 'reviewing' || !actionable}
                    t={t}
                  />
                ))}
              </ul>
            )}
            {view && view.direct.length > 0 && (
              <div className="space-y-1" data-testid="handoff-direct">
                <p className="text-xs text-muted-foreground">{t('mem.handoff.direct')}</p>
                <ul className="text-xs text-foreground">
                  {view.direct.map((change) => (
                    <li key={change.id} className="break-words">
                      [{change.kind}] {change.id} v{change.version} {change.state} ({change.updatedByInstance ?? '-'})
                    </li>
                  ))}
                </ul>
              </div>
            )}


            {ended && (
              <p className="text-foreground" data-testid="handoff-outcome">
                {request.outcome === 'confirmed'
                  ? t('mem.handoff.outcome.confirmed')
                  : t('mem.handoff.outcome.unconfirmed', { reason: request.outcomeReason ?? '-' })}
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              {request.state === 'reviewing' && (
                <Button
                  onClick={confirm}
                  disabled={busy || cancelling || lock !== null || Object.keys(choices).length === 0 || !actionable}
                  data-testid="handoff-confirm"
                >
                  {t('mem.handoff.confirm')}
                </Button>
              )}
              {!over && (
                <Button variant="ghost" onClick={() => void requestClose('cancel')} disabled={stopping || cancelling || !actionable} data-testid="handoff-cancel">
                  {t('mem.handoff.cancel')}
                </Button>
              )}
              {canStop && (
                <Button variant="danger" onClick={() => void stop(request.endForced)} disabled={stopping || cancelling || !actionable} data-testid="handoff-stop">
                  {t('mem.handoff.stop')}
                </Button>
              )}
              {canForce && beforeConfirm && !request.endForced && (
                <Button variant="danger" onClick={() => void stop(true)} disabled={stopping || cancelling || !actionable} data-testid="handoff-stop-now">
                  {t('mem.handoff.stopNow')}
                </Button>
              )}
              {over && (
                <Button variant="ghost" disabled={!actionable} onClick={() => void requestClose('close')} data-testid="handoff-close">
                  {t('mem.handoff.close')}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}


/**
 * The fields a confirmation writes, per op (`decide.ts` `writeInputOf`): each is shown against
 * the item as stored now (codex review-4227-pr2 P2-2), so nothing is approved unseen.
 */
export const HANDOFF_PROPOSAL_FIELDS = {
  add: ['text', 'closeWhen', 'evidence', 'promoteTo'],
  update: ['text', 'closeWhen', 'evidence'],
  close: ['reason'],
} as const satisfies Record<HandoffProposalView['op'], readonly string[]>;
type ProposalField = (typeof HANDOFF_PROPOSAL_FIELDS)[keyof typeof HANDOFF_PROPOSAL_FIELDS][number];

/** A stored condition in a line (its type, and what it points at). */
export function describeCloseWhen(closeWhen: MemCloseWhen): string {
  switch (closeWhen.type) {
    case 'issue':
      return `issue ${closeWhen.owner}/${closeWhen.repo}#${closeWhen.number}`;
    case 'pr':
      return `pr ${closeWhen.owner}/${closeWhen.repo}#${closeWhen.number} (${closeWhen.state})`;
    case 'branch':
      return `branch ${closeWhen.name} ${closeWhen.event}${closeWhen.into ? ` → ${closeWhen.into}` : ''}`;
    case 'at':
      return `at ${new Date(closeWhen.epochMs).toISOString()}`;
    default:
      return closeWhen.type;
  }
}

type Translate = ReturnType<typeof useTranslations>;

/**
 * What the proposal writes in `field`, by the items panel's rule (`editChanges`): an omitted
 * field is not sent — the stored value is kept (an add sets nothing) — and an empty evidence
 * (`[]`) is sent and clears it. The two never read the same.
 */
export function proposedFieldText(op: HandoffProposalView['op'], field: ProposalField, payload: NonNullable<HandoffProposalView['payload']>, t: Translate): string {
  const value = payload[field];
  // An add sets nothing it omits; a close without a reason gives none.
  if (value === undefined) return op === 'add' || field === 'reason' ? t('mem.handoff.field.unset') : t('mem.handoff.field.keep');
  if (Array.isArray(value)) return value.length === 0 ? t('mem.handoff.field.cleared') : value.join(', ');
  return value === '' ? t('mem.handoff.field.empty') : value;
}

/** The item's `field` as stored now (through mem's exit check: a withheld item shows nothing). */
export function currentFieldText(field: ProposalField, current: MemItemView, t: Translate): string {
  if (current.withheld) return t('mem.handoff.withheldShort');
  switch (field) {
    case 'text':
      return current.text ? current.text : t('mem.handoff.field.empty');
    case 'closeWhen':
      return current.closeWhen ? describeCloseWhen(current.closeWhen) : t('mem.handoff.field.none');
    case 'evidence':
      return current.evidence && current.evidence.length > 0 ? current.evidence.join(', ') : t('mem.handoff.field.none');
    case 'promoteTo':
      return current.promoteTo ? current.promoteTo : t('mem.handoff.field.none');
    default:
      return t('mem.handoff.field.none');
  }
}

function ProposalRow({
  proposal,
  choice,
  disabled,
  onChoose,
  onRebase,
  rebaseDisabled,
  t,
}: {
  proposal: HandoffProposalView;
  choice: Choice | null;
  disabled: boolean;
  onChoose: (choice: Choice) => void;
  onRebase: () => void;
  rebaseDisabled: boolean;
  t: Translate;
}) {
  const current = proposal.current;
  const proposed = proposal.withheld
    ? t('mem.handoff.withheld', { field: proposal.withheld.field, rule: proposal.withheld.rule })
    : proposal.op === 'close'
      ? t('mem.handoff.closeProposal', { reason: proposal.payload?.reason ?? '-' })
      : (proposal.payload?.text ?? '');
  return (
    <li className="space-y-1 rounded border border-border p-2" data-testid={`handoff-proposal-${proposal.id}`}>
      <p className="text-xs text-muted-foreground">
        {t(`mem.handoff.op.${proposal.op}`)} [{proposal.kind}] {proposal.itemId ?? ''}
        {proposal.baseVersion !== null ? ` v${proposal.baseVersion}` : ''} · {t(`mem.handoff.proposalState.${proposal.state}`)}
        {proposal.stateReason ? ` (${proposal.stateReason})` : ''}
      </p>
      {current && proposal.op !== 'add' && (
        <p className="break-words text-xs text-foreground" data-testid={`handoff-proposal-current-${proposal.id}`}>
          {t('mem.handoff.currentValue', { version: current.version })}: {current.withheld ? t('mem.handoff.withheldShort') : current.text}
        </p>
      )}
      <p className="break-words text-foreground" data-testid={`handoff-proposal-text-${proposal.id}`}>
        {proposed}
      </p>
      {proposal.payload && !proposal.withheld && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs" data-testid={`handoff-proposal-fields-${proposal.id}`}>
          {HANDOFF_PROPOSAL_FIELDS[proposal.op].map((field) => (
            <React.Fragment key={field}>
              <dt className="text-muted-foreground">{t(`mem.handoff.field.label.${field}`)}</dt>
              <dd className="min-w-0 break-words text-foreground" data-testid={`handoff-proposal-field-${proposal.id}-${field}`}>
                {proposal.op === 'update' && current && (
                  <span data-testid={`handoff-proposal-field-current-${proposal.id}-${field}`}>
                    {t('mem.handoff.field.current')}: {currentFieldText(field, current, t)}
                    {' → '}
                  </span>
                )}
                <span data-testid={`handoff-proposal-field-proposed-${proposal.id}-${field}`}>
                  {proposedFieldText(proposal.op, field, proposal.payload!, t)}
                </span>
              </dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {proposal.state === 'proposed' && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={choice === 'approve' ? 'primary' : 'secondary'}
            disabled={disabled || proposal.withheld !== undefined}
            aria-pressed={choice === 'approve'}
            onClick={() => onChoose('approve')}
            data-testid={`handoff-approve-${proposal.id}`}
          >
            {t('mem.handoff.approve')}
          </Button>
          <Button
            size="sm"
            variant={choice === 'discard' ? 'primary' : 'secondary'}
            disabled={disabled}
            aria-pressed={choice === 'discard'}
            onClick={() => onChoose('discard')}
            data-testid={`handoff-discard-${proposal.id}`}
          >
            {t('mem.handoff.discard')}
          </Button>
        </div>
      )}
      {proposal.state === 'conflict' && (
        <div className="flex flex-wrap gap-2" data-testid={`handoff-conflict-${proposal.id}`}>
          <Button size="sm" onClick={onRebase} disabled={rebaseDisabled} data-testid={`handoff-rebase-${proposal.id}`}>
            {t('mem.handoff.rebase')}
          </Button>
          <Button
            size="sm"
            variant={choice === 'discard' ? 'primary' : 'secondary'}
            disabled={disabled}
            aria-pressed={choice === 'discard'}
            onClick={() => onChoose('discard')}
            data-testid={`handoff-discard-${proposal.id}`}
          >
            {t('mem.handoff.discard')}
          </Button>
        </div>
      )}
    </li>
  );
}

export default SessionHandoffDialog;
