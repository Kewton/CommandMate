'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import type { AssistantMessage } from '@/lib/db/assistant-conversation-db';
import { copyToClipboard } from '@/lib/clipboard-utils';

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

function IconCopy() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  );
}

interface CopyButtonProps {
  text: string;
  className?: string;
  label?: string;
}

function CopyButton({ text, className = '', label = 'Copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleClick = useCallback(async () => {
    try {
      await copyToClipboard(text);
      setCopied(true);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore - copyToClipboard handles fallback
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900/70 px-2 py-0.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-800 ${className}`}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied!' : label}
    >
      {copied ? <IconCheck /> : <IconCopy />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

function SystemMessageBubble({ message }: { message: AssistantMessage }) {
  return (
    <div className="text-center text-xs font-medium uppercase tracking-[0.14em] text-slate-400">
      <span className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1">
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusText = message.deliveryStatus
    ? message.deliveryStatus === 'pending'
      ? 'Sending'
      : message.deliveryStatus === 'failed'
        ? 'Failed'
        : 'Sent'
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
      setError(err instanceof Error ? err.message : 'Failed to resubmit message');
    } finally {
      setSaving(false);
    }
  }, [draft, message, onEdit, saving]);

  return (
    <div className="group ml-auto max-w-[88%] rounded-2xl border border-cyan-500/40 bg-cyan-500/12 px-4 py-3 text-cyan-50 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.12em] text-slate-400">
        <span>You</span>
        <span>{formatTimestamp(message.timestamp)}</span>
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            className="w-full resize-y rounded border border-slate-600 bg-slate-950/70 p-2 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.max(3, Math.min(12, draft.split('\n').length + 1))}
            disabled={saving}
            data-testid="assistant-edit-textarea"
          />
          {error && <p className="text-[11px] text-red-300">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="rounded border border-slate-700 bg-slate-900/70 px-3 py-1 text-[11px] text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !draft.trim()}
              className="rounded bg-cyan-500 px-3 py-1 text-[11px] font-medium text-slate-950 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-300"
              data-testid="assistant-edit-save"
            >
              {saving ? 'Resending...' : 'Save & Resend'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span
              className={`text-[11px] font-medium ${
                message.deliveryStatus === 'failed' ? 'text-red-300' : 'text-slate-400'
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
                  className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900/70 px-2 py-0.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-800"
                  aria-label="Edit message"
                  data-testid="assistant-edit-button"
                  title="Edit and resend"
                >
                  <IconPencil />
                  <span>Edit</span>
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
    <div className="group mr-auto max-w-[88%] rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.12em] text-slate-400">
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
      return 'Assistant is working...';
    }

    return 'Select a repository and click Start to open an assistant session.';
  }, [messages, sessionActive]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 overflow-y-scroll rounded-xl border border-slate-700 bg-slate-950/70 p-3"
      style={{ scrollbarGutter: 'stable' }}
      onScroll={(event) => {
        const element = event.currentTarget;
        const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
        shouldStickToBottomRef.current = distanceFromBottom < 48;
      }}
      data-testid="assistant-message-list"
    >
      {messages.length === 0 && !waitingForResponse ? (
        <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-slate-300">
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
              className="mr-auto flex max-w-[88%] items-center gap-3 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 shadow-sm"
              data-testid="assistant-waiting-indicator"
              aria-live="polite"
            >
              <svg
                className="h-4 w-4 animate-spin text-cyan-400"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span className="text-sm text-slate-200">
                {assistantLabel} is thinking...
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
