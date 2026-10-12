/**
 * Issue #3615: with one split, the agent's name in the second row
 * (`split-bar-session-0`) has a readable width. Clipped narrower than that,
 * the row folds the split's controls behind "…" instead of squeezing the name
 * to one letter ("C" at 1024px with the sidebar open). The browser's widths
 * are measured in `tests/e2e/split-session-min-width-3615.spec.ts`; here a
 * width model stands in (jsdom has no layout).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { contentOverflows, FIT_MIN_WIDTH_ATTR } from '@/hooks/useDesktopHeaderFit';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import type { AgentInstance } from '@/lib/cli-tools/types';

beforeAll(() => installRadixJsdomPolyfills());

const INSTANCES: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
];

const saved = {
  scroll: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'),
  client: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
};

/**
 * The width model: the left group always fits its box (nothing pushes past
 * its edge), and the selector's name is `labelPx` wide of its natural 39px
 * ("Claude" at 12px, measured in Chromium) — the shape of the 1024px bug.
 */
let labelPx = 39;
const LABEL_NATURAL_PX = 39;

function installWidthModel(): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute('data-testid') === 'split-action-bar-left') return 800;
      if (this.closest('[data-testid="cli-selector-0"]') && this.classList.contains('truncate')) {
        return labelPx;
      }
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute('data-testid') === 'split-action-bar-left') return 800;
      if (this.closest('[data-testid="cli-selector-0"]') && this.classList.contains('truncate')) {
        return LABEL_NATURAL_PX;
      }
      return 0;
    },
  });
}

function restoreWidthModel(): void {
  if (saved.scroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', saved.scroll);
  if (saved.client) Object.defineProperty(HTMLElement.prototype, 'clientWidth', saved.client);
}

function renderContainer() {
  return render(
    <TerminalSplitContainer
      worktreeId="w-3615"
      instances={INSTANCES}
      renderPane={({ splitIndex, cliToolId, instanceId, instance, availableInstances, onInstanceChange, onFocus }) => (
        <TerminalSplitPane
          worktreeId="w-3615"
          splitIndex={splitIndex}
          cliToolId={cliToolId}
          instanceId={instanceId}
          instance={instance}
          availableInstances={availableInstances}
          onInstanceChange={onInstanceChange}
          onFocus={onFocus}
          onSurfaceModeChange={vi.fn()}
          terminal={<div />}
          footer={<div />}
        />
      )}
    />,
  );
}

describe('[#3615] contentOverflows: a clipped element with a readable width', () => {
  function group(clientWidth: number, scrollWidth: number, minWidth?: number): HTMLElement {
    const root = document.createElement('div');
    const span = document.createElement('span');
    span.style.overflowX = 'hidden';
    if (minWidth !== undefined) span.setAttribute(FIT_MIN_WIDTH_ATTR, String(minWidth));
    root.appendChild(span);
    document.body.appendChild(root);
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(root, 'scrollWidth', { configurable: true, value: 300 });
    Object.defineProperty(span, 'clientWidth', { configurable: true, value: clientWidth });
    Object.defineProperty(span, 'scrollWidth', { configurable: true, value: scrollWidth });
    return root;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('counts it as not fitting when clipped below its readable width (positive)', () => {
    expect(contentOverflows(group(7, 39, 48))).toBe(true);
  });

  it('lets it clip at or above its readable width (negative)', () => {
    expect(contentOverflows(group(48, 120, 48))).toBe(false);
  });

  it('does not count an unclipped short name, however narrow (negative)', () => {
    expect(contentOverflows(group(30, 30, 48))).toBe(false);
  });

  it('still skips a clipping element without the mark (negative: as before)', () => {
    expect(contentOverflows(group(7, 39))).toBe(false);
  });
});

describe('[#3615] one split: the agent name folds behind "…" rather than shrink to a letter', () => {
  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
    labelPx = LABEL_NATURAL_PX;
    installWidthModel();
  });

  afterEach(() => {
    restoreWidthModel();
    clearTerminalSplitsLocalStorage();
  });

  it('marks the name with its readable width in the action bar', () => {
    renderContainer();
    const label = screen
      .getByTestId('cli-selector-0')
      .querySelector(`[${FIT_MIN_WIDTH_ATTR}]`);
    expect(label?.textContent).toBe('Claude');
    expect(Number(label?.getAttribute(FIT_MIN_WIDTH_ATTR))).toBeGreaterThanOrEqual(39);
  });

  it('keeps the selector on the bar while the name is whole (negative)', () => {
    renderContainer();
    expect(screen.queryByTestId('split-action-bar-items-overflow')).toBeNull();
    expect(
      within(screen.getByTestId('split-action-bar-left')).getByTestId('cli-selector-0'),
    ).toBeInTheDocument();
  });

  it('folds the selector behind "…" when the name is down to one letter (positive)', () => {
    labelPx = 7;
    renderContainer();
    expect(screen.getByTestId('split-action-bar-items-overflow')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('split-action-bar-left')).queryByTestId('cli-selector-0'),
    ).toBeNull();
  });
});
