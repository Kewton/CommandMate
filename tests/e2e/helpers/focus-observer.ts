/**
 * Issue #4335: record the order of keyboard / focus / pointer events and of the Radix menu's
 * keyboard listener, so a keyboard spec can wait for the menu to be ready and say why it was not.
 *
 * Radix Menu (`@radix-ui/react-menu`, the root under every `DropdownMenu`) registers, in a
 * `useEffect` of its root, a capture `keydown` listener on `document` that sets
 * `isUsingKeyboardRef`; when the menu opens with that flag false, the entry focus is prevented and
 * the first item is not focused (`onEntryFocus` → `preventDefault`). The root's effect runs after
 * hydration's commit, so a page that is visible (and even has its trigger hydrated — selective
 * hydration replays the Enter on it) can take the first Enter before that listener exists: the menu
 * opens, the first item stays inactive. That is the CI failure of worktree-list's keyboard spec
 * (43193373237 / 43197516072: line 103, the initial focus — not the Escape restore).
 *
 * `installFocusObserver` must be called before `page.goto` (an init script). It
 *  - records `keydown` / `focusin` / `pointerdown` / `pointermove` on `document` (capture, first),
 *    each with the Radix listener's state at that moment and the active element;
 *  - records every capture `keydown` listener added to / removed from `document`, and marks the
 *    Radix menu root's (its source names `isUsingKeyboardRef` — the dev build is not minified);
 *  - with `deferRadixKeyboardListener`, holds that listener's registration back until
 *    `releaseRadixKeyboardListener` — the control that puts the first Enter before it on purpose.
 */

import type { Page } from '@playwright/test';

export interface FocusEvent4335 {
  type: string;
  key?: string;
  /** Radix menu root keyboard listeners attached on document at that moment. */
  radixArmed: number;
  active: string;
  target: string;
  at: number;
}

export interface FocusRecord {
  events: FocusEvent4335[];
  listeners: Array<{ op: 'add' | 'remove' | 'deferred' | 'released'; radix: boolean; at: number }>;
  radixArmed: number;
}

declare global {
  interface Window {
    __focus4335?: FocusRecord & { release: () => void };
  }
}

export async function installFocusObserver(
  page: Page,
  { deferRadixKeyboardListener = false }: { deferRadixKeyboardListener?: boolean } = {},
): Promise<void> {
  await page.addInitScript((defer: boolean) => {
    const describe = (el: Element | null): string => {
      if (!el) return 'null';
      const h = el as HTMLElement;
      const id = h.getAttribute?.('data-testid');
      const role = h.getAttribute?.('role');
      const text = role === 'menuitemradio' ? `:${(h.textContent ?? '').trim()}` : '';
      return `${el.tagName.toLowerCase()}${id ? `[data-testid=${id}]` : ''}${role ? `[role=${role}${text}]` : ''}`;
    };
    const record: FocusRecord & { release: () => void } = {
      events: [],
      listeners: [],
      radixArmed: 0,
      release: () => undefined,
    };
    const isCapture = (options: unknown) =>
      options === true || (typeof options === 'object' && options !== null && (options as { capture?: boolean }).capture === true);
    const isRadix = (listener: unknown) =>
      typeof listener === 'function' && Function.prototype.toString.call(listener).includes('isUsingKeyboardRef');
    const add = Document.prototype.addEventListener;
    const remove = Document.prototype.removeEventListener;
    const pending: Array<() => void> = [];
    const radixAttached = new Set<unknown>();
    let released = !defer;
    record.release = () => {
      released = true;
      record.listeners.push({ op: 'released', radix: true, at: performance.now() });
      while (pending.length) pending.shift()!();
    };
    Document.prototype.addEventListener = function (this: Document, type: string, listener: unknown, options?: unknown) {
      if (this === document && type === 'keydown' && isCapture(options)) {
        const radix = isRadix(listener);
        const attach = () => {
          if (radix) {
            radixAttached.add(listener);
            record.radixArmed = radixAttached.size;
          }
          record.listeners.push({ op: 'add', radix, at: performance.now() });
          (add as (...a: unknown[]) => void).call(this, type, listener, options);
        };
        if (radix && !released) {
          record.listeners.push({ op: 'deferred', radix, at: performance.now() });
          pending.push(attach);
          return;
        }
        attach();
        return;
      }
      return (add as (...a: unknown[]) => void).call(this, type, listener, options);
    } as typeof Document.prototype.addEventListener;
    Document.prototype.removeEventListener = function (this: Document, type: string, listener: unknown, options?: unknown) {
      if (this === document && type === 'keydown' && isCapture(options)) {
        const radix = isRadix(listener);
        if (radix) {
          radixAttached.delete(listener);
          record.radixArmed = radixAttached.size;
        }
        record.listeners.push({ op: 'remove', radix, at: performance.now() });
      }
      return (remove as (...a: unknown[]) => void).call(this, type, listener, options);
    } as typeof Document.prototype.removeEventListener;

    for (const type of ['keydown', 'focusin', 'pointerdown', 'pointermove']) {
      (add as (...a: unknown[]) => void).call(
        document,
        type,
        (e: Event) => {
          record.events.push({
            type,
            key: (e as KeyboardEvent).key,
            radixArmed: record.radixArmed,
            active: describe(document.activeElement),
            target: describe(e.target as Element),
            at: performance.now(),
          });
        },
        { capture: true },
      );
    }
    window.__focus4335 = record;
  }, deferRadixKeyboardListener);
}

export async function readFocusRecord(page: Page): Promise<FocusRecord | null> {
  return page.evaluate(() => {
    const r = window.__focus4335;
    return r ? { events: [...r.events], listeners: [...r.listeners], radixArmed: r.radixArmed } : null;
  });
}

/**
 * Wait until every Radix menu on the page has its root's keyboard listener on `document` — one per
 * Radix menu trigger (`[aria-haspopup="menu"][data-state]`) — i.e. the menus' client side is ready.
 */
export async function waitForRadixKeyboardListener(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const triggers = document.querySelectorAll('[aria-haspopup="menu"][data-state]').length;
      return triggers > 0 && (window.__focus4335?.radixArmed ?? 0) >= triggers;
    },
    undefined,
    { timeout },
  );
}

export async function releaseRadixKeyboardListener(page: Page): Promise<void> {
  await page.evaluate(() => window.__focus4335?.release());
}
