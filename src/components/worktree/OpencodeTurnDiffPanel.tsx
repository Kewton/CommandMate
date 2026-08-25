/**
 * The files the last opencode turn changed, and the two buttons that undo them
 * (Issue #2043).
 *
 * Rendered for opencode instances only, and only when there is something to
 * show — Issue #2043's second acceptance criterion is that a claude or codex
 * pane never grows an empty panel, and {@link hasAgentSessionDiff} is the single
 * rule that keeps that true. Every other tool publishes no `sessionDiff` at all,
 * so for them the check is `null` and this component returns `null`.
 *
 * ## Two lists, because they are two different facts
 *
 * `files` is what the last turn changed. `revertedFiles` is what a revert is
 * currently holding back. They are measured from different places and neither
 * implies the other — see `lib/hooks/sources/opencode/diff` for why. The panel
 * shows whichever it has, and the button it offers follows the second: a
 * session holding work back offers **Restore**, one that is not offers
 * **Revert**.
 *
 * ## Why clicking a file opens `DiffViewer` here rather than the file pane
 *
 * opencode hands back a real unified diff in `patch`, which is exactly what
 * `DiffViewer` renders — so the existing diff view is reused verbatim, in a
 * modal, rather than threaded through four layers of pane props. That also makes
 * the panel behave identically on mobile, where there is no right-hand pane to
 * push a diff into.
 *
 * ## Why revert is confirmed
 *
 * Measured, not assumed: reverting to the first turn of a two-turn session
 * restored one file to its pre-session contents **and deleted** the file the
 * agent had created, and it rolls back committed work in the working tree too
 * (`docs/design/opencode-server-live-verification.md` §16.5).
 */

'use client';

import React, { memo, useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileDiff, RotateCcw, RotateCw } from 'lucide-react';
import { Button, Modal, Spinner, useConfirm } from '@/components/ui';
import { DiffViewer } from '@/components/worktree/DiffViewer';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  hasAgentSessionDiff,
  type AgentSessionDiffFileView,
  type AgentSessionDiffView,
} from '@/types/agent-session';

/** Mirrors OPENCODE_DIFF_ACTIONS in the route. */
type OpencodeDiffAction = 'revert' | 'unrevert';

export interface OpencodeTurnDiffPanelProps {
  worktreeId: string;
  /** Rendered only for `'opencode'`; anything else renders nothing at all. */
  cliToolId: CLIToolType;
  /** Agent instance id. Defaults to the primary instance (`=== cliToolId`). */
  instanceId?: string;
  /** `structuredEvents.sessionDiff` for this pane, straight off the poll. */
  diff: AgentSessionDiffView | null | undefined;
  /** Disabled while nothing is running — both actions need a live server. */
  disabled?: boolean;
}

/** The inline notice shown after an action that did not simply work. */
type PanelNotice = 'busy' | 'noop' | 'failed' | null;

/** `+12 −3`, or an empty string when the agent reported neither. */
function formatCounts(file: AgentSessionDiffFileView): string {
  const parts: string[] = [];
  if (file.additions > 0) parts.push(`+${file.additions}`);
  if (file.deletions > 0) parts.push(`−${file.deletions}`);
  return parts.join(' ');
}

export const OpencodeTurnDiffPanel = memo(function OpencodeTurnDiffPanel({
  worktreeId,
  cliToolId,
  instanceId,
  diff,
  disabled = false,
}: OpencodeTurnDiffPanelProps) {
  // The `worktree` namespace with an `opencodeDiff.` prefix rather than
  // `useTranslations('worktree.opencodeDiff')`: every other component in this
  // directory addresses the namespace by file, and the test helper that loads
  // the real dictionary resolves a namespace to `locales/<locale>/<ns>.json`.
  const t = useTranslations('worktree');
  const confirm = useConfirm();
  const [pending, setPending] = useState<OpencodeDiffAction | null>(null);
  const [notice, setNotice] = useState<PanelNotice>(null);
  const [openFile, setOpenFile] = useState<AgentSessionDiffFileView | null>(null);

  // A revert is "active" when opencode says it is holding work back. That flag,
  // not the file lists, decides which of the two buttons is offered: a session
  // can be holding a revert whose file list this pane has not received yet.
  const reverted = diff?.revertedMessageId != null;
  const rows = useMemo<AgentSessionDiffFileView[]>(
    () => (reverted ? (diff?.revertedFiles ?? []) : (diff?.files ?? [])),
    [reverted, diff]
  );

  const run = useCallback(
    async (action: OpencodeDiffAction) => {
      setNotice(null);
      setPending(action);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/opencode/diff`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, instanceId: instanceId ?? cliToolId }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          applied?: boolean;
          code?: string;
        };
        if (response.status === 409 && payload.code === 'SESSION_BUSY') {
          setNotice('busy');
          return;
        }
        if (!response.ok) {
          setNotice('failed');
          return;
        }
        // Measured: opencode answers 200 for a revert that did nothing. The
        // body is the only place that shows, so the panel reads it rather than
        // reporting success on the status code.
        if (payload.applied === false) setNotice('noop');
      } catch {
        setNotice('failed');
      } finally {
        setPending(null);
      }
    },
    [worktreeId, cliToolId, instanceId]
  );

  const onRevert = useCallback(async () => {
    const ok = await confirm({
      title: t('opencodeDiff.revertConfirmTitle'),
      description: t('opencodeDiff.revertConfirmBody', { count: rows.length }),
      confirmLabel: t('opencodeDiff.revertConfirmLabel'),
      variant: 'danger',
    });
    if (ok) await run('revert');
  }, [confirm, t, rows.length, run]);

  const onUnrevert = useCallback(async () => {
    const ok = await confirm({
      title: t('opencodeDiff.unrevertConfirmTitle'),
      description: t('opencodeDiff.unrevertConfirmBody', { count: rows.length }),
      confirmLabel: t('opencodeDiff.unrevertConfirmLabel'),
    });
    if (ok) await run('unrevert');
  }, [confirm, t, rows.length, run]);

  if (cliToolId !== 'opencode') return null;
  if (!hasAgentSessionDiff(diff)) return null;

  return (
    <div
      className="border-t border-border bg-muted/30 px-3 py-2 text-xs"
      data-testid="opencode-turn-diff-panel"
    >
      <div className="flex items-center gap-2">
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium text-foreground">
          {reverted ? t('opencodeDiff.revertedTitle') : t('opencodeDiff.title')}
        </span>
        <span className="text-muted-foreground">
          {reverted
            ? t('opencodeDiff.revertedSubtitle', { count: rows.length })
            : t('opencodeDiff.subtitle', { count: rows.length })}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {pending !== null ? <Spinner size="sm" /> : null}
          {reverted ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onUnrevert}
              disabled={disabled || pending !== null}
            >
              <RotateCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t('opencodeDiff.unrevert')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRevert}
              disabled={disabled || pending !== null}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t('opencodeDiff.revert')}
            </Button>
          )}
        </span>
      </div>

      {notice !== null ? (
        <p className="mt-1 text-danger-foreground" role="status">
          {t(`opencodeDiff.${notice}`)}
        </p>
      ) : null}

      <ul className="mt-1 space-y-0.5">
        {rows.map((file, index) => {
          const label = file.file ?? t('opencodeDiff.unnamedFile');
          const counts = formatCounts(file);
          return (
            <li key={`${file.file ?? 'unnamed'}-${index}`} className="flex items-center gap-2">
              {/* A row with no `patch` has nothing to show, so it is text rather
                  than a button that would open an empty viewer. */}
              {file.patch !== null && file.file !== null ? (
                <button
                  type="button"
                  className="truncate text-info underline-offset-2 hover:underline"
                  onClick={() => setOpenFile(file)}
                  title={t('opencodeDiff.openDiff', { file: label })}
                >
                  {label}
                </button>
              ) : (
                <span className="truncate text-muted-foreground">{label}</span>
              )}
              {file.status !== null ? (
                <span className="shrink-0 text-muted-foreground">{t(`opencodeDiff.status.${file.status}`)}</span>
              ) : null}
              {counts !== '' ? (
                <span className="shrink-0 font-mono text-muted-foreground">{counts}</span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Modal
        isOpen={openFile !== null}
        onClose={() => setOpenFile(null)}
        title={openFile?.file ?? undefined}
        size="xl"
      >
        {openFile !== null ? (
          <DiffViewer
            diff={openFile.patch ?? ''}
            filePath={openFile.file ?? ''}
            onClose={() => setOpenFile(null)}
          />
        ) : null}
      </Modal>
    </div>
  );
});
