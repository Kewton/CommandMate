/**
 * @vitest-environment jsdom
 *
 * Issue #3651 (consistency review): with the "…" panel's width measured from
 * the body, a PC at 768px with the sidebar at its 480px maximum leaves the
 * panel ~272px. The folded items — the Verification chip and the lone split's
 * session controls (selector, Terminal / Chat, model, note) — must all stay
 * reachable, not overlap, and not overrun the panel's box: the panel wraps its
 * items onto rows, and each row item is capped at the box and truncates.
 *
 * jsdom does no layout: the bar's fit and the rects are modelled per element,
 * and the result is read from the rendered class / style.
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { VerificationStatusChip } from '@/components/worktree/VerificationStatusChip';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import type { AgentInstance } from '@/lib/cli-tools/types';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

beforeAll(() => installRadixJsdomPolyfills());

const INSTANCES: AgentInstance[] = [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }];

/** The panel's natural one-row width (chip + session controls), as at 1024px. */
const PANEL_NATURAL = 512;

let leftPx = 2000;
let viewport = 1024;
let regionLeft = 224;
let overflowRight = 436;

const saved = {
  scroll: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'),
  client: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  rect: Element.prototype.getBoundingClientRect,
};

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    x: left,
    y: top,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  clearTerminalSplitsLocalStorage();
  leftPx = 2000;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-testid') === 'split-action-bar-left' ? leftPx : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute('data-testid') !== 'split-action-bar-left') return 0;
      const session = this.querySelector('[data-testid="split-bar-session-0"]') ? 260 : 0;
      const chip = this.querySelector('[data-testid="verification-status-chip"]') ? 250 : 0;
      return 160 + session + chip;
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    switch (this.getAttribute('data-testid')) {
      case 'terminal-split-container':
        return domRect(regionLeft, 44, viewport - regionLeft, 700);
      case 'split-action-bar-items-overflow':
        return domRect(overflowRight - 28, 48, 28, 28);
      case 'split-action-bar-items-panel': {
        // A shrink-to-fit box: its natural width, capped by its max-width.
        const cap = parseFloat((this as HTMLElement).style.maxWidth);
        return domRect(0, 0, Number.isNaN(cap) ? PANEL_NATURAL : Math.min(PANEL_NATURAL, cap), 44);
      }
      default:
        return saved.rect.call(this);
    }
  };
  vi.stubGlobal('innerWidth', viewport);
});

afterEach(() => {
  cleanup();
  clearTerminalSplitsLocalStorage();
  if (saved.scroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', saved.scroll);
  if (saved.client) Object.defineProperty(HTMLElement.prototype, 'clientWidth', saved.client);
  Element.prototype.getBoundingClientRect = saved.rect;
  vi.unstubAllGlobals();
});

function renderBar() {
  return render(
    <TerminalSplitContainer
      worktreeId="w-3651"
      instances={INSTANCES}
      actionBarItems={
        <VerificationStatusChip task={null} latestRun={null} onOpen={vi.fn()} popover="floating" />
      }
      renderPane={({ splitIndex, cliToolId, instanceId, instance, availableInstances, onInstanceChange, onFocus }) => (
        <TerminalSplitPane
          worktreeId="w-3651"
          splitIndex={splitIndex}
          cliToolId={cliToolId}
          instanceId={instanceId}
          instance={instance}
          availableInstances={availableInstances}
          onInstanceChange={onInstanceChange}
          onFocus={onFocus}
          onSurfaceModeChange={vi.fn()}
          agentModel="claude-opus-4-with-a-long-model-name"
          terminal={<div />}
          footer={<div />}
        />
      )}
    />,
  );
}

function openFolded(): HTMLElement {
  leftPx = 200;
  renderBar();
  fireEvent.click(screen.getByTestId('split-action-bar-items-overflow'));
  return screen.getByTestId('split-action-bar-items-panel');
}

/** The folded row items: the chip's root and the parked session slot. */
function rowItems(panel: HTMLElement): { chip: HTMLElement; session: HTMLElement } {
  const chip = within(panel).getByTestId('verification-status-chip').closest('.relative.inline-flex');
  expect(chip).not.toBeNull();
  return {
    chip: chip as HTMLElement,
    session: within(panel).getByTestId('split-action-bar-session'),
  };
}

describe('"…" panel at 768px with a 480px sidebar (Issue #3651)', () => {
  beforeEach(() => {
    viewport = 768;
    regionLeft = 480;
    overflowRight = 620;
    vi.stubGlobal('innerWidth', viewport);
  });

  it('caps the panel at the body and wraps its items onto rows', () => {
    const panel = openFolded();
    expect(panel.style.maxWidth).toBe('272px');
    expect(parseFloat(panel.style.left)).toBe(488);
    expect(panel.className).toMatch(/\bflex\b/);
    expect(panel.className).toMatch(/\bflex-wrap\b/);
    // No scroll box: the chip's reason and the selector's menu are not clipped.
    expect(panel.className).not.toMatch(/\boverflow-/);
  });

  it('keeps every folded control in the panel, each row item capped at the box', () => {
    const panel = openFolded();
    for (const id of ['verification-status-chip', 'cli-selector-0', 'surface-mode-toggle-0', 'split-agent-model-0']) {
      expect(within(panel).getByTestId(id)).toBeInTheDocument();
    }
    const { chip, session } = rowItems(panel);
    expect(chip.className).toMatch(/\bmax-w-full\b/);
    expect(session.className).toMatch(/\bmax-w-full\b/);
    expect(session.className).toMatch(/\bmin-w-0\b/);
    // The parts that give way truncate inside the slot.
    expect(within(panel).getByTestId('split-agent-model-0').className).toMatch(/\btruncate\b/);
  });
});

describe('"…" panel where there is room (Issue #3651, negative control)', () => {
  it('stays right-aligned with "…" at 1440px with the sidebar closed', () => {
    viewport = 1440;
    regionLeft = 56;
    overflowRight = 900;
    vi.stubGlobal('innerWidth', viewport);
    const panel = openFolded();
    expect(panel.style.left).toBe(`${900 - PANEL_NATURAL}px`);
    expect(panel.style.maxWidth).toBe(`${1440 - 56 - 16}px`);
  });

  it('keeps the session controls on the bar, unchanged, while they fit', () => {
    renderBar();
    expect(screen.queryByTestId('split-action-bar-items-overflow')).toBeNull();
    const session = screen.getByTestId('split-action-bar-session');
    expect(session.className).toBe('flex min-w-0 items-center ml-1');
  });
});
