/**
 * Escape inside the overlaid activity pane (Issue #3650, follow-up to #3611 /
 * #3630)
 *
 * #3611 / #3630 taught each layer to stand down on an Escape a layer above had
 * already handled. This pins the other direction: a layer that closes itself on
 * Escape must keep that press from also closing the pane underneath.
 *
 * - `FileMetadataToggle` (the file tree's display-settings menu) — the first
 *   Escape closes only the menu, the second closes the pane. The pane's
 *   document listener is registered when the pane opens, i.e. before the
 *   menu's, so the menu cannot claim the press in time with `preventDefault`
 *   alone; it marks itself `data-floating-layer="open"` like `ContextMenu`
 *   (Issue #3589) and the pane stands down while it is up.
 * - `Tooltip` — decided NOT to claim Escape: the header tool's bubble is up
 *   whenever its icon has focus or the pointer, which is exactly where the
 *   operator is after clicking the icon that opened the pane, so one Escape
 *   keeps closing both (see the comment on Tooltip's Escape listener).
 *
 * @vitest-environment jsdom
 */

import React, { useRef, useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { FileMetadataToggle } from '@/components/worktree/FileMetadataToggle';
import { Tooltip } from '@/components/common/Tooltip';
import { FileViewer } from '@/components/worktree/FileViewer';
import { FilePanelContent } from '@/components/worktree/FilePanelContent';
import { usePaneOverlayDismiss } from '@/hooks/useActivityPaneOverlay';
import type { FileMetadataDisplaySettings } from '@/hooks/useFileMetadataDisplay';
import type { FileTab } from '@/hooks/useFileTabs';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('highlight.js', () => ({
  default: {
    highlightAuto: (code: string) => ({ value: `<span class="hljs">${code}</span>` }),
  },
}));

vi.mock('@/components/ui/ConfirmDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/ConfirmDialog')>();
  return { ...actual, useConfirm: () => vi.fn().mockResolvedValue(true) };
});

const SETTINGS: FileMetadataDisplaySettings = {
  showSize: true,
  showCreated: false,
  showModified: false,
};

/** The pane, with the header tool that opened it outside (an ignore region). */
function Pane({ onDismiss }: { onDismiss: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { panelProps } = usePaneOverlayDismiss({
    enabled: true,
    panelRef,
    onDismiss,
    ignoreSelectors: ['[data-testid="header-tool-bar"]'],
  });
  return (
    <div ref={panelRef} data-testid="pane" {...panelProps}>
      <FileMetadataToggle settings={SETTINGS} onToggle={vi.fn()} />
    </div>
  );
}

function Screen() {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div data-testid="header-tool-bar">
        <Tooltip content="Files">
          <button type="button" data-testid="files-tool" onClick={() => setOpen((v) => !v)}>
            Files
          </button>
        </Tooltip>
      </div>
      {open && <Pane onDismiss={() => setOpen(false)} />}
    </div>
  );
}

function pressEscape(target: Element): void {
  act(() => {
    fireEvent.keyDown(target, { key: 'Escape' });
  });
}

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  global.fetch = originalFetch;
});

describe('FileMetadataToggle Escape inside the overlaid pane (Issue #3650)', () => {
  it('closes only the menu on the first Escape, then the pane on the second', () => {
    render(<Screen />);
    fireEvent.click(screen.getByTestId('file-metadata-toggle-button'));
    expect(screen.getByTestId('file-metadata-toggle-menu')).toBeDefined();

    pressEscape(screen.getByTestId('file-metadata-toggle-button'));
    expect(screen.queryByTestId('file-metadata-toggle-menu')).toBeNull();
    expect(screen.queryByTestId('pane')).not.toBeNull();

    pressEscape(screen.getByTestId('file-metadata-toggle-button'));
    expect(screen.queryByTestId('pane')).toBeNull();
  });

  it('marks the open menu as a floating layer the pane stands down for', () => {
    render(<Screen />);
    fireEvent.click(screen.getByTestId('file-metadata-toggle-button'));
    expect(screen.getByTestId('file-metadata-toggle-menu')).toHaveAttribute(
      'data-floating-layer',
      'open',
    );
  });

  it('claims the Escape it closes on, so window-level layers below leave it alone', () => {
    render(<Screen />);
    fireEvent.click(screen.getByTestId('file-metadata-toggle-button'));
    const seen: boolean[] = [];
    const onWindowKeyDown = (event: KeyboardEvent): void => {
      seen.push(event.defaultPrevented);
    };
    window.addEventListener('keydown', onWindowKeyDown);
    try {
      pressEscape(screen.getByTestId('file-metadata-toggle-button'));
      // Negative control: with the menu closed the press is left unclaimed.
      pressEscape(screen.getByTestId('file-metadata-toggle-button'));
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown);
    }
    expect(seen).toEqual([true, false]);
  });

  it('closes the pane on the first Escape when the menu is closed (negative control)', () => {
    render(<Screen />);
    pressEscape(screen.getByTestId('file-metadata-toggle-button'));
    expect(screen.queryByTestId('pane')).toBeNull();
  });

  it('closes the pane on an outside press only once the menu is closed', () => {
    render(<Screen />);
    fireEvent.click(screen.getByTestId('file-metadata-toggle-button'));
    act(() => {
      fireEvent.pointerDown(document.body);
      fireEvent.mouseDown(document.body);
    });
    expect(screen.queryByTestId('file-metadata-toggle-menu')).toBeNull();
    expect(screen.queryByTestId('pane')).not.toBeNull();

    act(() => {
      fireEvent.pointerDown(document.body);
    });
    expect(screen.queryByTestId('pane')).toBeNull();
  });
});

describe('Tooltip Escape over the overlaid pane (Issue #3650: decided not to claim it)', () => {
  it('one Escape hides the bubble and closes the pane opened from its icon', () => {
    render(<Screen />);
    act(() => {
      screen.getByTestId('files-tool').focus();
    });
    expect(screen.getByRole('tooltip', { hidden: true })).toBeDefined();

    pressEscape(screen.getByTestId('files-tool'));
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    expect(screen.queryByTestId('pane')).toBeNull();
  });

  it('leaves the press unclaimed for later listeners', () => {
    render(<Screen />);
    act(() => {
      screen.getByTestId('files-tool').focus();
    });
    let prevented: boolean | null = null;
    const onWindowKeyDown = (event: KeyboardEvent): void => {
      prevented = event.defaultPrevented;
    };
    window.addEventListener('keydown', onWindowKeyDown);
    try {
      pressEscape(screen.getByTestId('files-tool'));
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown);
    }
    expect(prevented).toBe(false);
  });
});

describe('FileMetadataToggle left open behind a screen in front (Issue #3650, consistency review)', () => {
  function stubFile(path: string, extension: string, content: string): void {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ path, content, extension, worktreePath: '/wt' }),
    }) as unknown as typeof fetch;
  }

  /** The mobile Files tab: the gear, a file row, and the FileViewer it opens. */
  function MobileFiles() {
    const [path, setPath] = useState<string | null>(null);
    return (
      <div>
        <FileMetadataToggle settings={SETTINGS} onToggle={vi.fn()} />
        <button
          type="button"
          data-testid="md-row"
          onKeyDown={(e) => {
            if (e.key === 'Enter') setPath('docs/readme.md');
          }}
        >
          readme.md
        </button>
        {path !== null && (
          <FileViewer isOpen onClose={() => setPath(null)} worktreeId="wt" filePath={path} />
        )}
      </div>
    );
  }

  function openMenuByKeyboard(): void {
    const gear = screen.getByTestId('file-metadata-toggle-button');
    act(() => gear.focus());
    fireEvent.click(gear);
    expect(screen.getByTestId('file-metadata-toggle-menu')).toBeDefined();
  }

  it('lets the FileViewer opened from a row (Tab, Enter) take the first Escape', async () => {
    stubFile('docs/readme.md', 'md', '# Title\n');
    render(<MobileFiles />);
    openMenuByKeyboard();
    const row = screen.getByTestId('md-row');
    act(() => row.focus());
    fireEvent.keyDown(row, { key: 'Enter' });
    await screen.findByTestId('markdown-file-screen');

    pressEscape((document.activeElement as Element | null) ?? document.body);
    expect(screen.queryByTestId('markdown-file-screen')).toBeNull();
  });

  it('closes the menu when focus moves out of it (Tab to a file row)', () => {
    render(<MobileFiles />);
    openMenuByKeyboard();
    act(() => screen.getByTestId('md-row').focus());
    expect(screen.queryByTestId('file-metadata-toggle-menu')).toBeNull();
  });

  it('stays open when focus moves inside it or goes nowhere (negative control)', () => {
    render(<MobileFiles />);
    openMenuByKeyboard();
    act(() => screen.getByTestId('file-metadata-toggle-showSize').focus());
    expect(screen.queryByTestId('file-metadata-toggle-menu')).not.toBeNull();
    act(() => (document.activeElement as HTMLElement).blur());
    expect(screen.queryByTestId('file-metadata-toggle-menu')).not.toBeNull();
  });

  it('leaves an Escape pressed in a maximized file panel in front to that panel', () => {
    const tab: FileTab = {
      path: 'src/index.ts',
      name: 'index.ts',
      content: { path: 'src/index.ts', content: 'const x = 1;', extension: 'ts', worktreePath: '/repo' },
      loading: false,
      error: null,
      isDirty: false,
    };
    render(
      <div>
        <FileMetadataToggle settings={SETTINGS} onToggle={vi.fn()} />
        <FilePanelContent tab={tab} worktreeId="wt" onLoadContent={vi.fn()} onLoadError={vi.fn()} onSetLoading={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByTestId('file-metadata-toggle-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    const overlay = screen.getByTestId('maximized-file-overlay');

    pressEscape(overlay);
    expect(screen.queryByTestId('maximized-file-overlay')).toBeNull();
  });

  it('still closes only the menu on an Escape from the gear or the page body (negative control)', () => {
    const seen: boolean[] = [];
    const onWindowKeyDown = (event: KeyboardEvent): void => {
      seen.push(event.defaultPrevented);
    };
    render(<MobileFiles />);
    window.addEventListener('keydown', onWindowKeyDown);
    try {
      openMenuByKeyboard();
      pressEscape(screen.getByTestId('file-metadata-toggle-button'));
      expect(screen.queryByTestId('file-metadata-toggle-menu')).toBeNull();

      fireEvent.click(screen.getByTestId('file-metadata-toggle-button'));
      pressEscape(document.body);
      expect(screen.queryByTestId('file-metadata-toggle-menu')).toBeNull();
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown);
    }
    expect(seen).toEqual([true, true]);
  });
});
