/**
 * Tests for TreeNode metadata display (Issue #969, #975)
 *
 * Covers the toggleable inline columns (size / created / modified) and the
 * unified hover tooltip (file name + metadata) rendered by TruncationTooltip
 * — replacing the previous native `title` metadata tooltip (Issue #975).
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import {
  TreeNode,
  TREE_ROW_LEADING_PX,
  TREE_ROW_NAME_MIN_PX,
  TREE_ROW_SIZE_MIN_CONTAINER_PX,
  TREE_ROW_DATE_MIN_CONTAINER_PX,
  TREE_ROW_SECOND_DATE_MIN_CONTAINER_PX,
} from '@/components/worktree/TreeNode';
import { TRUNCATION_TOOLTIP_DELAY_MS } from '@/components/common/TruncationTooltip';
import type { TreeItem } from '@/types/models';
import type { FileMetadataDisplaySettings } from '@/hooks/useFileMetadataDisplay';

// Issue #1275: this file asserts rendered wording (the directory item count),
// so it must resolve keys through the real dictionary. The global mock in
// tests/setup.ts echoes `worktree.<key>` back and would keep the assertion
// green even if the key did not exist.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

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
      // Issue #1275: these now resolve through the real dictionary, so assert
      // the wording a user actually sees rather than the mock's key echo — a
      // key-echo assertion passes even when the key is missing from locales/.
      expect(tooltip).toHaveTextContent('Size:');
      expect(tooltip).toHaveTextContent('Created:');
      expect(tooltip).toHaveTextContent('Modified:');
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

/**
 * Issue #2631: in a narrow panel the name gave way to the metadata columns
 * (`flex-shrink-0`) and was cut to one character ("README.md" -> "F…" beside
 * "81 B"). Each row is now its own query container, so the answer follows the
 * width the row has left after its indentation: the columns are drawn only
 * from a threshold up, and once they are, the name keeps a minimum width and
 * the columns give way instead.
 *
 * jsdom has no layout and evaluates no container query, so these tests pin the
 * classes; how it looks at real widths is checked in the UAT.
 */
describe('TreeNode in a narrow panel [Issue #2631]', () => {
  const ALL_COLUMNS: FileMetadataDisplaySettings = {
    showSize: true,
    showCreated: true,
    showModified: true,
  };
  const NAME_MIN_CLASS = `@min-[${TREE_ROW_SIZE_MIN_CONTAINER_PX}px]:min-w-16`;

  const classesOf = (el: Element | null): string[] =>
    (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

  const cannotShrink = (el: Element | null): boolean => {
    const classes = classesOf(el);
    return classes.includes('shrink-0') || classes.includes('flex-shrink-0');
  };

  /**
   * Why the name of `row` can still be cut short by its metadata columns, read
   * from classes: a column that refuses to shrink, or a name with no minimum
   * width once the columns are drawn.
   */
  function nameLosesTo(row: HTMLElement, name: HTMLElement): string[] {
    const reasons: string[] = [];
    for (const column of Array.from(row.querySelectorAll('[data-testid^="tree-item-"]'))) {
      if (cannotShrink(column)) reasons.push(`${column.getAttribute('data-testid')} does not shrink`);
    }
    if (!classesOf(name).includes(NAME_MIN_CLASS)) reasons.push('name has no minimum width');
    return reasons;
  }

  it('flags the pre-fix row (negative control for nameLosesTo)', () => {
    // The row as it was on develop 011d948e, spelled out so the helper is
    // shown to catch the defect without touching the component.
    render(
      <div data-testid="pre-fix-row" className="flex items-center gap-2 py-1.5 pr-2">
        <span className="w-4 h-4" />
        <svg className="w-5 h-5" aria-hidden="true" />
        <span data-testid="pre-fix-name" className="flex-1 truncate text-sm text-foreground">
          README.md
        </span>
        <span data-testid="tree-item-size" className="text-xs text-muted-foreground flex-shrink-0">
          81 B
        </span>
      </div>
    );
    expect(
      nameLosesTo(screen.getByTestId('pre-fix-row'), screen.getByTestId('pre-fix-name'))
    ).toEqual(['tree-item-size does not shrink', 'name has no minimum width']);
  });

  it('makes each row its own query container', () => {
    renderNode(FILE);
    expect(classesOf(screen.getByTestId('tree-item-app.ts'))).toContain('@container');
  });

  it('lets the columns give way to the name, file and directory alike', () => {
    renderNode(FILE, ALL_COLUMNS);
    const row = screen.getByTestId('tree-item-app.ts');
    expect(nameLosesTo(row, screen.getByText('app.ts'))).toEqual([]);
    expect(row.querySelectorAll('[data-testid^="tree-item-"]')).toHaveLength(3);

    cleanup();
    renderNode({ name: 'src', type: 'directory', itemCount: 3 });
    expect(nameLosesTo(screen.getByTestId('tree-item-src'), screen.getByText('src'))).toEqual([]);
  });

  it('gives the name its minimum width only once the columns can be drawn', () => {
    renderNode(FILE);
    const name = screen.getByText('app.ts');
    // An unconditional minimum would push a deeply indented row past the
    // panel's edge; below the threshold the name is the only thing that grows.
    expect(classesOf(name).filter((c) => c.startsWith('min-w-'))).toEqual([]);
    expect(classesOf(name)).toEqual(expect.arrayContaining(['flex-1', 'truncate', NAME_MIN_CLASS]));
    // min-w-16 is 4rem.
    expect(TREE_ROW_NAME_MIN_PX).toBe(64);
  });

  it('keeps the chevron and the icon at their size', () => {
    renderNode(FILE);
    const fileRow = screen.getByTestId('tree-item-app.ts');
    const [chevronSlot, icon] = Array.from(fileRow.children);
    expect(cannotShrink(chevronSlot)).toBe(true);
    expect(icon).toBe(screen.getByTestId('file-icon'));
    expect(cannotShrink(icon)).toBe(true);

    cleanup();
    renderNode({ name: 'src', type: 'directory', itemCount: 3 });
    const dirRow = screen.getByTestId('tree-item-src');
    expect(cannotShrink(dirRow.children[0])).toBe(true);
    expect(cannotShrink(screen.getByTestId('folder-icon'))).toBe(true);
  });

  it('draws each column only from its threshold up', () => {
    renderNode(FILE, { showSize: true, showCreated: false, showModified: true });
    const size = classesOf(screen.getByTestId('tree-item-size'));
    const modifiedAlone = classesOf(screen.getByTestId('tree-item-modified'));
    // The literals must match the constants (Tailwind cannot see an interpolation).
    expect(size).toEqual(
      expect.arrayContaining(['hidden', `@min-[${TREE_ROW_SIZE_MIN_CONTAINER_PX}px]:block`, 'truncate'])
    );
    expect(modifiedAlone).toEqual(
      expect.arrayContaining(['hidden', `@min-[${TREE_ROW_DATE_MIN_CONTAINER_PX}px]:block`, 'truncate'])
    );

    cleanup();
    renderNode(FILE, ALL_COLUMNS);
    expect(classesOf(screen.getByTestId('tree-item-created'))).toContain(
      `@min-[${TREE_ROW_DATE_MIN_CONTAINER_PX}px]:block`
    );
    // Beside the created column, the modified column needs room for both.
    expect(classesOf(screen.getByTestId('tree-item-modified'))).toContain(
      `@min-[${TREE_ROW_SECOND_DATE_MIN_CONTAINER_PX}px]:block`
    );
  });

  it('derives the thresholds from the row parts, so the name minimum never overflows the row', () => {
    // chevron 16 + gap 8 + icon 20 + gap 8
    expect(TREE_ROW_LEADING_PX).toBe(52);
    expect(TREE_ROW_SIZE_MIN_CONTAINER_PX).toBeGreaterThanOrEqual(
      TREE_ROW_LEADING_PX + TREE_ROW_NAME_MIN_PX
    );
    expect([
      TREE_ROW_SIZE_MIN_CONTAINER_PX,
      TREE_ROW_DATE_MIN_CONTAINER_PX,
      TREE_ROW_SECOND_DATE_MIN_CONTAINER_PX,
    ]).toEqual([176, 296, 416]);
  });
});
