/**
 * SimpleMessageInput Component
 *
 * Issue #600: UX refresh - Lightweight message input for Review screen.
 * Uses useSendMessage() for shared send logic [DR1-001].
 *
 * Security [DR4-004]: No dangerouslySetInnerHTML.
 * Input is plain text only. React default escaping handles XSS prevention.
 * Command length is validated by the terminal API (MAX_COMMAND_LENGTH = 10000).
 */

'use client';

import React, { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Input } from '@/components/ui';
import { useSendMessage } from '@/hooks/useSendMessage';

export interface SimpleMessageInputProps {
  /** Worktree ID to send message to */
  worktreeId: string;
  /** CLI tool identifier */
  cliToolId: string;
}

/**
 * Lightweight text input + send button for inline replies.
 * onSuccess clears the input text; no other side effects.
 */
export function SimpleMessageInput({ worktreeId, cliToolId }: SimpleMessageInputProps) {
  const t = useTranslations('common');
  const [text, setText] = useState('');

  const onSuccess = useCallback(() => {
    setText('');
  }, []);

  const { send, isSending } = useSendMessage({
    worktreeId,
    cliToolId,
    onSuccess,
  });

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    send(trimmed);
  }, [text, send]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="flex items-center gap-2">
      <Input
        type="text"
        inputSize="sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('sendMessagePlaceholder')}
        disabled={isSending}
        className="w-auto flex-1"
      />
      <Button
        variant="primary"
        size="sm"
        onClick={handleSend}
        disabled={isSending || !text.trim()}
        aria-label={t('send')}
        className="shrink-0"
      >
        {isSending ? t('sending') : t('send')}
      </Button>
    </div>
  );
}
