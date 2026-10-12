/**
 * Escape on stacked layers (Issue #3630, follow-up to #3611)
 *
 * A layer that closes on a document / window `keydown` Escape must stand down
 * when a layer above already claimed the press with `preventDefault`, and must
 * still close on a direct Escape.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, renderHook } from '@testing-library/react';
import { SortSelectorBase } from '@/components/sidebar/SortSelectorBase';
import { ContextMenu } from '@/components/worktree/ContextMenu';
import { useContextMenu } from '@/hooks/useContextMenu';
import { FilePanelContent } from '@/components/worktree/FilePanelContent';
import { FileViewer } from '@/components/worktree/FileViewer';
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

/** A layer above (a Radix menu, the header tools' "…" list) claims Escape first. */
function pressEscapeClaimedAbove(target: Element = document.body): void {
  const claim = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') event.preventDefault();
  };
  document.addEventListener('keydown', claim, true);
  try {
    fireEvent.keyDown(target, { key: 'Escape' });
  } finally {
    document.removeEventListener('keydown', claim, true);
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SortSelectorBase Escape (Issue #3630)', () => {
  function open() {
    render(
      <SortSelectorBase
        sortKey="lastSent"
        sortDirection="desc"
        onSortKeyChange={vi.fn()}
        onSortDirectionChange={vi.fn()}
        options={[
          { key: 'repositoryName', label: 'Repository' },
          { key: 'lastSent', label: 'Last Sent' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Sort by/i }));
    expect(screen.getByRole('listbox')).toBeDefined();
  }

  it('stays open when a layer above already handled Escape', () => {
    open();
    pressEscapeClaimedAbove();
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('closes on a direct Escape', () => {
    open();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('ContextMenu Escape (Issue #3630)', () => {
  const props = {
    isOpen: true,
    position: { x: 10, y: 10 },
    targetPath: 'docs/readme.md',
    targetType: 'file' as const,
    onNewFile: vi.fn(),
    onNewDirectory: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };

  it('does not close when a layer above already handled Escape', () => {
    const onClose = vi.fn();
    render(<ContextMenu {...props} onClose={onClose} />);
    pressEscapeClaimedAbove();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a direct Escape', () => {
    const onClose = vi.fn();
    render(<ContextMenu {...props} onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('useContextMenu Escape (Issue #3630)', () => {
  function openMenu() {
    const hook = renderHook(() => useContextMenu());
    act(() => {
      hook.result.current.openMenu(
        { preventDefault: vi.fn(), clientX: 1, clientY: 2 } as unknown as React.MouseEvent,
        'a.md',
        'file',
      );
    });
    expect(hook.result.current.menuState.isOpen).toBe(true);
    return hook;
  }

  it('stays open when a layer above already handled Escape', () => {
    const { result } = openMenu();
    act(() => pressEscapeClaimedAbove());
    expect(result.current.menuState.isOpen).toBe(true);
  });

  it('closes on a direct Escape', () => {
    const { result } = openMenu();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    expect(result.current.menuState.isOpen).toBe(false);
  });
});

describe('FilePanelContent maximize Escape (Issue #3630)', () => {
  const tab: FileTab = {
    path: 'src/index.ts',
    name: 'index.ts',
    content: { path: 'src/index.ts', content: 'const x = 1;', extension: 'ts', worktreePath: '/repo' },
    loading: false,
    error: null,
    isDirty: false,
  };

  function maximized() {
    render(<FilePanelContent tab={tab} worktreeId="wt" onLoadContent={vi.fn()} onLoadError={vi.fn()} onSetLoading={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    expect(screen.getByTestId('maximized-file-overlay')).toBeInTheDocument();
  }

  it('stays maximized when a layer above already handled Escape', () => {
    maximized();
    pressEscapeClaimedAbove();
    expect(screen.queryByTestId('maximized-file-overlay')).toBeInTheDocument();
  });

  it('leaves maximize on a direct Escape', () => {
    maximized();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('maximized-file-overlay')).not.toBeInTheDocument();
  });
});

describe('FileViewer Escape (Issue #3630)', () => {
  function stubFile(path: string, extension: string, content: string): void {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ path, content, extension, worktreePath: '/wt' }),
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('unified screen ladder', () => {
    async function maximizedUnified() {
      stubFile('docs/readme.md', 'md', '# Title\n');
      const onClose = vi.fn();
      render(<FileViewer isOpen onClose={onClose} worktreeId="wt" filePath="docs/readme.md" />);
      await screen.findByTestId('markdown-file-screen');
      await screen.findByTestId('markdown-editor-textarea');
      fireEvent.click(screen.getByTestId('markdown-file-maximize'));
      expect(screen.getByTestId('markdown-file-immersive-controls')).toBeInTheDocument();
      return onClose;
    }

    it('does not step down the ladder when a layer above already handled Escape', async () => {
      const onClose = await maximizedUnified();
      pressEscapeClaimedAbove();
      expect(screen.getByTestId('markdown-file-immersive-controls')).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('leaves maximize on a direct Escape', async () => {
      await maximizedUnified();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('markdown-file-immersive-controls')).not.toBeInTheDocument();
    });
  });

  describe('fullscreen overlay', () => {
    async function fullscreen() {
      stubFile('src/a.ts', 'ts', 'const a = 1;');
      render(<FileViewer isOpen onClose={vi.fn()} worktreeId="wt" filePath="src/a.ts" />);
      const btn = await screen.findAllByRole('button', { name: 'Fullscreen' });
      fireEvent.click(btn[0]);
      expect(screen.getAllByRole('button', { name: /Exit fullscreen/i }).length).toBeGreaterThan(0);
    }

    it('stays fullscreen when a layer above already handled Escape', async () => {
      await fullscreen();
      pressEscapeClaimedAbove();
      expect(screen.getAllByRole('button', { name: /Exit fullscreen/i }).length).toBeGreaterThan(0);
    });

    it('exits fullscreen on a direct Escape', async () => {
      await fullscreen();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryAllByRole('button', { name: /Exit fullscreen/i })).toHaveLength(0);
    });
  });
});
