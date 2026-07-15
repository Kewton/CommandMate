/**
 * TimerDetailModal Component
 * Issue #1107: Timer履歴の詳細モーダル表示と失敗理由の記録
 *
 * Opened by clicking a history row in TimerPane. Shows the full instruction
 * message (no 60-char truncation), the target instance, delay / scheduled time,
 * created / sent timestamps, status, and — for `failed` timers — the persisted
 * failure reason (`error`). Mirrors ExecutionLogsView's failure detail on the
 * Schedule side; the `error` string is shown verbatim.
 *
 * PC = `@/components/ui/Modal`, mobile = `FullScreenModal` (via `useIsMobile()`),
 * matching TimerEditDialog so the history detail has no mobile regression.
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { FullScreenModal } from '@/components/common/FullScreenModal';
import { useIsMobile } from '@/hooks/useIsMobile';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { formatDelayLabel } from './timer-format';

// =============================================================================
// Types
// =============================================================================

/** Timer row shape shared with TimerPane's list (Issue #1107 adds `error`). */
export interface TimerItem {
  id: string;
  cliToolId: string;
  /** Target agent instance (Issue #942). Legacy rows fall back to cliToolId. */
  instanceId: string;
  message: string;
  delayMs: number;
  scheduledSendTime: number;
  status: string;
  createdAt: number;
  sentAt: number | null;
  /** Failure reason for `failed` timers (Issue #1107). NULL otherwise. */
  error: string | null;
}

export interface TimerDetailModalProps {
  /** Selected timer to show; when null the modal is closed. */
  timer: TimerItem | null;
  /** Resolved agent roster, used to render the instance alias. */
  instances: AgentInstance[];
  onClose: () => void;
}

// =============================================================================
// Helpers
// =============================================================================

function getStatusColor(status: string): string {
  switch (status) {
    case 'pending': return 'text-info';
    case 'sending': return 'text-warning-foreground';
    case 'sent': return 'text-success-foreground';
    case 'failed': return 'text-danger-foreground';
    case 'cancelled': return 'text-muted-foreground';
    case 'no_session': return 'text-warning-foreground';
    default: return 'text-muted-foreground';
  }
}

/** Format a unix-millis timestamp using the viewer's locale. */
function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

// =============================================================================
// Component
// =============================================================================

export function TimerDetailModal({ timer, instances, onClose }: TimerDetailModalProps) {
  const t = useTranslations('schedule');
  const isMobile = useIsMobile();

  if (!timer) return null;

  const instanceLabel =
    instances.find((inst) => inst.id === timer.instanceId)?.alias ?? timer.cliToolId;

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <div className="text-xs font-semibold text-muted-foreground mb-0.5">{label}</div>
      <div className="text-sm text-foreground break-words">{children}</div>
    </div>
  );

  const body = (
    <div className="flex flex-col gap-3" data-testid="timer-detail-body">
      {/* Full instruction message (no truncation) */}
      <div>
        <div className="text-xs font-semibold text-muted-foreground mb-1">{t('timer.message')}</div>
        <pre
          data-testid="timer-detail-message"
          className="text-sm whitespace-pre-wrap break-words font-mono text-foreground bg-muted rounded p-2 max-h-60 overflow-y-auto"
        >
          {timer.message}
        </pre>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('timer.agent')}>
          <span className="text-accent-600 dark:text-accent-400 font-medium">{instanceLabel}</span>
        </Field>
        <Field label={t('timer.statusLabel')}>
          <span className={getStatusColor(timer.status)}>{t(`timer.status.${timer.status}`)}</span>
        </Field>
        <Field label={t('timer.delay')}>{formatDelayLabel(timer.delayMs)}</Field>
        <Field label={t('timer.scheduledTime')}>{formatTimestamp(timer.scheduledSendTime)}</Field>
        <Field label={t('timer.createdTime')}>{formatTimestamp(timer.createdAt)}</Field>
        {timer.sentAt !== null && (
          <Field label={t('timer.sentTime')}>{formatTimestamp(timer.sentAt)}</Field>
        )}
      </div>

      {/* Failure reason: only for failed timers that recorded one. */}
      {timer.status === 'failed' && timer.error && (
        <div>
          <div className="text-xs font-semibold text-danger-foreground mb-1">
            {t('timer.failureReason')}
          </div>
          <pre
            data-testid="timer-detail-error"
            className="text-xs whitespace-pre-wrap break-words font-mono text-danger-foreground bg-danger-subtle rounded p-2 max-h-40 overflow-y-auto"
          >
            {timer.error}
          </pre>
        </div>
      )}
    </div>
  );

  const footer = (
    <div className="flex items-center justify-end">
      <button
        type="button"
        data-testid="timer-detail-close"
        onClick={onClose}
        className="px-4 py-2 text-sm font-medium text-foreground hover:bg-muted rounded-md transition-colors"
      >
        {t('timer.close')}
      </button>
    </div>
  );

  const title = t('timer.detailTitle');

  if (isMobile) {
    return (
      <FullScreenModal isOpen title={title} onClose={onClose} footer={footer}>
        {body}
      </FullScreenModal>
    );
  }

  return (
    <Modal isOpen title={title} onClose={onClose} size="md">
      <div className="flex flex-col gap-4">
        {body}
        <div className="pt-2 border-t border-border">{footer}</div>
      </div>
    </Modal>
  );
}

export default TimerDetailModal;
