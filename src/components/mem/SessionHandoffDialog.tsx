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
 * person's choice, and once a cancel has started no decide is sent.
 *
 * @module components/mem/SessionHandoffDialog
 */
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Modal } from '@/components/ui';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useMemWriteLock } from '@/components/mem/mem-write-lock';
import { handoffApi, type HandoffDecision, type HandoffResult } from '@/lib/handoff/screen-client';
import {
  askHandoffClose,
  registerHandoffHold,
  type HandoffCloseBlock,
  type HandoffClosePath,
  type HandoffHold,
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
  /** The existing stop (kill-session). Called from the stop buttons' handlers only. */
  onStop: () => Promise<void>;
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

type Choice = 'approve' | 'discard';
/** A decide whose result is unknown (status 0): sent again as it was (rule (4)). */
interface DecideUnit {
  /** The worktree it was sent for: a unit kept over a reopening is sent again there (pr2c (10)). */
  worktreeId: string;
  requestId: string;
  ifVersion: number;
  decisions: HandoffDecision[];
}
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

export function SessionHandoffDialog({ isOpen, worktreeId, target, onClose, onStop }: SessionHandoffDialogProps) {
  const t = useTranslations('common');
  const isMobile = useIsMobile();
  const [view, setView] = useState<HandoffReadResponse | null>(null);
  const [text, setText] = useState<string | null>(null);
  /** No request could be made (no conversation known, or the session changed): a plain stop only. */
  const [plainOnly, setPlainOnly] = useState<string | null>(null);
  const [choices, setChoices] = useState<Readonly<Record<string, { choice: Choice; fingerprint: string }>>>({});
  const [inflight, setInflight] = useState<DecideUnit | null>(null);
  const [pending, setPending] = useState<DecideUnit | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  /** The plain stop ran but a decide is unknown, so the dialog stayed (pr2d, codex P2 2). */
  const [plainStopped, setPlainStopped] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  /**
   * The worktree the dialog was opened for (pr2d). The page keeps the dialog over a switch of
   * worktree while it holds something; on another worktree's page it is "foreign": its request
   * is still addressed to this worktree, and no stop nor write of this dialog's runs there
   * (the page's stop is the other worktree's).
   */
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const forWorktree = openedFor ?? worktreeId;
  const foreign = openedFor !== null && openedFor !== worktreeId;
  const sendingRef = useRef(false);
  const stoppingRef = useRef(false);
  /** Set from a cancel being sent until it is answered: no new decide is sent (pr2d, condition 4). */
  const cancellingRef = useRef(false);
  /** Mirrors `pending` for the close rule, read in the same tick as the press. */
  const pendingRef = useRef<DecideUnit | null>(null);
  /**
   * Set when the dialog is closed or its request cancelled (pr2c (1)): a stop whose `end`
   * answers after that does not go on to the existing stop.
   */
  const closedRef = useRef(false);
  const keepPending = useCallback((unit: DecideUnit | null) => {
    pendingRef.current = unit;
    setPending(unit);
  }, []);

  /** What this dialog holds now, read in the same tick as a press or the page's path. */
  const readHold = useCallback(
    (): HandoffHold => ({
      stopping: stoppingRef.current,
      sending: sendingRef.current,
      unknown: pendingRef.current !== null,
      cancelling: cancellingRef.current,
    }),
    []
  );
  useEffect(
    () =>
      registerHandoffHold({
        read: readHold,
        refused: (_path, block) => setNotice({ tone: 'alert', text: t(CLOSE_NOTICE[block]) }),
      }),
    [readHold, t]
  );

  const ownLock = inflight !== null ? 'sending' : pending !== null ? 'unknown' : null;
  const otherLock = useMemWriteLock(HANDOFF_LOCK_OWNER, ownLock);
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

  const adopt = useCallback((next: HandoffReadResponse | undefined) => {
    if (next?.request) setView(next);
  }, []);

  const reload = useCallback(async () => {
    if (!requestId) return;
    const result = await handoffApi.read(forWorktree, requestId);
    if (result.ok) adopt(result.body);
  }, [adopt, requestId, forWorktree]);

  /** ①②: make the request and send its text to the agent. */
  const sendText = useCallback(
    async (requestIdToSend: string, body: string) => {
      if (!target) return;
      const sent = await handoffApi.sendText(worktreeId, body, { cliToolId: target.cliToolId, instanceId: target.instanceId });
      const marked = sent.ok ? await handoffApi.sent(worktreeId, requestIdToSend) : await handoffApi.sendFailed(worktreeId, requestIdToSend);
      if (marked.ok) adopt(marked.body);
      setNotice(sent.ok ? null : { tone: 'alert', text: t('mem.handoff.sendFailed') });
    },
    [adopt, t, target, worktreeId]
  );

  useEffect(() => {
    if (!isOpen || !target) {
      closedRef.current = true;
      return;
    }
    closedRef.current = false;
    let live = true;
    setOpenedFor(worktreeId);
    setView(null);
    setText(null);
    setPlainOnly(null);
    setPlainStopped(false);
    setChoices({});
    // pr2c (10)・pr2d: a decide whose result is unknown is never dropped by an opening, of
    // this worktree's or another's: the person sends it again (on its own worktree) or drops it.
    setNotice(null);
    void (async () => {
      const created = await handoffApi.create(worktreeId, target.instanceId);
      if (!live) return;
      if (created.ok) {
        adopt(created.body);
        setText(created.body.text);
        await sendText(created.body.request.id, created.body.text);
        return;
      }
      const body = created.body as Partial<HandoffReadResponse> | undefined;
      if (created.code === 'request_open' && body?.request) {
        adopt(body as HandoffReadResponse);
        return;
      }
      setPlainOnly(created.code === 'session_unknown' ? t('mem.handoff.sessionUnknown') : refusal(created));
    })();
    return () => {
      live = false;
    };
    // The request is made once per opening of the dialog for its target. A switch of worktree
    // while it is open (the page keeps it only while it holds something) makes no request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, target?.instanceId]);

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
    async (unit: DecideUnit) => {
      if (sendingRef.current || cancellingRef.current || closedRef.current || otherLock !== null) return;
      sendingRef.current = true;
      setInflight(unit);
      setBusy(true);
      setNotice(null);
      try {
        const result = await handoffApi.decide(unit.worktreeId, unit.requestId, { ifVersion: unit.ifVersion, decisions: unit.decisions });
        if (!result.ok && result.status === 0) {
          // Rule (4): not known whether it was written. Kept as it was, to send again.
          keepPending(unit);
          setNotice({ tone: 'alert', text: t('mem.handoff.unknown') });
          return;
        }
        keepPending(null);
        if (result.ok) {
          adopt(result.body);
          setChoices({});
          const failed = result.body.results.filter((entry) => entry.result !== 'applied' && entry.result !== 'discarded');
          setNotice({ tone: failed.length > 0 ? 'alert' : 'status', text: failed.length > 0 ? t('mem.handoff.someNotApplied') : t('mem.handoff.decided') });
          return;
        }
        // Rule (4)(c): a refusal (a resend's version conflict included) is not read as success:
        // what the server holds now is shown, and the person chooses again.
        adopt(result.body as unknown as HandoffReadResponse);
        setChoices({});
        setNotice({ tone: 'alert', text: refusal(result) });
        if (!result.body?.request) await reload();
      } finally {
        sendingRef.current = false;
        setInflight(null);
        setBusy(false);
      }
    },
    [adopt, keepPending, otherLock, refusal, reload, t]
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
      if (cancellingRef.current || closedRef.current) return;
      setBusy(true);
      try {
        const result = await run();
        if (result.ok) {
          adopt(result.body);
          setNotice(success ? { tone: 'status', text: success } : null);
        } else {
          setNotice({ tone: 'alert', text: refusal(result) });
          await reload();
        }
      } finally {
        setBusy(false);
      }
    },
    [adopt, refusal, reload]
  );

  const extend = useCallback(() => {
    if (!view || lock !== null || foreign) return;
    void simpleWrite(() => handoffApi.extend(forWorktree, view.request.id, view.request.version), t('mem.handoff.extended'));
  }, [foreign, forWorktree, lock, simpleWrite, t, view]);

  const rebase = useCallback(
    (proposal: HandoffProposalView) => {
      if (!view || lock !== null || foreign) return;
      void simpleWrite(() =>
        handoffApi.rebase(forWorktree, view.request.id, proposal.id, { ifVersion: view.request.version, fingerprint: proposal.fingerprint })
      );
    },
    [foreign, forWorktree, lock, simpleWrite, view]
  );

  /**
   * The dialog's only call of `onClose` (pr2d): asks the rule ({@link askHandoffClose}) for
   * `path`; refused, it stays and says why. The guard `handoff-close-paths-4227` keeps it the only one.
   */
  const closeBy = useCallback(
    (path: HandoffClosePath): boolean => {
      const block = askHandoffClose(path, readHold());
      if (block !== null) {
        setNotice({ tone: 'alert', text: t(CLOSE_NOTICE[block]) });
        return false;
      }
      closedRef.current = true;
      onClose();
      return true;
    },
    [onClose, readHold, t]
  );

  /**
   * The person's ways of closing (Esc, ×, the backdrop, "cancel the end", "close", "keep the
   * session"): refused while the rule says so; otherwise the open request is cancelled
   * (`cancel`) or the dialog just closed (`close`). While the cancel is answered no decide is
   * sent and nothing else closes it; its answer asks the rule again (`cancel-answer`).
   */
  const requestClose = useCallback(
    async (how: 'cancel' | 'close') => {
      if (how === 'close' || !view || !['awaiting_agent', 'reviewing', 'applying', 'ending'].includes(view.request.state)) {
        closeBy('person');
        return;
      }
      const block = askHandoffClose('person', readHold());
      if (block !== null) {
        setNotice({ tone: 'alert', text: t(CLOSE_NOTICE[block]) });
        return;
      }
      closedRef.current = true;
      cancellingRef.current = true;
      setCancelling(true);
      try {
        await handoffApi.cancel(forWorktree, view.request.id);
      } finally {
        cancellingRef.current = false;
        setCancelling(false);
      }
      if (!closeBy('cancel-answer')) {
        // Not reached while no decide can start after the cancel; kept for the rule's sake.
        closedRef.current = false;
        await reload();
      }
    },
    [closeBy, forWorktree, readHold, reload, t, view]
  );

  const resendText = useCallback(() => {
    if (view && text) void sendText(view.request.id, text);
  }, [sendText, text, view]);

  /**
   * The stop button's handler (§4.1 ⑥): the declaration, the existing stop, the
   * observation — in this order, once each. The only place `onStop` is called with a request.
   */
  const stop = useCallback(
    async (force: boolean) => {
      // Not from another worktree's page: the page's stop is that worktree's (pr2d).
      if (stoppingRef.current || closedRef.current || !view || foreign) return;
      stoppingRef.current = true;
      setStopping(true);
      setNotice(null);
      try {
        let endToken = view.request.state === 'ending' ? view.request.endToken : null;
        if (!endToken) {
          const ended = await handoffApi.end(forWorktree, view.request.id, { ifVersion: view.request.version, ...(force ? { force: true } : {}) });
          if (!ended.ok) {
            if (ended.code === 'session_changed') {
              setPlainOnly(t('mem.handoff.sessionChanged'));
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
        if (closedRef.current) return;
        await onStop();
        const observed = await handoffApi.observe(forWorktree, view.request.id, endToken);
        if (observed.ok) {
          adopt(observed.body);
        } else {
          adopt(observed.body as unknown as HandoffReadResponse);
          setNotice({ tone: 'alert', text: observed.code === 'not_stopped' ? t('mem.handoff.notStopped') : refusal(observed) });
        }
      } finally {
        stoppingRef.current = false;
        setStopping(false);
      }
    },
    [adopt, foreign, forWorktree, onStop, refusal, reload, t, view]
  );

  /**
   * No request: the existing stop only (no `end`, nothing recorded, §4.1 ①・H15(g)). Its end
   * closes the dialog through the rule (`plain-stop-done`): a decide still unknown keeps it
   * open for the person's choice (pr2d, codex P2 2).
   */
  const plainStop = useCallback(async () => {
    if (stoppingRef.current || closedRef.current || foreign) return;
    stoppingRef.current = true;
    setStopping(true);
    try {
      await onStop();
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
    if (!closeBy('plain-stop-done')) setPlainStopped(true);
  }, [closeBy, foreign, onStop]);

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
            {!pendingSendable && (
              <p className="text-xs text-muted-foreground" data-testid="handoff-pending-elsewhere">
                {t('mem.handoff.pendingElsewhere', { worktree: pending.worktreeId })}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  if (pendingSendable) void decide(pending);
                }}
                disabled={busy || cancelling || !pendingSendable}
                data-testid="handoff-pending-resend"
              >
                {t('mem.handoff.resend')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  keepPending(null);
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
              <Button variant="ghost" onClick={() => void requestClose('close')} data-testid="handoff-foreign-close">
                {t('mem.handoff.close')}
              </Button>
            </div>
          </div>
        ) : plainOnly !== null ? (
          <div className="space-y-2" data-testid="handoff-plain">
            <p className="text-foreground">{plainStopped ? t('mem.handoff.plainStopped') : plainOnly}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => void requestClose('close')} data-testid="handoff-plain-cancel">
                {plainStopped ? t('mem.handoff.close') : t('mem.handoff.keepSession')}
              </Button>
              {!plainStopped && (
                <Button variant="danger" disabled={stopping} onClick={() => void plainStop()} data-testid="handoff-plain-stop">
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
            {request.state === 'awaiting_agent' && request.sendState === 'failed' && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={resendText} disabled={busy || text === null} data-testid="handoff-resend-text">
                  {t('mem.handoff.resendText')}
                </Button>
              </div>
            )}
            {request.state === 'awaiting_agent' && request.agentTimedOut && (
              <div className="space-y-1 rounded border border-warning-border bg-warning-subtle p-2" data-testid="handoff-agent-timeout">
                <p className="text-xs text-foreground">{t('mem.handoff.agentTimeout')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={extend} disabled={busy || lock !== null || request.extensions >= 2} data-testid="handoff-extend">
                    {t('mem.handoff.extend')}
                  </Button>
                  <Button size="sm" onClick={goOn} disabled={busy || lock !== null} data-testid="handoff-go-on">
                    {t('mem.handoff.goOn')}
                  </Button>
                </div>
              </div>
            )}

            {proposals.length > 0 && (
              <ul className="space-y-2" data-testid="handoff-proposals">
                {proposals.map((proposal) => (
                  <ProposalRow
                    key={proposal.id}
                    proposal={proposal}
                    choice={choices[proposal.id]?.choice ?? null}
                    disabled={busy || cancelling || lock !== null || request.state !== 'reviewing'}
                    onChoose={(choice) =>
                      setChoices((current) => {
                        if (current[proposal.id]?.choice === choice) {
                          const rest = { ...current };
                          delete rest[proposal.id];
                          return rest;
                        }
                        return { ...current, [proposal.id]: { choice, fingerprint: proposal.fingerprint } };
                      })
                    }
                    onRebase={() => rebase(proposal)}
                    rebaseDisabled={busy || lock !== null || request.state !== 'reviewing'}
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
                  disabled={busy || cancelling || lock !== null || Object.keys(choices).length === 0}
                  data-testid="handoff-confirm"
                >
                  {t('mem.handoff.confirm')}
                </Button>
              )}
              {!over && (
                <Button variant="ghost" onClick={() => void requestClose('cancel')} disabled={stopping || cancelling} data-testid="handoff-cancel">
                  {t('mem.handoff.cancel')}
                </Button>
              )}
              {canStop && (
                <Button variant="danger" onClick={() => void stop(request.endForced)} disabled={stopping || cancelling} data-testid="handoff-stop">
                  {t('mem.handoff.stop')}
                </Button>
              )}
              {canForce && beforeConfirm && !request.endForced && (
                <Button variant="danger" onClick={() => void stop(true)} disabled={stopping || cancelling} data-testid="handoff-stop-now">
                  {t('mem.handoff.stopNow')}
                </Button>
              )}
              {over && (
                <Button variant="ghost" onClick={() => void requestClose('close')} data-testid="handoff-close">
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
