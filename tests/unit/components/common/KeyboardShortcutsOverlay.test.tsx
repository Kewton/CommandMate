/**
 * Unit tests for KeyboardShortcutsOverlay (Issue #1130).
 *
 * Covers: opening via `?`, the typing-context guard (input / textarea /
 * contentEditable), the IME-composition guard, closing via Escape, rendering
 * every registered shortcut grouped by scope, and standing down while the
 * command palette is open.
 *
 * next-intl is globally mocked (tests/setup.ts) to echo the full key, so
 * assertions reference keys like `keyboardShortcuts.title`.
 *
 * @vitest-environment jsdom
 */

import React, { useEffect } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { KeyboardShortcutsOverlay } from '@/components/common/KeyboardShortcutsOverlay';
import {
  KeyboardShortcutsProvider,
} from '@/contexts/KeyboardShortcutsContext';
import {
  CommandPaletteProvider,
  useCommandPalette,
} from '@/contexts/CommandPaletteContext';
import { KEYBOARD_SHORTCUTS } from '@/config/keyboard-shortcuts';

afterEach(() => cleanup());

/** Render the overlay inside both providers (palette guard reads its context). */
function renderOverlay(extra?: React.ReactNode) {
  return render(
    <CommandPaletteProvider>
      <KeyboardShortcutsProvider>
        {extra}
        <KeyboardShortcutsOverlay />
      </KeyboardShortcutsProvider>
    </CommandPaletteProvider>,
  );
}

/** Dispatch a `?` keydown on the given target (defaults to document.body). */
function pressHelpKey(
  target: Element | Document | Window = document.body,
  init: KeyboardEventInit = {},
) {
  act(() => {
    fireEvent.keyDown(target, { key: '?', ...init });
  });
}

describe('KeyboardShortcutsOverlay (Issue #1130)', () => {
  it('is closed initially and opens on `?`', () => {
    renderOverlay();
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();

    pressHelpKey();
    expect(screen.getByTestId('keyboard-shortcuts-overlay')).toBeInTheDocument();
    expect(screen.getByText('keyboardShortcuts.title')).toBeInTheDocument();
  });

  it('does NOT open while typing in an input / textarea / contentEditable', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    // jsdom does not derive isContentEditable from the attribute; set it like
    // the shared isTypingTarget test does.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    document.body.append(input, textarea, editable);

    renderOverlay();
    pressHelpKey(input);
    pressHelpKey(textarea);
    pressHelpKey(editable);
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();

    input.remove();
    textarea.remove();
    editable.remove();
  });

  it('does NOT open during IME composition', () => {
    renderOverlay();
    pressHelpKey(document.body, { isComposing: true });
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();

    // A real (non-composing) `?` still opens it.
    pressHelpKey();
    expect(screen.getByTestId('keyboard-shortcuts-overlay')).toBeInTheDocument();
  });

  it('does NOT open while the command palette is open', () => {
    function OpenPalette() {
      const { setOpen } = useCommandPalette();
      useEffect(() => setOpen(true), [setOpen]);
      return null;
    }
    renderOverlay(<OpenPalette />);
    pressHelpKey();
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull();
  });

  it('closes on Escape', async () => {
    renderOverlay();
    pressHelpKey();
    expect(screen.getByTestId('keyboard-shortcuts-overlay')).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    await waitFor(() =>
      expect(screen.queryByTestId('keyboard-shortcuts-overlay')).toBeNull(),
    );
  });

  it('renders every registered shortcut grouped by scope', () => {
    renderOverlay();
    pressHelpKey();

    for (const shortcut of KEYBOARD_SHORTCUTS) {
      expect(screen.getByTestId(`keyboard-shortcut-${shortcut.id}`)).toBeInTheDocument();
      expect(
        screen.getByText(`keyboardShortcuts.shortcuts.${shortcut.id}`),
      ).toBeInTheDocument();
    }
    // Scope headings for the non-empty scopes.
    expect(screen.getByTestId('keyboard-shortcuts-scope-global')).toBeInTheDocument();
    expect(screen.getByTestId('keyboard-shortcuts-scope-terminal')).toBeInTheDocument();
    expect(screen.getByTestId('keyboard-shortcuts-scope-composer')).toBeInTheDocument();
  });
});
