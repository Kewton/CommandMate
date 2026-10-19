/**
 * The composer's send button, moved out of MessageInput (Issue #3606).
 */

'use client';

import React from 'react';
import { Button, Spinner } from '@/components/ui';

export interface ComposerSendButtonProps {
  message: string;
  hasAttachment: boolean;
  sending: boolean;
  ariaLabel: string;
}

export function ComposerSendButton({ message, hasAttachment, sending, ariaLabel }: ComposerSendButtonProps): React.ReactElement {
  return (
    <Button
      variant="ghost"
      type="submit"
      data-testid="send-message-button"
      data-can-send={String((!!message.trim() || hasAttachment) && !sending)}
      disabled={(!message.trim() && !hasAttachment) || sending}
      className={`flex-shrink-0 p-2 rounded-full transition-colors disabled:hover:bg-transparent ${
        (!!message.trim() || hasAttachment) && !sending
          ? 'bg-accent-600 text-white hover:bg-accent-700 shadow-sm'
          : 'text-muted-foreground/50'
      }`}
      aria-label={ariaLabel}
    >
      {sending ? (
        <Spinner size="md" />
      ) : (
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
        </svg>
      )}
    </Button>
  );
}
