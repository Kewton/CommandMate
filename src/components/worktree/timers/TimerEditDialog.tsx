/**
 * TimerEditDialog Component
 * Issue #945: Timer入力を「+ Create Timer」ボタン+ポップアップ方式に変更（Schedule と統一）
 *
 * Desktop/Mobile shared dialog for creating a delayed-message timer. It owns the
 * form state (agent instance / message / delay) and the registration request
 * (`POST /api/worktrees/:id/timers`) — TimerPane keeps the list, polling and
 * fetch. Mirrors ScheduleEditDialog's PC=`Modal` / mobile=`FullScreenModal`
 * split. The Timer form is flat (3 inputs) so no accordion is used.
 *
 * On a successful register:
 * - normal success → call onSaved() (refresh the list) then onClose().
 * - `session_not_running` warning → keep the dialog open and surface the
 *   warning inside it (the timer IS registered), still calling onSaved() so the
 *   list updates. This preserves the pre-#945 "warning shown after register"
 *   behavior now that the form lives in a modal.
 */

'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { FullScreenModal } from '@/components/common/FullScreenModal';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  TIMER_DELAYS,
  MAX_TIMER_MESSAGE_LENGTH,
} from '@/config/timer-constants';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { CLI_TOOL_IDS, agentInstancesFromSelectedAgents } from '@/lib/cli-tools/types';
import { formatDelayLabel } from './timer-format';

// =============================================================================
// Types
// =============================================================================

export interface TimerEditDialogProps {
  isOpen: boolean;
  worktreeId: string;
  /**
   * Registered agent instances (Issue #942). Drives the agent selector so the
   * timer targets a specific instance session. Falls back to the primary
   * instance of every CLI tool when omitted/empty (legacy behavior).
   */
  instances?: AgentInstance[];
  onClose: () => void;
  /** Called after a successful register so the parent can refresh its list. */
  onSaved: () => void;
}

const INPUT_CLASS =
  'w-full px-3 py-2 text-sm border border-input rounded-md bg-surface dark:bg-surface-2 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

// =============================================================================
// Component
// =============================================================================

export function TimerEditDialog({
  isOpen,
  worktreeId,
  instances,
  onClose,
  onSaved,
}: TimerEditDialogProps) {
  const t = useTranslations('schedule');
  const isMobile = useIsMobile();

  // Resolve the agent roster: explicit instances when configured, otherwise the
  // primary instance of every CLI tool (legacy behavior, byte-for-byte compat).
  const resolvedInstances = useMemo<AgentInstance[]>(
    () => (instances && instances.length > 0
      ? instances
      : agentInstancesFromSelectedAgents([...CLI_TOOL_IDS])),
    [instances]
  );

  const [message, setMessage] = useState('');
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>(
    () => resolvedInstances[0]?.id ?? CLI_TOOL_IDS[0]
  );
  const [selectedDelay, setSelectedDelay] = useState(TIMER_DELAYS[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  // Reset the form to a clean state whenever the dialog is (re)opened.
  useEffect(() => {
    if (!isOpen) return;
    setMessage('');
    setSelectedDelay(TIMER_DELAYS[0]);
    setWarning(null);
    setIsSubmitting(false);
    setSelectedInstanceId(resolvedInstances[0]?.id ?? CLI_TOOL_IDS[0]);
  }, [isOpen, resolvedInstances]);

  // Keep the selection valid when the instance roster changes (e.g. an instance
  // is renamed/removed in the Agents panel while the dialog is open).
  useEffect(() => {
    if (!resolvedInstances.some((inst) => inst.id === selectedInstanceId)) {
      setSelectedInstanceId(resolvedInstances[0]?.id ?? CLI_TOOL_IDS[0]);
    }
  }, [resolvedInstances, selectedInstanceId]);

  const canRegister = message.trim().length > 0 && !isSubmitting;

  const handleRegister = useCallback(async () => {
    if (!message.trim() || isSubmitting) return;

    const selected = resolvedInstances.find((inst) => inst.id === selectedInstanceId);
    if (!selected) return;

    setWarning(null);
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/worktrees/${worktreeId}/timers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cliToolId: selected.cliTool,
          instanceId: selected.id,
          message: message.trim(),
          delayMs: selectedDelay,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        // Refresh the parent list regardless — the timer was created.
        onSaved();
        if (data.warning === 'session_not_running') {
          // Keep the dialog open and surface the warning; clear the message so
          // the user can register another without retyping.
          setWarning('session_not_running');
          setMessage('');
        } else {
          onClose();
        }
      }
    } catch {
      // Error handled silently (mirrors the pre-#945 inline-form behavior).
    } finally {
      setIsSubmitting(false);
    }
  }, [
    worktreeId,
    resolvedInstances,
    selectedInstanceId,
    message,
    selectedDelay,
    isSubmitting,
    onSaved,
    onClose,
  ]);

  // ----- Shared body: flat 3-field form -----
  const body = (
    <div className="flex flex-col gap-3">
      {/* Agent instance selector (Issue #942) */}
      <div>
        <label className="block text-xs font-semibold text-foreground mb-1" htmlFor="timer-instance-select">
          {t('timer.agent')}
        </label>
        <select
          id="timer-instance-select"
          data-testid="timer-instance-select"
          value={selectedInstanceId}
          onChange={(e) => setSelectedInstanceId(e.target.value)}
          className={INPUT_CLASS}
        >
          {resolvedInstances.map((inst) => (
            <option key={inst.id} value={inst.id}>
              {inst.alias}
            </option>
          ))}
        </select>
      </div>

      {/* Message input */}
      <div>
        <label className="block text-xs font-semibold text-foreground mb-1" htmlFor="timer-message-input">
          {t('timer.message')}
        </label>
        <textarea
          id="timer-message-input"
          data-testid="timer-message-input"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t('timer.message')}
          maxLength={MAX_TIMER_MESSAGE_LENGTH}
          rows={3}
          className={`${INPUT_CLASS} resize-none`}
        />
      </div>

      {/* Delay selector */}
      <div>
        <label className="block text-xs font-semibold text-foreground mb-1" htmlFor="timer-delay-select">
          {t('timer.delay')}
        </label>
        <select
          id="timer-delay-select"
          data-testid="timer-delay-select"
          value={selectedDelay}
          onChange={(e) => setSelectedDelay(Number(e.target.value))}
          className={INPUT_CLASS}
        >
          {TIMER_DELAYS.map((delay) => (
            <option key={delay} value={delay}>
              {formatDelayLabel(delay)}
            </option>
          ))}
        </select>
      </div>

      {warning === 'session_not_running' && (
        <div
          data-testid="timer-session-warning"
          className="text-xs p-2 rounded bg-warning-subtle text-warning-foreground"
        >
          {t('timer.sessionWarning')}
        </div>
      )}
    </div>
  );

  // ----- Shared footer buttons -----
  const footerButtons = (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={onClose}
        className="px-4 py-2 text-sm font-medium text-foreground hover:bg-muted rounded-md transition-colors"
      >
        {t('timer.close')}
      </button>
      <button
        type="button"
        data-testid="timer-register-button"
        onClick={() => void handleRegister()}
        disabled={!canRegister}
        className="px-4 py-2 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors"
      >
        {t('timer.register')}
      </button>
    </div>
  );

  const title = t('timer.titleCreate');

  // Mobile: full-screen modal with a sticky footer (mirrors ScheduleEditDialog).
  if (isMobile) {
    return (
      <FullScreenModal isOpen={isOpen} onClose={onClose} title={title} footer={footerButtons}>
        {body}
      </FullScreenModal>
    );
  }

  // Desktop: centered modal with the footer below a divider.
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
      <div className="flex flex-col gap-4">
        {body}
        <div className="pt-2 border-t border-border">{footerButtons}</div>
      </div>
    </Modal>
  );
}

export default TimerEditDialog;
