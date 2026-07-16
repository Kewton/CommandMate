'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { AssistantMessage } from '@/lib/db/assistant-conversation-db';
import { CopyButton } from '@/components/common/CopyButton';
import { Spinner } from '@/components/ui/Spinner';

interface AssistantMessageListProps {
  messages: AssistantMessage[];
  assistantLabel: string;
  sessionActive: boolean;
  waitingForResponse?: boolean;
  canEdit?: boolean;
  onEditMessage?: (message: AssistantMessage, newContent: string) => Promise<void>;
}

function formatTimestamp(timestamp: Date): string {
  return timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function IconPencil() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  );
}

function SystemMessageBubble({ message }: { message: AssistantMessage }) {
  return (
    <div className="text-center text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
      <span className="rounded-full border border-border bg-surface-2 px-3 py-1">
        {message.content}
      </span>
    </div>
  );
}

interface UserMessageBubbleProps {
  message: AssistantMessage;
  canEdit: boolean;
  onEdit?: (message: AssistantMessage, newContent: string) => Promise<void>;
}

function UserMessageBubble({ message, canEdit, onEdit }: UserMessageBubbleProps) {
  const t = useTranslations('home');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusText = message.deliveryStatus
    ? message.deliveryStatus === 'pending'
      ? t('assistant.message.sending')
      : message.deliveryStatus === 'failed'
        ? t('assistant.message.failed')
        : t('assistant.message.sent')
    : null;

  const handleStartEdit = useCallback(() => {
    setDraft(message.content);
    setError(null);
    setEditing(true);
  }, [message.content]);

  const handleCancel = useCallback(() => {
    setEditing(false);
    setError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!onEdit || saving) {
      return;
    }
    const trimmed = draft.trim();
    if (!trimmed || trimmed === message.content.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onEdit(message, trimmed);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('assistant.errors.resubmitMessage'));
    } finally {
      setSaving(false);
    }
  }, [draft, message, onEdit, saving, t]);

  return (
    <div className="group ml-auto max-w-[88%] rounded-2xl border border-accent-500/40 bg-accent-500/10 px-4 py-3 text-foreground shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
        <span>{t('assistant.message.you')}</span>
        <span>{formatTimestamp(message.timestamp)}</span>
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            className="w-full resize-y rounded border border-input bg-surface p-2 text-sm text-foreground focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-ring"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.max(3, Math.min(12, draft.split('\n').length + 1))}
            disabled={saving}
            data-testid="assistant-edit-textarea"
          />
          {error && <p className="text-[11px] text-danger-foreground">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="rounded border border-border bg-surface px-3 py-1 text-[11px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {t('assistant.message.cancel')}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !draft.trim()}
              className="rounded bg-accent-600 px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent-700 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              data-testid="assistant-edit-save"
            >
              {saving ? t('assistant.message.resending') : t('assistant.message.saveAndResend')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span
              className={`text-[11px] font-medium ${
                message.deliveryStatus === 'failed'
                  ? 'text-danger-foreground'
                  : 'text-muted-foreground'
              }`}
            >
              {statusText ?? ''}
            </span>
            <div className="flex items-center gap-1.5 opacity-60 transition-opacity group-hover:opacity-100">
              <CopyButton text={message.content} />
              {canEdit && onEdit && (
                <button
                  type="button"
                  onClick={handleStartEdit}
                  className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
                  aria-label={t('assistant.message.editMessage')}
                  data-testid="assistant-edit-button"
                  title={t('assistant.message.editAndResend')}
                >
                  <IconPencil />
                  <span>{t('assistant.message.edit')}</span>
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AssistantMessageBubble({
  message,
  assistantLabel,
}: {
  message: AssistantMessage;
  assistantLabel: string;
}) {
  return (
    <div className="group mr-auto max-w-[88%] rounded-2xl border border-border bg-surface px-4 py-3 text-foreground shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
        <span>{assistantLabel}</span>
        <span>{formatTimestamp(message.timestamp)}</span>
      </div>
      <div className="assistant-md text-sm leading-6">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSanitize, rehypeHighlight]}
        >
          {message.content}
        </ReactMarkdown>
      </div>
      <div className="mt-2 flex justify-end opacity-60 transition-opacity group-hover:opacity-100">
        <CopyButton text={message.content} />
      </div>
    </div>
  );
}

export function AssistantMessageList({
  messages,
  assistantLabel,
  sessionActive,
  waitingForResponse = false,
  canEdit = false,
  onEditMessage,
}: AssistantMessageListProps) {
  const t = useTranslations('home');
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);

  const lastMessageKey = useMemo(() => {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) {
      return `empty:${waitingForResponse ? 'waiting' : 'idle'}`;
    }

    return `${messages.length}:${lastMessage.id}:${lastMessage.deliveryStatus ?? ''}:${lastMessage.content.length}:${waitingForResponse ? 'waiting' : 'idle'}`;
  }, [messages, waitingForResponse]);

  useEffect(() => {
    if (containerRef.current && shouldStickToBottomRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lastMessageKey]);

  const emptyState = useMemo(() => {
    const lastMessage = messages[messages.length - 1];
    if (
      sessionActive &&
      lastMessage &&
      lastMessage.role === 'user' &&
      lastMessage.deliveryStatus !== 'failed'
    ) {
      return t('assistant.working');
    }

    return t('assistant.emptyState');
  }, [messages, sessionActive, t]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 overflow-y-scroll rounded-xl border border-border bg-surface-2 p-3"
      style={{ scrollbarGutter: 'stable' }}
      onScroll={(event) => {
        const element = event.currentTarget;
        const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
        shouldStickToBottomRef.current = distanceFromBottom < 48;
      }}
      data-testid="assistant-message-list"
    >
      {messages.length === 0 && !waitingForResponse ? (
        <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-muted-foreground">
          {emptyState}
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map((message) => {
            if (message.role === 'system' && message.messageType === 'session_boundary') {
              return <SystemMessageBubble key={message.id} message={message} />;
            }
            if (message.role === 'user') {
              return (
                <UserMessageBubble
                  key={message.id}
                  message={message}
                  canEdit={canEdit}
                  onEdit={onEditMessage}
                />
              );
            }
            return (
              <AssistantMessageBubble
                key={message.id}
                message={message}
                assistantLabel={assistantLabel}
              />
            );
          })}
          {waitingForResponse && (
            <div
              className="mr-auto flex max-w-[88%] items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3 shadow-sm"
              data-testid="assistant-waiting-indicator"
              aria-live="polite"
            >
              <Spinner size="sm" variant="accent" />
              <span className="text-sm text-foreground">
                {t('assistant.thinking', { label: assistantLabel })}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
