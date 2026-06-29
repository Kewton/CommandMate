/**
 * Tests for TreeNode metadata display (Issue #969, #975)
 *
 * Covers the toggleable inline columns (size / created / modified) and the
 * unified hover tooltip (file name + metadata) rendered by TruncationTooltip
 * — replacing the previous native `title` metadata tooltip (Issue #975).
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TreeNode } from '@/components/worktree/TreeNode';
import { TRUNCATION_TOOLTIP_DELAY_MS } from '@/components/common/TruncationTooltip';
import type { TreeItem } from '@/types/models';
import type { FileMetadataDisplaySettings } from '@/hooks/useFileMetadataDisplay';

const FILE: TreeItem = {
  name: 'app.ts',
  type: 'file',
  size: 2048,
  extension: 'ts',
  birthtime: '2026-06-01T10:00:00.000Z',
  mtime: '2026-06-20T15:30:00.000Z',
};

function renderNode(
  item: TreeItem,
  metadataDisplay?: FileMetadataDisplaySettings
) {
  return render(
    <TreeNode
      item={item}
      path=""
      depth={0}
      worktreeId="wt-1"
      expanded={new Set<string>()}
      cache={new Map()}
      onToggle={() => {}}
      onLoadChildren={async () => {}}
      dateFnsLocaleStr="en"
      metadataDisplay={metadataDisplay}
    />
  );
}

describe('TreeNode metadata display [Issue #969]', () => {
  it('shows size inline by default and hides created/modified', () => {
    renderNode(FILE);
    expect(screen.getByTestId('tree-item-size')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-item-created')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tree-item-modified')).not.toBeInTheDocument();
  });

  it('hides size inline when showSize is false', () => {
    renderNode(FILE, { showSize: false, showCreated: false, showModified: false });
    expect(screen.queryByTestId('tree-item-size')).not.toBeInTheDocument();
  });

  it('shows created inline when showCreated is true', () => {
    renderNode(FILE, { showSize: true, showCreated: true, showModified: false });
    expect(screen.getByTestId('tree-item-created')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-item-modified')).not.toBeInTheDocument();
  });

  it('shows modified inline when showModified is true', () => {
    renderNode(FILE, { showSize: true, showCreated: false, showModified: true });
    expect(screen.getByTestId('tree-item-modified')).toBeInTheDocument();
  });

  describe('unified hover tooltip [Issue #975]', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('no longer sets a native title attribute on file rows', () => {
      renderNode(FILE);
      const row = screen.getByTestId('tree-item-app.ts');
      // Metadata moved out of the native `title` into the custom tooltip.
      expect(row.getAttribute('title')).toBeNull();
    });

    it('shows name + formatted metadata in a single bubble on hover', () => {
      renderNode(FILE);
      // The name trigger carries metadata, so the bubble appears on hover
      // even though jsdom reports the name as non-truncated.
      const trigger = screen.getByText('app.ts');
      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS);
      });

      const tooltip = screen.getByRole('tooltip', { hidden: true });
      // File name is part of the same bubble.
      expect(tooltip).toHaveTextContent('app.ts');
      // Size line (formatFileSize(2048) === '2.0 KB')
      expect(tooltip).toHaveTextContent('2.0 KB');
      // Localized labels resolve via the mocked useTranslations (key passthrough)
      expect(tooltip).toHaveTextContent('worktree.fileTree.metadata.size');
      expect(tooltip).toHaveTextContent('worktree.fileTree.metadata.created');
      expect(tooltip).toHaveTextContent('worktree.fileTree.metadata.modified');
    });

    it('does not show a metadata tooltip on directory rows', () => {
      const dir: TreeItem = { name: 'src', type: 'directory', itemCount: 3 };
      renderNode(dir);
      const row = screen.getByTestId('tree-item-src');
      expect(row.getAttribute('title')).toBeNull();

      // Directories pass no metadata; with a non-truncated name (jsdom) the
      // bubble never appears.
      const trigger = screen.getByText('src');
      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS + 50);
      });
      expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
    });
  });

  it('shows item count for directories when size column is on', () => {
    const dir: TreeItem = { name: 'src', type: 'directory', itemCount: 3 };
    renderNode(dir);
    expect(screen.getByTestId('tree-item-size')).toHaveTextContent('3 items');
  });
});
