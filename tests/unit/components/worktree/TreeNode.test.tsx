/**
 * Tests for TreeNode metadata display (Issue #969)
 *
 * Covers the toggleable inline columns (size / created / modified) and the
 * formatted hover tooltip built into the row's `title` attribute.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TreeNode } from '@/components/worktree/TreeNode';
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

  it('builds a formatted, multi-line title tooltip on file rows', () => {
    renderNode(FILE);
    const row = screen.getByTestId('tree-item-app.ts');
    const title = row.getAttribute('title');
    expect(title).toBeTruthy();
    // Size line (formatFileSize(2048) === '2.0 KB')
    expect(title).toContain('2.0 KB');
    // Localized labels resolve via the mocked useTranslations (key passthrough)
    expect(title).toContain('worktree.fileTree.metadata.size');
    expect(title).toContain('worktree.fileTree.metadata.created');
    expect(title).toContain('worktree.fileTree.metadata.modified');
    // Multi-line (newline-separated)
    expect(title!.split('\n').length).toBe(3);
  });

  it('does not set a metadata title on directory rows', () => {
    const dir: TreeItem = { name: 'src', type: 'directory', itemCount: 3 };
    renderNode(dir);
    const row = screen.getByTestId('tree-item-src');
    expect(row.getAttribute('title')).toBeNull();
  });

  it('shows item count for directories when size column is on', () => {
    const dir: TreeItem = { name: 'src', type: 'directory', itemCount: 3 };
    renderNode(dir);
    expect(screen.getByTestId('tree-item-size')).toHaveTextContent('3 items');
  });
});
