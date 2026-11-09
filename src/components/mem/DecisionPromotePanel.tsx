/**
 * The one screen where a person approves a decision's record (Issue #4225, design §4.1):
 * the branch's decisions, the diff of the chosen one, and the buttons that write. The
 * screen of #4227 uses this part. PC and phone share it.
 *
 * Nothing is written until "Approve and write"; a 409 `reapproval_required` shows the
 * reason and asks for a new diff (never approves again by itself).
 *
 * What a person approves is what the preview shows (PM review P2・P3-1): the resolved
 * destination and the poster are shown with the body, and a preview made under other
 * choices (the item, the worktree, the effect, the quote's check) is dropped as soon as
 * one of them changes. The checks a person ticks belong to one item or one operation.
 */

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import type { PromoteDestination, PromoteEffect, PromoteOperationView, PromotePreviewView } from '@/lib/promote/model';
import { promoteApi, type PromoteCallResult, type PromoteFindingView, type PromoteListBody } from '@/lib/promote/screen-client';

const INPUT_CLASS =
  'rounded border border-border bg-surface px-2 py-1 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

type Notice = { tone: 'status' | 'alert'; text: string } | null;

/** The reasons under which the reconcile found the operation's own mark (design §3.4). */
const MARK_FOUND: ReadonlyArray<string> = ['body_differs', 'block_altered'];

/** Where the preview writes, resolved (P2): the repository and number, or the worktree, its branch and the path. */
function destinationText(destination: PromoteDestination, worktrees: PromoteListBody['worktrees']): string {
  if (destination.kind === 'issue_comment') {
    return `${destination.ref === 'pr' ? 'PR' : 'Issue'} ${destination.host}/${destination.owner}/${destination.repo}#${destination.number}`;
  }
  const worktree = worktrees.find((entry) => entry.id === destination.worktreeId);
  return `${worktree?.name ?? destination.worktreeId} (${destination.branch ?? '-'}): ${destination.path}`;
}

export function DecisionPromotePanel({ repositoryId, branch }: { repositoryId: string; branch: string }): React.ReactElement {
  const t = useTranslations('common');
  const [list, setList] = useState<PromoteListBody | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [worktreeId, setWorktreeId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [effect, setEffect] = useState<PromoteEffect>('spec');
  const [quoteConfirmed, setQuoteConfirmed] = useState(false);
  const [preview, setPreview] = useState<PromotePreviewView | null>(null);
  /** P3-1: the one operation whose difference a person checked (another operation's check is not carried over). */
  const [acknowledgeDiffFor, setAcknowledgeDiffFor] = useState<string | null>(null);
  /** P3-2: what the reconcile found of an operation's own mark, beside what was meant. */
  const [findings, setFindings] = useState<Record<string, PromoteFindingView>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const requestRef = useRef(0);
  /** P2: moves on every change of what a preview is made under; the answer of an older request is not shown. */
  const previewInputsRef = useRef(0);

  // P3-1: the quote's check belongs to the item it was ticked for.
  useEffect(() => {
    setQuoteConfirmed(false);
  }, [selected]);
  // P2: a preview made under other choices is not the one a person would approve.
  useEffect(() => {
    previewInputsRef.current += 1;
    setPreview(null);
  }, [selected, worktreeId, effect, quoteConfirmed]);

  const load = useCallback(async () => {
    requestRef.current += 1;
    const request = requestRef.current;
    const result = await promoteApi.list(repositoryId, branch);
    if (request !== requestRef.current) return;
    if (result.ok) {
      setList(result.body);
      setWorktreeId((current) => {
        if (current && result.body.worktrees.some((w) => w.id === current)) return current;
        return (result.body.worktrees.find((w) => w.branch === branch) ?? result.body.worktrees[0])?.id ?? '';
      });
    }
    setLoadFailed(!result.ok);
  }, [branch, repositoryId]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const report = useCallback(
    (result: PromoteCallResult<unknown>) => {
      if (result.ok) return true;
      if (result.code === 'reapproval_required') {
        setPreview(null);
        setNotice({ tone: 'alert', text: t('mem.decisions.reapproval', { reason: result.reason ?? '' }) });
      } else {
        setNotice({ tone: 'alert', text: t('mem.decisions.failed', { code: result.code ?? String(result.status) }) });
      }
      return false;
    },
    [t]
  );

  const run = useCallback(
    async (action: () => Promise<PromoteCallResult<unknown>>) => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await action();
        if (report(result)) setNotice({ tone: 'status', text: t('mem.decisions.operation.succeeded') });
        await load();
        return result;
      } finally {
        setBusy(false);
      }
    },
    [load, report, t]
  );

  const reconcile = useCallback(
    async (operationId: string) => {
      const result = await run(() => promoteApi.reconcile(repositoryId, operationId));
      const finding = result.ok ? (result.body as { finding?: PromoteFindingView }).finding : undefined;
      setFindings((current) => {
        const next = { ...current };
        if (finding) next[operationId] = finding;
        else delete next[operationId];
        return next;
      });
    },
    [repositoryId, run]
  );

  const makePreview = useCallback(
    async (itemId: string) => {
      setBusy(true);
      setNotice(null);
      const inputs = previewInputsRef.current;
      const result = await promoteApi.preview(repositoryId, itemId, { worktreeId, effect, quoteConfirmed });
      setBusy(false);
      if (inputs !== previewInputsRef.current) return;
      if (report(result) && result.ok) setPreview(result.body.preview);
    },
    [effect, quoteConfirmed, report, repositoryId, worktreeId]
  );

  if (loadFailed && !list) {
    return (
      <p role="alert" className="text-xs text-danger-foreground" data-testid="decision-promote-error">
        {t('mem.decisions.loadError')}
      </p>
    );
  }
  if (!list) return <p className="text-xs text-muted-foreground">{t('mem.decisions.loading')}</p>;

  /**
   * One operation and what can be done with it. `item` is what the item can still do
   * (5-2c P2-3): a closed or purged item never moves, so the outcome outside is only
   * acknowledged; while the roots disagree on the mode (`ambiguous`) the item cannot move
   * either, so only the outcome is reconciled.
   */
  const operationLine = (operation: PromoteOperationView, version: number | null, item: 'movable' | 'closed' | 'frozen') => {
    const markFound = operation.state === 'unknown' && operation.unknownReason !== null && MARK_FOUND.includes(operation.unknownReason);
    const finding = findings[operation.id];
    // P3-2: both are shown for the reason the reconcile answered; "treat as written" is offered only beside them.
    const foundShown = markFound && finding && finding.reason === operation.unknownReason ? finding : null;
    return (
      <li key={operation.id} className="space-y-1 text-xs" data-testid={`decision-operation-${operation.id}`}>
        <span className="text-foreground">{t(`mem.decisions.operation.${operation.state}`)}</span>
        {markFound && (
          <p className="text-danger-foreground" data-testid={`decision-mark-found-${operation.id}`}>
            {t('mem.decisions.markFound', { reason: operation.unknownReason ?? '' })}
          </p>
        )}
        {foundShown && (
          <div className="grid gap-2 md:grid-cols-2" data-testid={`decision-finding-${operation.id}`}>
            <div className="min-w-0 space-y-1">
              <p className="text-muted-foreground">{t('mem.decisions.found')}</p>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-2 text-foreground">
                {foundShown.found ?? t('mem.decisions.foundUnreadable')}
              </pre>
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-muted-foreground">{t('mem.decisions.intended')}</p>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-2 text-foreground">{foundShown.intended}</pre>
            </div>
          </div>
        )}
        {operation.transitionPending && (
          <span className="ml-2 text-danger-foreground">{t('mem.decisions.pending', { reason: operation.transitionReason ?? '' })}</span>
        )}
        {operation.concurrentEdit && <span className="ml-2 text-danger-foreground">{t('mem.decisions.concurrent')}</span>}
        <div className="flex flex-wrap gap-1">
          {operation.state === 'unknown' && (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reconcile(operation.id)}>
                {t('mem.decisions.reconcile')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => promoteApi.abandon(repositoryId, operation.id))}>
                {t('mem.decisions.abandon')}
              </Button>
              {foundShown && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void run(() => promoteApi.acceptFound(repositoryId, operation.id, foundShown.reason))}
                >
                  {t('mem.decisions.acceptFound')}
                </Button>
              )}
            </>
          )}
          {operation.state === 'succeeded' && operation.transitionPending && item === 'movable' && version !== null && (
            <>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={acknowledgeDiffFor === operation.id}
                  onChange={(e) => setAcknowledgeDiffFor(e.target.checked ? operation.id : null)}
                />
                {t('mem.decisions.acknowledgeDiff')}
              </label>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !worktreeId}
                onClick={() =>
                  void run(() => promoteApi.settleTransition(repositoryId, operation.id, worktreeId, version, acknowledgeDiffFor === operation.id))
                }
              >
                {t('mem.decisions.settleTransition')}
              </Button>
            </>
          )}
          {operation.state === 'succeeded' && operation.transitionPending && item === 'closed' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => promoteApi.acknowledgeItemClosed(repositoryId, operation.id))}>
              {t('mem.decisions.acknowledgeItemClosed')}
            </Button>
          )}
        </div>
      </li>
    );
  };
  const ambiguous = list.mode === 'ambiguous';

  return (
    <div className="space-y-3" data-testid="decision-promote-panel">
      <p className="text-xs text-muted-foreground">{t('mem.decisions.description')}</p>
      <p className="text-xs text-muted-foreground">{t('mem.decisions.limits')}</p>
      {ambiguous ? (
        <p role="status" className="text-xs text-danger-foreground" data-testid="decision-ambiguous">
          {t('mem.decisions.ambiguous', { roots: (list.ambiguous?.roots ?? []).map((root) => root.name).join(', ') })}
        </p>
      ) : (
        list.mode !== 'on' && (
          <p role="status" className="text-xs text-danger-foreground">
            {t('mem.decisions.modeNotOn', { mode: list.mode })}
          </p>
        )
      )}
      <label className="flex flex-wrap items-center gap-2 text-xs text-foreground">
        {t('mem.decisions.worktree')}
        {list.worktrees.length === 0 ? (
          <span className="text-muted-foreground">{t('mem.decisions.noWorktree')}</span>
        ) : (
          <select className={INPUT_CLASS} value={worktreeId} onChange={(e) => setWorktreeId(e.target.value)} data-testid="decision-worktree">
            {list.worktrees.map((worktree) => (
              <option key={worktree.id} value={worktree.id}>
                {worktree.name}
                {worktree.branch ? ` (${worktree.branch})` : ''}
              </option>
            ))}
          </select>
        )}
      </label>
      {list.decisions.length === 0 && !ambiguous && <p className="text-xs text-muted-foreground">{t('mem.decisions.none')}</p>}
      <ul className="space-y-3">
        {list.decisions.map(({ item, unreflected, operations }) => (
          <li key={item.id} className="space-y-2 rounded border border-border p-2" data-testid={`decision-${item.id}`}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-foreground">{t(`mem.decisions.state.${item.state}`)}</span>
              <span className="text-muted-foreground">v{item.version}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-xs text-foreground">{item.text}</p>
            <p className="break-all text-xs text-muted-foreground">
              {t('mem.decisions.destination')}: {item.promoteTo ?? t('mem.decisions.noDestination')}
            </p>
            {unreflected && (
              <p role="status" className="text-xs text-danger-foreground" data-testid={`decision-unreflected-${item.id}`}>
                {t('mem.decisions.unreflected')}
              </p>
            )}
            {operations.length > 0 && <ul className="space-y-1">{operations.map((operation) => operationLine(operation, item.version, 'movable'))}</ul>}
            <div className="flex flex-wrap gap-1">
              {item.state === 'open' && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setSelected(selected === item.id ? null : item.id)}
                  data-testid={`decision-select-${item.id}`}
                >
                  {t('mem.decisions.makePreview')}
                </Button>
              )}
              {item.state === 'recorded' && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !worktreeId}
                  onClick={() => void run(() => promoteApi.confirmReflected(repositoryId, item.id, worktreeId, item.version))}
                >
                  {t('mem.decisions.confirmReflected')}
                </Button>
              )}
            </div>
            {selected === item.id && item.state === 'open' && (
              <div className="space-y-2">
                <label className="flex flex-wrap items-center gap-2 text-xs text-foreground">
                  {t('mem.decisions.effect.label')}
                  <select className={INPUT_CLASS} value={effect} onChange={(e) => setEffect(e.target.value as PromoteEffect)}>
                    <option value="spec">{t('mem.decisions.effect.spec')}</option>
                    <option value="record_only">{t('mem.decisions.effect.record_only')}</option>
                  </select>
                </label>
                {item.quote && (
                  <div className="space-y-1">
                    <blockquote
                      className="whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs text-foreground"
                      data-testid={`decision-quote-${item.id}`}
                    >
                      {item.quote}
                    </blockquote>
                    <label className="flex items-center gap-2 text-xs text-foreground">
                      <input type="checkbox" checked={quoteConfirmed} onChange={(e) => setQuoteConfirmed(e.target.checked)} />
                      {t('mem.decisions.quoteConfirmed')}
                    </label>
                  </div>
                )}
                <Button size="sm" disabled={busy || !worktreeId || !item.promoteTo} onClick={() => void makePreview(item.id)}>
                  {t('mem.decisions.makePreview')}
                </Button>
                {preview && preview.itemId === item.id && (
                  <div className="space-y-2" data-testid={`decision-preview-${item.id}`}>
                    <h4 className="text-xs font-medium text-foreground">{t('mem.decisions.preview')}</h4>
                    <p className="break-all text-xs text-foreground" data-testid={`decision-preview-destination-${item.id}`}>
                      {t('mem.decisions.previewDestination', { destination: destinationText(preview.destination, list.worktrees) })}
                    </p>
                    {preview.poster && (
                      <p className="break-all text-xs text-foreground" data-testid={`decision-preview-poster-${item.id}`}>
                        {t('mem.decisions.poster', { login: preview.poster.login })}
                      </p>
                    )}
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-2 text-xs text-foreground">
                      {preview.body}
                    </pre>
                    <p className="text-xs text-muted-foreground">{t('mem.decisions.expires', { time: preview.expiresAt })}</p>
                    {preview.invisibleReplaced && <p className="text-xs text-danger-foreground">{t('mem.decisions.invisible')}</p>}
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={async () => {
                          const shown = preview;
                          setPreview(null);
                          await run(() => promoteApi.approve(repositoryId, shown));
                        }}
                      >
                        {t('mem.decisions.approve')}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
                        {t('mem.decisions.cancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {(list.unresolved ?? []).length > 0 && (
        <div className="space-y-2 rounded border border-border p-2" data-testid="decision-unresolved">
          <h4 className="text-xs font-medium text-foreground">{t(ambiguous ? 'mem.decisions.unresolvedAmbiguous' : 'mem.decisions.unresolved')}</h4>
          <ul className="space-y-2">
            {(list.unresolved ?? []).map(({ operation, item, itemVersion }) => (
              <li key={operation.id} className="space-y-1">
                <p className="break-all text-xs text-muted-foreground">
                  {item === null
                    ? t('mem.decisions.unresolvedItemGone', { itemId: operation.itemId })
                    : item.state === 'closed'
                      ? t('mem.decisions.unresolvedItemClosed', { itemId: operation.itemId })
                      : t('mem.decisions.unresolvedItemOpen', { itemId: operation.itemId })}
                </p>
                <ul>{operationLine(operation, itemVersion, item === null || item.state === 'closed' ? 'closed' : ambiguous ? 'frozen' : 'movable')}</ul>
              </li>
            ))}
          </ul>
        </div>
      )}
      {notice && (
        <p role={notice.tone} className={`text-xs ${notice.tone === 'status' ? 'text-muted-foreground' : 'text-danger-foreground'}`} data-testid="decision-promote-notice">
          {notice.text}
        </p>
      )}
    </div>
  );
}
