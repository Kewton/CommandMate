/**
 * `.txt` in the PC file panel (Issue #2506)
 *
 * `FilePanelContent` picks a renderer per file, and two of its branches key off
 * `isEditableExtension()`. Adding `.txt` to that list moves a plain-text file
 * out of the read-only code viewer and into the editor — but only while it is
 * small enough to edit. Three things therefore have to hold together, and this
 * file keeps them together:
 *
 *   1. a small `.txt` reaches the editor branch (the acceptance criterion);
 *   2. an oversize `.txt` — flagged `readOnly` by the API since Issue #2505 —
 *      does NOT, because that branch mounts the whole file into one
 *      `<textarea>`. This is the regression half of the Issue: without the
 *      read-only check sitting ahead of the editable branches, making `.txt`
 *      editable would have routed multi-MB logs and dumps into a full-DOM
 *      mount, which is exactly the freeze Issue #723 removed;
 *   3. the in-file search view highlights the file as what it is. The search
 *      branch used to pass a literal `extension="md"`, which was invisible
 *      while `.md` was the only file that reached it and wrong the moment
 *      `.yaml` (Issue #646) and `.txt` did.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';
import { FilePanelContent } from '@/components/worktree/FilePanelContent';
import type { FileTab } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';

// The toolbar/search affordances are found by their rendered English labels,
// so keys must resolve through the real dictionary rather than the global
// echo mock (Issue #1206).
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

/**
 * `CodeViewer` asks highlight.js to colour each visible chunk with
 * `{ language: extension }`. Recording that argument is how the extension the
 * viewer was handed becomes observable — the prop itself never reaches the DOM.
 */
const { highlightLanguages } = vi.hoisted(() => ({ highlightLanguages: [] as string[] }));

vi.mock('highlight.js', () => ({
  default: {
    highlight: (code: string, options: { language: string }) => {
      highlightLanguages.push(options.language);
      return { value: code };
    },
    highlightAuto: (code: string) => ({ value: code }),
  },
}));

// ============================================================================
// Fixtures
// ============================================================================

const OVERSIZE_REASON = {
  code: 'FILE_TOO_LARGE' as const,
  message:
    'Opened read-only: this file is 3.0MB, over the 2.0MB limit for editing. ' +
    'You can view it but not save changes.',
  limitBytes: 2 * 1024 * 1024,
  sizeBytes: 3 * 1024 * 1024,
};

function createContent(overrides: Partial<FileContent> = {}): FileContent {
  return {
    path: 'notes.txt',
    content: 'alpha\nbravo\ncharlie',
    extension: 'txt',
    worktreePath: '/repo',
    ...overrides,
  };
}

function createTab(content: FileContent): FileTab {
  return {
    path: content.path,
    name: content.path.split('/').pop() ?? content.path,
    content,
    loading: false,
    error: null,
    isDirty: false,
  };
}

const defaultProps = {
  worktreeId: 'test-wt',
  onLoadContent: vi.fn(),
  onLoadError: vi.fn(),
  onSetLoading: vi.fn(),
};

function renderFile(content: FileContent) {
  return render(<FilePanelContent tab={createTab(content)} {...defaultProps} />);
}

/** Open the toolbar's in-file search and type a query long enough to take effect. */
function search(query: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Search in file' }));
  fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: query } });
}

// ============================================================================
// Tests
// ============================================================================

describe('FilePanelContent — .txt is editable (Issue #2506)', () => {
  let restoreLayout: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    highlightLanguages.length = 0;
    global.fetch = vi.fn();
    // jsdom reports every element as 0x0, and `@tanstack/react-virtual` mounts
    // no rows for a zero-height viewport — which would make the highlight
    // assertions below vacuously green.
    restoreLayout = installVirtualLayout({
      scrollContainerTestId: 'file-content-code',
      viewportHeight: 600,
      rowHeight: 20,
    });
  });

  afterEach(() => {
    restoreLayout();
  });

  // ------------------------------------------------------------------------
  // 1. Small .txt -> editor
  // ------------------------------------------------------------------------

  describe('a small .txt opens in the editor, not the read-only viewer', () => {
    it('does not render the code viewer', () => {
      renderFile(createContent());

      // `file-content-code` is the virtualized read-only viewer; the editor
      // branch never renders it. Before this Issue a `.txt` landed there.
      expect(screen.queryByTestId('file-content-code')).not.toBeInTheDocument();
    });

    it('shows no read-only notice', () => {
      renderFile(createContent());

      expect(screen.queryByTestId('file-read-only-notice')).not.toBeInTheDocument();
    });

    it('treats an uppercase .TXT the same way', () => {
      // `isEditableExtension()` lowercases before matching; the panel passes the
      // raw extension from the payload, so this pins that the two agree.
      renderFile(createContent({ path: 'NOTES.TXT', extension: 'TXT' }));

      expect(screen.queryByTestId('file-content-code')).not.toBeInTheDocument();
    });

    it('still sends a .log to the code viewer', () => {
      // The guard against the branch swallowing every text-ish file: exactly one
      // extension became editable.
      renderFile(createContent({ path: 'server.log', extension: 'log' }));

      expect(screen.getByTestId('file-content-code')).toBeInTheDocument();
    });
  });

  // ------------------------------------------------------------------------
  // 2. Oversize .txt -> virtualized viewer (the regression this Issue risked)
  // ------------------------------------------------------------------------

  describe('an oversize .txt keeps the virtualized read-only viewer', () => {
    const TOTAL_LINES = 10_000;
    const manyLines = Array.from({ length: TOTAL_LINES }, (_, i) => `line ${i + 1}`).join('\n');

    function oversizeTxt(): FileContent {
      return createContent({
        path: 'huge.txt',
        content: manyLines,
        readOnly: true,
        readOnlyReason: OVERSIZE_REASON,
      });
    }

    it('routes to the code viewer rather than the editor', () => {
      renderFile(oversizeTxt());

      expect(screen.getByTestId('file-content-code')).toBeInTheDocument();
    });

    it('renders a window of rows, not one node per line, and no textarea', () => {
      renderFile(oversizeTxt());

      const codeElement = screen.getByTestId('file-content-code');

      // The spacer sized to the WHOLE file proves the virtualizer is live over
      // all 10,000 lines; without it, "fewer rows than lines" would also pass
      // on an empty render.
      const spacer = codeElement.firstElementChild as HTMLElement;
      expect(parseFloat(spacer.style.height)).toBeGreaterThanOrEqual(TOTAL_LINES);

      const mountedRows = codeElement.querySelectorAll('[data-line]').length;
      expect(mountedRows).toBeGreaterThan(0);
      expect(mountedRows).toBeLessThan(TOTAL_LINES / 10);

      // The editor branch mounts the entire file into one textarea; that is the
      // performance cliff this ordering avoids.
      expect(document.querySelector('textarea')).toBeNull();
    });

    it('explains why saving is unavailable', () => {
      renderFile(oversizeTxt());

      const notice = screen.getByTestId('file-read-only-notice');
      expect(notice).toHaveTextContent(OVERSIZE_REASON.message);
      expect(notice).toHaveAttribute('data-reason-code', 'FILE_TOO_LARGE');
    });
  });

  // ------------------------------------------------------------------------
  // 3. Search highlighting uses the file's own extension
  // ------------------------------------------------------------------------

  describe('in-file search highlights by the real extension, not a hard-coded md', () => {
    it('highlights a .txt as txt', () => {
      renderFile(createContent());

      search('al');

      expect(screen.getByTestId('file-content-code')).toBeInTheDocument();
      expect(highlightLanguages.length).toBeGreaterThan(0);
      expect(highlightLanguages).toContain('txt');
      expect(highlightLanguages).not.toContain('md');
    });

    it('highlights a .yaml as yaml — the pre-existing half of the same defect', () => {
      // `.yaml` has been editable since Issue #646 and has been highlighted as
      // Markdown in the search view ever since, which is why this case is
      // pinned alongside the new one rather than only the new one.
      renderFile(
        createContent({
          path: 'config.yaml',
          extension: 'yaml',
          content: 'name: demo\nversion: 1.0\nitems:\n  - alpha',
        }),
      );

      search('al');

      expect(highlightLanguages).toContain('yaml');
      expect(highlightLanguages).not.toContain('md');
    });

    it('still highlights a .md as md', () => {
      // The fix must not be a swap: markdown files were the one case the literal
      // got right, and they have to keep getting it right.
      renderFile(
        createContent({
          path: 'README.md',
          extension: 'md',
          content: '# alpha\n\nbravo',
        }),
      );

      search('al');

      expect(highlightLanguages).toContain('md');
    });
  });
});
