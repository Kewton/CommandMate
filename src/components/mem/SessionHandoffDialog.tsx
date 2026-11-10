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
 * @module components/mem/SessionHandoffDialog
 */
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Modal } from '@/components/ui';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useMemWriteLock } from '@/components/mem/mem-write-lock';
import { handoffApi, type HandoffDecision, type HandoffResult } from '@/lib/handoff/screen-client';
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
 * Why the dialog may not be closed now (Issue #4227 pr2c, design §4.1 "closing the dialog"):
 * every way of closing it — Esc, ×, the backdrop, "cancel the end", "close", the plain
 * "keep the session" — asks this one rule.
 *
 * - `stopping`: the stop is being declared or run (`end` → the existing stop → `end/observe`).
 *   Closing would cancel the request under a stop in flight (codex review P2-1); the
 *   existing confirmation ignores its cancel while its kill is in flight (Issue #1171) too.
 * - `unknown`: a decide is being sent, or its result is unknown. Closing would drop it with no
 *   choice of the person's (review B P3-3, the rule of G-PR1: an unknown result is kept until
 *   the person sends it again or drops it). One being sent may come back unknown, so it holds too.
 * - `null`: it may be closed.
 */
export type HandoffCloseBlock = 'stopping' | 'unknown' | null;
export function handoffCloseBlock(state: { stopping: boolean; sending: boolean; unknown: boolean }): HandoffCloseBlock {
  if (state.stopping) return 'stopping';
  if (state.sending || state.unknown) return 'unknown';
  return null;
}

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
  const [notice, setNotice] = useState<Notice>(null);
  const sendingRef = useRef(false);
  const stoppingRef = useRef(false);
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
    const result = await handoffApi.read(worktreeId, requestId);
    if (result.ok) adopt(result.body);
  }, [adopt, requestId, worktreeId]);

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
    setView(null);
    setText(null);
    setPlainOnly(null);
    setChoices({});
    // pr2c (10): a decide whose result is unknown is not dropped by a reopening (the person
    // sends it again or drops it); one of another worktree's is not this dialog's.
    if (pendingRef.current && pendingRef.current.worktreeId !== worktreeId) keepPending(null);
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
    // The request is made once per opening of the dialog for its target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, target?.instanceId, worktreeId]);

  // The screen reads again while the agent works (the server keeps no timer; §4.3).
  useEffect(() => {
    if (!isOpen || state !== 'awaiting_agent') return;
    const timer = setInterval(() => void reload(), HANDOFF_REFRESH_MS);
    return () => clearInterval(timer);
  }, [isOpen, reload, state]);

  /** Sends one decide as the one in flight: one at a time, none while another screen's item write is open. */
  const decide = useCallback(
    async (unit: DecideUnit) => {
      if (sendingRef.current || otherLock !== null) return;
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
    if (!view || lock !== null) return;
    // Rule (2): only what the person chose is sent, with the fingerprint of what was shown.
    const decisions: HandoffDecision[] = Object.entries(choices).map(([proposalId, entry]) => ({
      proposalId,
      fingerprint: entry.fingerprint,
      action: entry.choice,
    }));
    void decide({ worktreeId, requestId: view.request.id, ifVersion: view.request.version, decisions });
  }, [choices, decide, lock, view, worktreeId]);

  const goOn = useCallback(() => {
    if (!view || lock !== null) return;
    void decide({ worktreeId, requestId: view.request.id, ifVersion: view.request.version, decisions: [] });
  }, [decide, lock, view, worktreeId]);

  const simpleWrite = useCallback(
    async (run: () => Promise<HandoffResult<HandoffReadResponse>>, success?: string) => {
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
    if (!view || lock !== null) return;
    void simpleWrite(() => handoffApi.extend(worktreeId, view.request.id, view.request.version), t('mem.handoff.extended'));
  }, [lock, simpleWrite, t, view, worktreeId]);

  const rebase = useCallback(
    (proposal: HandoffProposalView) => {
      if (!view || lock !== null) return;
      void simpleWrite(() =>
        handoffApi.rebase(worktreeId, view.request.id, proposal.id, { ifVersion: view.request.version, fingerprint: proposal.fingerprint })
      );
    },
    [lock, simpleWrite, view, worktreeId]
  );

  /**
   * Every way of closing the dialog comes here (pr2c (1)・(10), {@link handoffCloseBlock}):
   * refused with a notice while the stop is in flight or a decide is sent or unknown;
   * otherwise the open request is cancelled (`cancel`) or the dialog just closed (`close`).
   */
  const requestClose = useCallback(
    async (how: 'cancel' | 'close') => {
      const block = handoffCloseBlock({ stopping: stoppingRef.current, sending: sendingRef.current, unknown: pendingRef.current !== null });
      if (block !== null) {
        setNotice({ tone: 'alert', text: t(block === 'stopping' ? 'mem.handoff.closeWhileStopping' : 'mem.handoff.closeWhileUnknown') });
        return;
      }
      closedRef.current = true;
      if (how === 'cancel' && view && ['awaiting_agent', 'reviewing', 'applying', 'ending'].includes(view.request.state)) {
        await handoffApi.cancel(worktreeId, view.request.id);
      }
      onClose();
    },
    [onClose, t, view, worktreeId]
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
      if (stoppingRef.current || closedRef.current || !view) return;
      stoppingRef.current = true;
      setStopping(true);
      setNotice(null);
      try {
        let endToken = view.request.state === 'ending' ? view.request.endToken : null;
        if (!endToken) {
          const ended = await handoffApi.end(worktreeId, view.request.id, { ifVersion: view.request.version, ...(force ? { force: true } : {}) });
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
        const observed = await handoffApi.observe(worktreeId, view.request.id, endToken);
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
    [adopt, onStop, refusal, reload, t, view, worktreeId]
  );

  /** No request: the existing stop only (no `end`, nothing recorded, §4.1 ①・H15(g)). */
  const plainStop = useCallback(async () => {
    if (stoppingRef.current || closedRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    try {
      await onStop();
      closedRef.current = true;
      onClose();
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }, [onClose, onStop]);

  if (!isOpen || !target) return null;

  const request = view?.request ?? null;
  const proposals = view?.proposals ?? [];
  const ended = request?.state === 'ended';
  const over = request !== null && ['ended', 'cancelled', 'expired'].includes(request.state);
  const beforeConfirm = proposals.every((proposal) => proposal.state !== 'applied');
  const canStop = request !== null && ['awaiting_agent', 'reviewing', 'ending'].includes(request.state);
  const canForce = request !== null && ['awaiting_agent', 'reviewing', 'applying', 'ending'].includes(request.state);

  return (
    <Modal isOpen={isOpen} onClose={() => void requestClose('cancel')} title={t('mem.handoff.title', { label: target.label })} size={isMobile ? 'full' : 'lg'}>
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
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void decide(pending)} disabled={busy} data-testid="handoff-pending-resend">
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

        {plainOnly !== null ? (
          <div className="space-y-2" data-testid="handoff-plain">
            <p className="text-foreground">{plainOnly}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => void requestClose('close')} data-testid="handoff-plain-cancel">
                {t('mem.handoff.keepSession')}
              </Button>
              <Button variant="danger" disabled={stopping} onClick={() => void plainStop()} data-testid="handoff-plain-stop">
                {t('mem.handoff.stop')}
              </Button>
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
                    disabled={busy || lock !== null || request.state !== 'reviewing'}
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
                  disabled={busy || lock !== null || Object.keys(choices).length === 0}
                  data-testid="handoff-confirm"
                >
                  {t('mem.handoff.confirm')}
                </Button>
              )}
              {!over && (
                <Button variant="ghost" onClick={() => void requestClose('cancel')} disabled={stopping} data-testid="handoff-cancel">
                  {t('mem.handoff.cancel')}
                </Button>
              )}
              {canStop && (
                <Button variant="danger" onClick={() => void stop(request.endForced)} disabled={stopping} data-testid="handoff-stop">
                  {t('mem.handoff.stop')}
                </Button>
              )}
              {canForce && beforeConfirm && !request.endForced && (
                <Button variant="danger" onClick={() => void stop(true)} disabled={stopping} data-testid="handoff-stop-now">
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
