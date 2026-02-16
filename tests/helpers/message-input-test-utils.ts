/**
 * Shared test utilities for MessageInput component tests.
 *
 * Centralizes mock data, default props, and common user-interaction
 * flows used across MessageInput unit tests and acceptance tests.
 * Follows the same DRY pattern as tests/helpers/prompt-type-guards.ts.
 */

import { vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import type { CLIToolType } from '@/lib/cli-tools/types';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

/**
 * Standard mock command groups used by SlashCommandSelector in tests.
 */
export const mockCommandGroups = [
  {
    category: 'standard-session' as const,
    label: 'Standard (Session)',
    commands: [
      {
        name: 'test-command',
        description: 'A test command',
        category: 'standard-session' as const,
        filePath: '/test',
      },
    ],
  },
];

/**
 * Default props for rendering MessageInput in tests.
 */
export function createDefaultProps(overrides?: {
  worktreeId?: string;
  cliToolId?: CLIToolType;
  onMessageSent?: (cliToolId: CLIToolType) => void;
  isSessionRunning?: boolean;
}) {
  return {
    worktreeId: overrides?.worktreeId ?? 'test-worktree',
    onMessageSent: overrides?.onMessageSent ?? vi.fn<(cliToolId: CLIToolType) => void>(),
    cliToolId: overrides?.cliToolId ?? ('claude' as const),
    ...(overrides?.isSessionRunning !== undefined
      ? { isSessionRunning: overrides.isSessionRunning }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// DOM query helpers
// ---------------------------------------------------------------------------

/**
 * Get the textarea element used for message input.
 */
export function getTextarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Type your message/i) as HTMLTextAreaElement;
}

/**
 * Get the send button element.
 */
export function getSendButton(): HTMLElement {
  return screen.getByRole('button', { name: /send message/i });
}

/**
 * Query the desktop command selector (listbox).
 * Returns the element if present, or null.
 */
export function queryDesktopSelector(): HTMLElement | null {
  return screen.queryByRole('listbox');
}

/**
 * Query the mobile bottom sheet selector.
 * Returns the element if present, or null.
 */
export function queryMobileSheet(): HTMLElement | null {
  return screen.queryByTestId('slash-command-bottom-sheet');
}

// ---------------------------------------------------------------------------
// User interaction helpers
// ---------------------------------------------------------------------------

/**
 * Type a value into the message textarea.
 */
export function typeMessage(value: string): void {
  fireEvent.change(getTextarea(), { target: { value } });
}

/**
 * Open the slash command selector by typing '/' in the textarea.
 */
export function openSelector(): void {
  typeMessage('/');
}

/**
 * Enter free input mode: type '/' to open the selector, then click
 * the "free input" button.  Returns after the selector has been closed.
 */
export function enterFreeInputMode(): void {
  openSelector();
  const freeInputButton = screen.getByTestId('free-input-button');
  fireEvent.click(freeInputButton);
}

/**
 * Press a key in the textarea.
 */
export function pressKey(
  key: string,
  options?: { shiftKey?: boolean; nativeEvent?: Record<string, unknown> },
): void {
  fireEvent.keyDown(getTextarea(), {
    key,
    shiftKey: options?.shiftKey ?? false,
    ...(options?.nativeEvent ? { nativeEvent: options.nativeEvent } : {}),
  });
}

/**
 * Press Enter in the textarea (desktop submit shortcut).
 */
export function pressEnter(): void {
  pressKey('Enter', { shiftKey: false });
}

/**
 * Press Escape in the textarea.
 */
export function pressEscape(): void {
  pressKey('Escape');
}

/**
 * Click the mobile command button (data-testid="mobile-command-button").
 */
export function clickMobileCommandButton(): void {
  const mobileButton = screen.getByTestId('mobile-command-button');
  fireEvent.click(mobileButton);
}

/**
 * Simulate an IME composition session (start -> end) on the textarea.
 */
export function simulateIMEComposition(): void {
  const textarea = getTextarea();
  fireEvent.compositionStart(textarea);
  fireEvent.compositionEnd(textarea);
}

/**
 * Small delay helper for tests that need to wait for async operations.
 * @param ms - milliseconds to wait (default 50)
 */
export function delay(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
