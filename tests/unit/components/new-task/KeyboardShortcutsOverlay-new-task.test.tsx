/**
 * The `?` overlay lists New task's chords (Issue #3511), next to every
 * registered one.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { KeyboardShortcutsOverlay } from '@/components/common/KeyboardShortcutsOverlay';
import { KeyboardShortcutsProvider } from '@/contexts/KeyboardShortcutsContext';
import { KEYBOARD_SHORTCUTS } from '@/config/keyboard-shortcuts';
import enShortcuts from '../../../../locales/en/keyboardShortcuts.json';
import jaShortcuts from '../../../../locales/ja/keyboardShortcuts.json';

function open() {
  render(
    <KeyboardShortcutsProvider>
      <KeyboardShortcutsOverlay />
    </KeyboardShortcutsProvider>,
  );
  fireEvent.keyDown(window, { key: '?' });
}

describe('[#3511] KeyboardShortcutsOverlay lists New task', () => {
  it('shows Mod+Shift+O and Mod+Enter under Global', () => {
    open();
    const global = screen.getByTestId('keyboard-shortcuts-scope-global');
    const row = within(global).getByTestId('keyboard-shortcut-newTask');
    expect(row).toHaveTextContent('keyboardShortcuts.shortcuts.newTask');
    expect(row).toHaveTextContent('Shift');
    expect(row).toHaveTextContent('O');
    expect(within(global).getByTestId('keyboard-shortcut-newTaskSend')).toHaveTextContent('↵');
  });

  it('still lists every registered shortcut (negative control)', () => {
    open();
    for (const shortcut of KEYBOARD_SHORTCUTS) {
      expect(screen.getByTestId(`keyboard-shortcut-${shortcut.id}`)).toBeInTheDocument();
    }
  });

  it('has a description in both locales', () => {
    for (const messages of [enShortcuts, jaShortcuts]) {
      expect(messages.shortcuts.newTask).toBeTruthy();
      expect(messages.shortcuts.newTaskSend).toBeTruthy();
    }
  });
});
