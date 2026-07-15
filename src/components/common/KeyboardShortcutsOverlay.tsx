/**
 * KeyboardShortcutsOverlay (Issue #1130)
 *
 * The `?` keyboard-shortcuts help modal. Mounted once under AppShell (next to
 * the CommandPalette). It owns the single global `?` keydown listener and reads
 * the shortcut list from the central registry (@/config/keyboard-shortcuts),
 * grouping it by scope and rendering each binding with <Kbd> caps.
 *
 * The `?` key never opens the overlay while the user is typing: it reuses the
 * command palette's shared `isTypingTarget` guard (input / textarea / select /
 * contentEditable / terminal `role="log"`) and additionally ignores IME
 * composition (`isComposing` / keyCode 229), matching the composer's flow. It
 * also stands down while the command palette is open so the two never stack.
 *
 * SSR-safe: 'use client' and platform detection runs only after mount.
 */

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Kbd } from '@/components/ui/Kbd';
import { isTypingTarget } from '@/components/common/CommandPalette';
import { useKeyboardShortcuts } from '@/contexts/KeyboardShortcutsContext';
import { useCommandPalette } from '@/contexts/CommandPaletteContext';
import {
  groupShortcutsByScope,
  isMacPlatform,
  resolveShortcutKey,
} from '@/config/keyboard-shortcuts';

/** Global keyboard-shortcuts help overlay opened by `?`. */
export function KeyboardShortcutsOverlay() {
  const { open, setOpen } = useKeyboardShortcuts();
  const { open: paletteOpen } = useCommandPalette();
  const t = useTranslations('keyboardShortcuts');

  // Resolve the platform mod symbol only after mount (SSR safety).
  const [isMac, setIsMac] = useState(false);
  useEffect(() => setIsMac(isMacPlatform()), []);

  // Mirror the latest state into refs so the stable listener reads fresh values.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const paletteOpenRef = useRef(paletteOpen);
  useEffect(() => {
    paletteOpenRef.current = paletteOpen;
  }, [paletteOpen]);

  // Single global `?` listener. Guarded against typing / IME / palette-open so
  // it never steals the keystroke from a text-entry context (Issue #1130).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '?') return;
      // IME composition: keydown fires with isComposing / keyCode 229 mid-convert.
      if (event.isComposing || event.keyCode === 229) return;
      if (isTypingTarget(event.target)) return;
      if (paletteOpenRef.current) return;
      if (openRef.current) return;
      event.preventDefault();
      setOpen(true);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpen]);

  const groups = groupShortcutsByScope();

  return (
    <Modal isOpen={open} onClose={() => setOpen(false)} title={t('title')} size="md">
      <div data-testid="keyboard-shortcuts-overlay" className="space-y-6">
        {groups.map(({ scope, shortcuts }) => (
          <section key={scope} data-testid={`keyboard-shortcuts-scope-${scope}`}>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t(`scopes.${scope}`)}
            </h4>
            <ul className="divide-y divide-border">
              {shortcuts.map((shortcut) => (
                <li
                  key={shortcut.id}
                  data-testid={`keyboard-shortcut-${shortcut.id}`}
                  className="flex items-center justify-between gap-4 py-2"
                >
                  <span className="text-sm text-foreground">
                    {t(`shortcuts.${shortcut.id}`)}
                  </span>
                  <span className="flex flex-shrink-0 items-center gap-1">
                    {shortcut.keys.map((key, index) => (
                      <Kbd key={index}>{resolveShortcutKey(key, isMac)}</Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}

export default KeyboardShortcutsOverlay;
