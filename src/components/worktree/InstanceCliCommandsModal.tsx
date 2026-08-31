/**
 * InstanceCliCommandsModal (Issue #2120)
 *
 * The four CommandMate CLI commands that address ONE agent instance —
 * `send` / `wait` / `capture` / `respond` — rendered ready to paste, with a copy
 * button each.
 *
 * ## Where each half of a command comes from
 *
 * Nothing here is composed from what the browser already knows, and that is the
 * point of the component:
 *
 *   - the `--instance` value comes from
 *     `GET /api/worktrees/:id/resolve-target`. The roster row is what the panel
 *     was OPENED from, not what it prints. Issue #1925: the CLI once carried its
 *     own copy of the precedence rules, lost the primary-anchor stage, and
 *     resolved `--instance codex` to the worktree default on the client and to
 *     codex on the server — two authorities, two answers, one tmux session name
 *     built from whichever ran. A GUI that re-derived the target would be the
 *     third.
 *   - the binary name and the `CM_PORT=` prefix come from
 *     `GET /api/worktrees/:id/cli-reference`, because `CM_LAUNCHED_BY` and the
 *     listening port exist only in the server process.
 *
 * A read that fails therefore shows an error and NO commands. Falling back to
 * the roster id would put a plausible, unverified command on the clipboard,
 * which is the failure this whole design is arranged to prevent.
 */

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Check, AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import {
  buildInstanceCliCommands,
  INSTANCE_CLI_COMMAND_IDS,
  type InstanceCliCommandId,
} from '@/lib/cli/command-reference';
import { getCliToolDisplayName, type AgentInstance } from '@/lib/cli-tools/types';
import type { CliReferenceResponse } from '@/app/api/worktrees/[id]/cli-reference/route';
import type { ResolveTargetResponse } from '@/app/api/worktrees/[id]/resolve-target/route';

export interface InstanceCliCommandsModalProps {
  /** Worktree the commands address */
  worktreeId: string;
  /** Roster row the panel was opened from (its id is the *request*, not the answer) */
  instance: AgentInstance;
  isOpen: boolean;
  onClose: () => void;
}

/** The three warnings this panel is required to carry, in display order. */
const NOTE_KEYS = ['noteInstanceFlag', 'noteWaitOnPrompt', 'noteRespondNumber'] as const;

export function InstanceCliCommandsModal({
  worktreeId,
  instance,
  isOpen,
  onClose,
}: InstanceCliCommandsModalProps) {
  const t = useTranslations('worktree');

  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reference, setReference] = useState<CliReferenceResponse | null>(null);
  const [target, setTarget] = useState<ResolveTargetResponse | null>(null);
  const [copiedId, setCopiedId] = useState<InstanceCliCommandId | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  // Bumped by the retry button; the effect below keys off it so a failed read is
  // recoverable without closing and reopening the panel.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Reading only while open is what keeps #2054's "a roster of claude and
    // codex panes issues ZERO requests" true of this Issue as well: the icon
    // that opens this panel is on every row, and a read on mount would be one
    // request per instance on every worktree in the install.
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setCopiedId(null);
    setCopyFailed(false);

    const read = async (): Promise<void> => {
      try {
        const [referenceResponse, targetResponse] = await Promise.all([
          fetch(`/api/worktrees/${worktreeId}/cli-reference`),
          fetch(
            `/api/worktrees/${worktreeId}/resolve-target?instance=${encodeURIComponent(instance.id)}`
          ),
        ]);
        if (cancelled) return;
        if (!referenceResponse.ok || !targetResponse.ok) {
          setLoadFailed(true);
          return;
        }
        const [referenceBody, targetBody] = (await Promise.all([
          referenceResponse.json(),
          targetResponse.json(),
        ])) as [CliReferenceResponse, ResolveTargetResponse];
        if (cancelled) return;
        setReference(referenceBody);
        setTarget(targetBody);
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void read();
    return () => {
      cancelled = true;
    };
  }, [isOpen, worktreeId, instance.id, attempt]);

  const commands =
    reference && target
      ? buildInstanceCliCommands({
          binary: reference.binary,
          worktreeId: reference.worktreeId,
          instanceId: target.instanceId,
          portPrefix: reference.portPrefix,
          messagePlaceholder: t('cliCommands.messagePlaceholder'),
        })
      : null;

  const onCopy = useCallback(async (id: InstanceCliCommandId, command: string) => {
    try {
      // Same shape as the opencode share-link copy: `navigator.clipboard` is
      // simply absent outside a secure context, which is how CommandMate is
      // reached from a phone on the LAN over plain HTTP. Silence there reads as
      // "copied" — the icon does not change and nothing says why — so the
      // failure gets its own line telling the operator to select the command,
      // which is on screen and selectable, and copy it by hand.
      await navigator.clipboard.writeText(command);
      setCopiedId(id);
      setCopyFailed(false);
    } catch (error) {
      console.error('[InstanceCliCommandsModal] clipboard write failed:', error);
      setCopiedId(null);
      setCopyFailed(true);
    }
  }, []);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      title={t('cliCommands.title', { alias: instance.alias })}
    >
      <div className="space-y-4" data-testid={`cli-commands-panel-${instance.id}`}>
        {loading && (
          <div
            data-testid="cli-commands-loading"
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <Spinner size="xs" variant="muted" />
            {t('cliCommands.loading')}
          </div>
        )}

        {loadFailed && (
          <div className="space-y-2">
            <p data-testid="cli-commands-error" className="text-xs text-danger-foreground">
              {t('cliCommands.loadError')}
            </p>
            <button
              type="button"
              data-testid="cli-commands-retry"
              onClick={() => setAttempt((n) => n + 1)}
              className="text-xs font-medium px-2 py-1 rounded-md border border-input text-foreground hover:bg-muted"
            >
              {t('cliCommands.retry')}
            </button>
          </div>
        )}

        {commands && target && reference && (
          <>
            {/* What the server said the target is. Printed even when it agrees
                with the row, because the value in the command is the server's
                answer and the panel should not look like it is quoting itself. */}
            <p
              data-testid="cli-commands-target"
              className="text-xs text-muted-foreground break-words"
            >
              {t('cliCommands.target', {
                instance: target.instanceId,
                tool: getCliToolDisplayName(target.cliToolId),
                stage: t(`cliCommands.resolvedBy.${target.resolvedBy}`),
              })}
            </p>

            {/* A contradiction is surfaced, never hidden: `resolve-target` is
                read-only and answers 200 with the roster's verdict and the
                contradiction attached (DR3-015), so the only way the operator
                learns the roster disagrees with the request is here. */}
            {target.conflict && (
              <p
                data-testid="cli-commands-conflict"
                className="flex items-start gap-1 text-xs text-warning"
              >
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                <span>
                  {t('cliCommands.conflict', {
                    instance: target.conflict.instanceId,
                    roster: getCliToolDisplayName(target.conflict.rosterCliTool),
                    requested: getCliToolDisplayName(target.conflict.requestedCliTool),
                  })}
                </span>
              </p>
            )}

            <ul className="space-y-3">
              {INSTANCE_CLI_COMMAND_IDS.map((id) => (
                <li key={id} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground">
                      {t(`cliCommands.commandLabel.${id}`)}
                    </span>
                    <button
                      type="button"
                      data-testid={`cli-commands-copy-${id}`}
                      aria-label={t('cliCommands.copy')}
                      title={t('cliCommands.copy')}
                      onClick={() => void onCopy(id, commands[id])}
                      className="flex items-center gap-1 shrink-0 text-xs px-2 py-1 rounded-md border border-input text-muted-foreground hover:text-foreground hover:bg-muted"
                    >
                      {copiedId === id ? (
                        <Check className="w-3 h-3" aria-hidden="true" />
                      ) : (
                        <Copy className="w-3 h-3" aria-hidden="true" />
                      )}
                      {copiedId === id ? t('cliCommands.copied') : t('cliCommands.copy')}
                    </button>
                  </div>
                  <code
                    data-testid={`cli-commands-command-${id}`}
                    className="block whitespace-pre-wrap break-all rounded-md bg-terminal-surface px-2 py-1.5 font-mono text-xs text-terminal-foreground"
                  >
                    {commands[id]}
                  </code>
                  <p className="text-xs text-muted-foreground">
                    {t(`cliCommands.commandDescription.${id}`)}
                  </p>
                </li>
              ))}
            </ul>

            {copyFailed && (
              <p data-testid="cli-commands-copy-error" className="text-xs text-danger-foreground">
                {t('cliCommands.copyFailed')}
              </p>
            )}

            {reference.portPrefix !== null && (
              <p data-testid="cli-commands-port-hint" className="text-xs text-muted-foreground">
                {t('cliCommands.portHint', { port: reference.portPrefix })}
              </p>
            )}

            <div className="rounded-md border border-border bg-surface-2 p-3">
              <p className="text-xs font-semibold text-foreground">
                {t('cliCommands.notesTitle')}
              </p>
              <ul className="mt-1 space-y-1">
                {NOTE_KEYS.map((noteKey) => (
                  <li
                    key={noteKey}
                    data-testid={`cli-commands-${noteKey}`}
                    className="text-xs text-muted-foreground"
                  >
                    {t(`cliCommands.${noteKey}`)}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

export default InstanceCliCommandsModal;
