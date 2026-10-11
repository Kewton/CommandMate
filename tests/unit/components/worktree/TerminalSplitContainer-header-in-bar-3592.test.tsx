/**
 * Issue #3592: with ONE split, the split's title bar is not drawn — its
 * controls (agent selector, Terminal / Chat, model, cost, note, End, search,
 * maximize, "…") are in the action bar. With two or more, each split has its
 * own 30px title bar. Switching between the two moves only the controls: the
 * split's content (draft, polling, scroll, the reason popover) is never
 * re-created.
 *
 * @vitest-environment jsdom
 */

import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import type { AgentInstance } from '@/lib/cli-tools/types';

beforeAll(() => installRadixJsdomPolyfills());

const INSTANCES: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
];

/** How many times each split's content mounted, by split index. */
let mounts: Record<number, number> = {};

/** Stands in for the split's content: counts its mounts, holds a draft. */
function PaneBody({ splitIndex }: { splitIndex: number }) {
  useEffect(() => {
    mounts[splitIndex] = (mounts[splitIndex] ?? 0) + 1;
  }, [splitIndex]);
  return <textarea data-testid={`draft-${splitIndex}`} defaultValue="" />;
}

function renderContainer(
  extra: Partial<React.ComponentProps<typeof TerminalSplitContainer>> = {},
  agentModel = 'opus-4',
) {
  return render(
    <TerminalSplitContainer
      worktreeId="w-3592"
      instances={INSTANCES}
      actionBarItems={<span data-testid="chip">chip</span>}
      renderPane={({
        splitIndex,
        cliToolId,
        instanceId,
        instance,
        availableInstances,
        onInstanceChange,
        onFocus,
        isMaximized,
        onToggleMaximize,
        showFocusFrame,
      }) => (
        <TerminalSplitPane
          worktreeId="w-3592"
          splitIndex={splitIndex}
          cliToolId={cliToolId}
          instanceId={instanceId}
          instance={instance}
          availableInstances={availableInstances}
          onInstanceChange={onInstanceChange}
          onFocus={onFocus}
          isMaximized={isMaximized}
          onToggleMaximize={onToggleMaximize}
          showFocusFrame={showFocusFrame}
          onSurfaceModeChange={vi.fn()}
          agentModel={agentModel}
          agentUsage="$0.03 · 8.5K (1%)"
          agentUsageDetail="cost detail"
          terminal={<PaneBody splitIndex={splitIndex} />}
          footer={<div />}
        />
      )}
      {...extra}
    />,
  );
}

describe('[#3592] one split: the title bar\'s controls are in the action bar', () => {
  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
    mounts = {};
  });
  afterEach(() => clearTerminalSplitsLocalStorage());

  it('draws no title bar in the split, and the session controls right of the chip', () => {
    renderContainer();
    const pane = screen.getByTestId('terminal-split-pane-0');
    expect(within(pane).queryByTestId('split-header-0')).toBeNull();
    expect(within(pane).queryByTestId('cli-selector-0')).toBeNull();
    // Flush under the bar: the bar's bottom border is the split's top edge.
    expect(pane.className).toContain('border-t-0');

    const session = screen.getByTestId('split-action-bar-session');
    for (const id of [
      'cli-selector-0',
      'surface-mode-toggle-0',
      'split-agent-model-0',
      'split-agent-usage-0',
      'split-session-note-edit-0',
    ]) {
      expect(within(session).getByTestId(id)).toBeInTheDocument();
    }
    // Right of the Verification chip (the slotted items).
    const chip = screen.getByTestId('chip');
    expect(chip.compareDocumentPosition(session) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts search, maximize and "…" at the right end, left of History / Files', () => {
    renderContainer();
    const actions = screen.getByTestId('split-action-bar-pane-actions');
    // Second contract: the split's own maximize icon is not drawn here — the
    // bar's `toggle-maximize-split` is the one maximize (see below).
    for (const id of ['terminal-search-button-0', 'split-more-menu-0']) {
      expect(within(actions).getByTestId(id)).toBeInTheDocument();
    }
    const history = screen.getByTestId('toggle-history-pane');
    expect(actions.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Open Files keeps its empty-state rule (#2259).
    expect(screen.getByTestId('toggle-file-panel')).toBeDisabled();
  });

  it('gives the selector the model and cost as its tooltip (the chips\' own strings)', () => {
    renderContainer();
    const title = screen.getByTestId('cli-selector-0').getAttribute('title') ?? '';
    expect(title).toContain('worktree.agentModel.modelLabel');
    expect(title).toContain('cost detail');
  });

  it('opens the note editor from the bar\'s edit entry when the note is empty', () => {
    renderContainer();
    fireEvent.click(screen.getByTestId('split-session-note-edit-0'));
    expect(
      within(screen.getByTestId('split-action-bar-session')).getByTestId('split-session-note-input-0'),
    ).toBeInTheDocument();
  });
});

describe('[#3592] two or more splits: each split has its own 30px title bar', () => {
  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
    mounts = {};
  });
  afterEach(() => clearTerminalSplitsLocalStorage());

  it('draws a title bar per split and no slots in the bar', () => {
    renderContainer();
    fireEvent.click(screen.getByTestId('split-layout-2'));
    expect(screen.queryByTestId('split-action-bar-session')).toBeNull();
    expect(screen.queryByTestId('split-action-bar-pane-actions')).toBeNull();
    for (const idx of [0, 1]) {
      const header = within(screen.getByTestId(`terminal-split-pane-${idx}`)).getByTestId(
        `split-header-${idx}`,
      );
      expect(header.className).toContain('h-[30px]');
      expect(screen.getByTestId(`terminal-split-pane-${idx}`).className).not.toContain('border-t-0');
      expect(within(header).getByTestId(`cli-selector-${idx}`)).toBeInTheDocument();
      expect(within(header).getByTestId(`split-more-menu-${idx}`)).toBeInTheDocument();
      // The title bar keeps the #2427 rule: an empty note adds nothing.
      expect(within(header).queryByTestId(`split-session-note-edit-${idx}`)).toBeNull();
      // And no tooltip on the selector: the chips are beside it.
      expect(within(header).getByTestId(`cli-selector-${idx}`)).not.toHaveAttribute('title');
    }
  });

  it('1 → 2 → 1 keeps the split\'s content mounted and its draft', () => {
    renderContainer();
    const draft = screen.getByTestId('draft-0') as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: 'half-typed instruction' } });
    expect(mounts[0]).toBe(1);

    fireEvent.click(screen.getByTestId('split-layout-2'));
    expect(screen.getByTestId('split-header-0')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('split-layout-1'));
    expect(screen.queryByTestId('split-header-0')).toBeNull();

    expect(screen.getByTestId('draft-0')).toBe(draft);
    expect(draft.value).toBe('half-typed instruction');
    expect(mounts[0]).toBe(1);
  });
});

describe('[#3592] negative control: a pane with no container keeps its title bar', () => {
  it('renders the 30px title bar when nothing provides the slots', () => {
    render(
      <TerminalSplitPane
        worktreeId="w-3592"
        splitIndex={0}
        cliToolId="claude"
        instanceId="claude"
        instance={INSTANCES[0]}
        availableInstances={[INSTANCES[0]]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        terminal={<div />}
        footer={<div />}
      />,
    );
    const header = screen.getByTestId('split-header-0');
    expect(within(header).getByTestId('cli-selector-0')).toBeInTheDocument();
    expect(within(header).getByTestId('split-more-menu-0')).toBeInTheDocument();
  });

  it('keeps the bar\'s own maximize disabled at one split (unchanged)', () => {
    clearTerminalSplitsLocalStorage();
    renderContainer();
    expect(screen.getByTestId('toggle-maximize-split')).toBeDisabled();
    clearTerminalSplitsLocalStorage();
  });
});

// ---------------------------------------------------------------------------
// Second contract (Codex consistency review: P2 x3, P3 x1)
// ---------------------------------------------------------------------------

describe('[#3592] the note being typed survives 1 <-> 2 splits', () => {
  beforeEach(() => clearTerminalSplitsLocalStorage());
  afterEach(() => clearTerminalSplitsLocalStorage());

  it('keeps the half-typed note through 1 -> 2 -> 1 (positive)', () => {
    renderContainer();
    fireEvent.click(screen.getByTestId('split-session-note-edit-0'));
    fireEvent.change(screen.getByTestId('split-session-note-input-0'), {
      target: { value: 'review pending' },
    });

    fireEvent.click(screen.getByTestId('split-layout-2'));
    const inHeader = within(screen.getByTestId('split-header-0')).getByTestId(
      'split-session-note-input-0',
    ) as HTMLInputElement;
    expect(inHeader.value).toBe('review pending');

    fireEvent.click(screen.getByTestId('split-layout-1'));
    const inBar = within(screen.getByTestId('split-action-bar-session')).getByTestId(
      'split-session-note-input-0',
    ) as HTMLInputElement;
    expect(inBar.value).toBe('review pending');
  });

  it('opens with the saved note (empty here) after a cancel (negative)', () => {
    renderContainer();
    fireEvent.click(screen.getByTestId('split-session-note-edit-0'));
    const input = screen.getByTestId('split-session-note-input-0');
    fireEvent.change(input, { target: { value: 'thrown away' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('split-session-note-input-0')).toBeNull();

    fireEvent.click(screen.getByTestId('split-session-note-edit-0'));
    expect((screen.getByTestId('split-session-note-input-0') as HTMLInputElement).value).toBe('');
  });
});

describe('[#3592] the controls moved into the bar carry the split\'s mark', () => {
  beforeEach(() => clearTerminalSplitsLocalStorage());
  afterEach(() => clearTerminalSplitsLocalStorage());

  it('marks the session and action controls with data-split-index', () => {
    renderContainer();
    fireEvent.click(screen.getByTestId('split-session-note-edit-0'));
    for (const id of ['split-session-note-input-0', 'cli-selector-0', 'split-more-menu-0']) {
      const owner = screen.getByTestId(id).closest('[data-split-index]');
      expect(owner).not.toBeNull();
      expect(owner?.getAttribute('data-split-index')).toBe('0');
      // Outside the pane's subtree: the mark is on the bar side.
      expect(screen.getByTestId('terminal-split-pane-0').contains(owner)).toBe(false);
    }
  });
});

describe('[#3592] one maximize icon with one split', () => {
  beforeEach(() => clearTerminalSplitsLocalStorage());
  afterEach(() => clearTerminalSplitsLocalStorage());

  it('draws only the bar\'s maximize on the second row (positive)', () => {
    renderContainer();
    const bar = screen.getByTestId('split-action-bar');
    expect(within(bar).queryByTestId('toggle-maximize-0')).toBeNull();
    expect(within(bar).getByTestId('toggle-maximize-split')).toBeInTheDocument();
    // The "…" menu keeps its item.
    expect(within(bar).getByTestId('split-more-menu-0')).toBeInTheDocument();
  });

  it('keeps each split\'s maximize in its title bar with two splits (negative)', () => {
    renderContainer();
    fireEvent.click(screen.getByTestId('split-layout-2'));
    for (const idx of [0, 1]) {
      expect(
        within(screen.getByTestId(`split-header-${idx}`)).getByTestId(`toggle-maximize-${idx}`),
      ).toBeInTheDocument();
    }
    expect(screen.getByTestId('toggle-maximize-split')).not.toBeDisabled();
  });
});

/*
 * The bar's width fit, with the lone split's controls in it. jsdom has no
 * layout, so a small width model stands in: the left group is `leftWidth`
 * wide and its content is the layout ops plus — while they are in it — the
 * split's session controls, whose width follows the model's text (so a model
 * that grows widens them). Only `scrollWidth` / `clientWidth` are read by the fit.
 */
describe('[#3592] the moved controls are part of the bar\'s width fit', () => {
  let leftWidth = 2000;
  const LAYOUT_OPS = 160;
  // A fixed part (selector, Terminal / Chat, cost, note entry) plus the model.
  const sessionWidth = (el: Element) =>
    200 + (el.querySelector('[data-testid="split-agent-model-0"]')?.textContent ?? '').length * 6;
  const original = {
    scroll: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'),
    client: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  };

  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
    leftWidth = 2000;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('data-testid') === 'split-action-bar-left' ? leftWidth : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute('data-testid') !== 'split-action-bar-left') return 0;
        const session = this.querySelector('[data-testid="split-bar-session-0"]');
        return LAYOUT_OPS + (session ? sessionWidth(session) : 0);
      },
    });
  });

  afterEach(() => {
    clearTerminalSplitsLocalStorage();
    if (original.scroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', original.scroll);
    if (original.client) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original.client);
  });

  it('keeps them on the bar where they fit (negative)', () => {
    renderContainer({ actionBarItems: undefined });
    expect(screen.queryByTestId('split-action-bar-items-overflow')).toBeNull();
    expect(
      within(screen.getByTestId('split-action-bar-left')).getByTestId('cli-selector-0'),
    ).toBeInTheDocument();
  });

  it('folds the selector, Terminal / Chat and the note behind "…" where they do not (positive)', () => {
    leftWidth = 300;
    renderContainer();
    const left = screen.getByTestId('split-action-bar-left');
    expect(within(left).queryByTestId('cli-selector-0')).toBeNull();

    fireEvent.click(screen.getByTestId('split-action-bar-items-overflow'));
    const panel = screen.getByTestId('split-action-bar-items-panel');
    for (const id of ['chip', 'cli-selector-0', 'surface-mode-toggle-0', 'split-session-note-edit-0']) {
      expect(within(panel).getByTestId(id)).toBeInTheDocument();
    }
    // The chip stays first: "…" hands focus to it, as before.
    expect(
      within(panel).getByTestId('chip').compareDocumentPosition(
        within(panel).getByTestId('cli-selector-0'),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // A press in the moved controls does not close the panel.
    fireEvent.mouseDown(within(panel).getByTestId('surface-mode-chat-0'));
    expect(screen.getByTestId('split-action-bar-items-panel')).toBeInTheDocument();
  });

  it('keeps the folded controls mounted (hidden) while the panel is closed', () => {
    leftWidth = 300;
    renderContainer();
    const selector = screen.getByTestId('cli-selector-0');
    expect(selector.closest('[hidden]')).not.toBeNull();
    // Still the one split's controls: no title bar came back.
    expect(screen.queryByTestId('split-header-0')).toBeNull();
  });

  it('folds without an item of the worktree screen\'s, too', () => {
    leftWidth = 300;
    renderContainer({ actionBarItems: undefined });
    fireEvent.click(screen.getByTestId('split-action-bar-items-overflow'));
    expect(
      within(screen.getByTestId('split-action-bar-items-panel')).getByTestId('cli-selector-0'),
    ).toBeInTheDocument();
  });

  it('measures again when what the split draws grows, with no prop of the bar changing (positive)', async () => {
    // 160 ops + 206 of session fit in 420 with a one-letter model ...
    leftWidth = 420;
    const { rerender } = renderContainer({ actionBarItems: undefined }, 'm');
    expect(screen.queryByTestId('split-action-bar-items-overflow')).toBeNull();

    // ... and not with a long one. Only the split's own prop changes.
    const long = 'claude-opus-with-a-very-long-model-identifier';
    rerender(
      <TerminalSplitContainer
        worktreeId="w-3592"
        instances={INSTANCES}
        renderPane={({ splitIndex, cliToolId, instanceId, instance, availableInstances, onInstanceChange, onFocus }) => (
          <TerminalSplitPane
            worktreeId="w-3592"
            splitIndex={splitIndex}
            cliToolId={cliToolId}
            instanceId={instanceId}
            instance={instance}
            availableInstances={availableInstances}
            onInstanceChange={onInstanceChange}
            onFocus={onFocus}
            agentModel={long}
            terminal={<PaneBody splitIndex={splitIndex} />}
            footer={<div />}
          />
        )}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('split-action-bar-items-overflow')).toBeInTheDocument();
  });
});
