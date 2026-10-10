/**
 * Which elements count as "another modal is open" for New task (Issue #3511).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import { isAnyModalOpen } from '@/lib/new-task/modal-open';

function mount(html: string) {
  document.body.innerHTML = html;
}

// What `Modal` renders for its panel (role, aria-modal, tabindex, data-state).
const MODAL_PANEL = '<div role="dialog" aria-modal="true" tabindex="-1" data-state="open"></div>';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('[#3511] isAnyModalOpen', () => {
  it('counts a displayed Modal panel and a focus-trapped sheet', () => {
    mount(MODAL_PANEL);
    expect(isAnyModalOpen()).toBe(true);
    // useFocusTrap adds tabindex="-1" to its container when it engages.
    mount('<div role="dialog" aria-modal="true" tabindex="-1"></div>');
    expect(isAnyModalOpen()).toBe(true);
  });

  it('does not count a dialog without a focus trap (the inline PromptPanel)', () => {
    mount('<div data-testid="prompt-panel" role="dialog" aria-modal="true"></div>');
    expect(isAnyModalOpen()).toBe(false);
  });

  it('does not count a modal under display:none or hidden, at any depth', () => {
    mount(`<div style="display: none"><section>${MODAL_PANEL}</section></div>`);
    expect(isAnyModalOpen()).toBe(false);
    mount(`<div hidden>${MODAL_PANEL}</div>`);
    expect(isAnyModalOpen()).toBe(false);
    // One hidden, one shown: the shown one counts.
    mount(`<div style="display: none">${MODAL_PANEL}</div><div>${MODAL_PANEL}</div>`);
    expect(isAnyModalOpen()).toBe(true);
  });

  it('does not count a panel playing its exit animation', () => {
    mount('<div role="dialog" aria-modal="true" tabindex="-1" data-state="closed"></div>');
    expect(isAnyModalOpen()).toBe(false);
  });
});
