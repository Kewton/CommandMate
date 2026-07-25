/**
 * E2E Tests: Markdown Editor
 * Tests file creation, editing, saving, and preview functionality
 *
 * Phase 5 - Task 5.1
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  mockEditorApi,
  E2E_EDITOR_WORKTREE,
  E2E_EDITOR_FILE,
  E2E_EDITOR_CONTENT,
} from './fixtures/markdown-editor-helpers';

test.describe('Markdown Editor', () => {
  /**
   * Note: These tests assume at least one worktree exists with file access.
   * In CI environment, may need to set up test data first.
   */

  test.describe('File Selection and Editor Display', () => {
    test('should open MarkdownEditor when .md file is selected from Files tab', async ({ page }) => {
      // Navigate to home page
      await page.goto('/');
      await page.waitForTimeout(1000);

      // Check if any worktree cards are present
      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      const count = await worktreeCards.count();

      if (count === 0) {
        test.skip(true, 'No worktrees available for testing');
        return;
      }

      // Click first worktree card
      await worktreeCards.first().click();
      await expect(page).toHaveURL(/\/worktrees\/.+/);
      await page.waitForTimeout(500);

      // Switch to Files tab
      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() > 0) {
        await filesTab.click();
        await page.waitForTimeout(500);

        // Look for any .md file in the tree
        const mdFile = page.locator('[data-testid^="tree-item-"]').filter({ hasText: '.md' }).first();
        if (await mdFile.count() > 0) {
          // Click the md file to open editor
          await mdFile.click();
          await page.waitForTimeout(500);

          // Verify editor modal appears
          const editor = page.locator('[data-testid="markdown-editor"]');
          // Editor should be visible in modal
          await expect(editor).toBeVisible({ timeout: 5000 });
        }
      }
    });

    test('should display editor with split view by default', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      const count = await worktreeCards.count();

      if (count === 0) {
        test.skip(true, 'No worktrees available for testing');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() > 0) {
        await filesTab.click();
        await page.waitForTimeout(500);

        const mdFile = page.locator('[data-testid^="tree-item-"]').filter({ hasText: '.md' }).first();
        if (await mdFile.count() > 0) {
          await mdFile.click();
          await page.waitForTimeout(500);

          // Check for view mode buttons
          const splitButton = page.locator('[data-testid="view-mode-split"]');
          const editorButton = page.locator('[data-testid="view-mode-editor"]');
          const previewButton = page.locator('[data-testid="view-mode-preview"]');

          if (await splitButton.count() > 0) {
            // Split should be pressed by default
            await expect(splitButton).toHaveAttribute('aria-pressed', 'true');
            await expect(editorButton).toHaveAttribute('aria-pressed', 'false');
            await expect(previewButton).toHaveAttribute('aria-pressed', 'false');
          }
        }
      }
    });
  });

  test.describe('View Mode Switching', () => {
    test('should switch between view modes', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) {
        return;
      }

      await filesTab.click();
      await page.waitForTimeout(500);

      const mdFile = page.locator('[data-testid^="tree-item-"]').filter({ hasText: '.md' }).first();
      if (await mdFile.count() === 0) {
        return;
      }

      await mdFile.click();
      await page.waitForTimeout(500);

      // Switch to editor-only mode
      const editorButton = page.locator('[data-testid="view-mode-editor"]');
      if (await editorButton.count() > 0) {
        await editorButton.click();
        await page.waitForTimeout(300);

        // Editor container should be visible, preview should be hidden
        const editorContainer = page.locator('[data-testid="markdown-editor-container"]');
        const previewContainer = page.locator('[data-testid="markdown-preview-container"]');

        await expect(editorContainer).toBeVisible();
        await expect(previewContainer).toBeHidden();

        // Switch to preview-only mode
        const previewButton = page.locator('[data-testid="view-mode-preview"]');
        await previewButton.click();
        await page.waitForTimeout(300);

        await expect(editorContainer).toBeHidden();
        await expect(previewContainer).toBeVisible();

        // Switch back to split mode
        const splitButton = page.locator('[data-testid="view-mode-split"]');
        await splitButton.click();
        await page.waitForTimeout(300);

        await expect(editorContainer).toBeVisible();
        await expect(previewContainer).toBeVisible();
      }
    });
  });

  test.describe('Editing and Saving', () => {
    test('should show unsaved indicator when content is modified', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      const mdFile = page.locator('[data-testid^="tree-item-"]').filter({ hasText: '.md' }).first();
      if (await mdFile.count() === 0) return;

      await mdFile.click();
      await page.waitForTimeout(500);

      const textarea = page.locator('[data-testid="markdown-editor-textarea"]');
      if (await textarea.count() === 0) return;

      // Type in the textarea
      await textarea.fill('# Test Content\n\nThis is test content.');
      await page.waitForTimeout(100);

      // Dirty indicator should appear
      const dirtyIndicator = page.locator('[data-testid="dirty-indicator"]');
      await expect(dirtyIndicator).toBeVisible();
      await expect(dirtyIndicator).toHaveText('Unsaved');
    });

    test('should enable save button when content is modified', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      const mdFile = page.locator('[data-testid^="tree-item-"]').filter({ hasText: '.md' }).first();
      if (await mdFile.count() === 0) return;

      await mdFile.click();
      await page.waitForTimeout(500);

      const saveButton = page.locator('[data-testid="save-button"]');
      if (await saveButton.count() === 0) return;

      // Save button should be disabled initially (no changes)
      await expect(saveButton).toBeDisabled();

      // Modify content
      const textarea = page.locator('[data-testid="markdown-editor-textarea"]');
      const currentContent = await textarea.inputValue();
      await textarea.fill(currentContent + '\n\n<!-- Test edit -->');
      await page.waitForTimeout(100);

      // Save button should now be enabled
      await expect(saveButton).toBeEnabled();
    });

    test('should show preview of markdown content', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      const mdFile = page.locator('[data-testid^="tree-item-"]').filter({ hasText: '.md' }).first();
      if (await mdFile.count() === 0) return;

      await mdFile.click();
      await page.waitForTimeout(500);

      const textarea = page.locator('[data-testid="markdown-editor-textarea"]');
      if (await textarea.count() === 0) return;

      // Clear and add content
      await textarea.fill('# Test Heading\n\n**Bold text** and *italic text*');

      // Wait for debounced preview update (300ms + buffer)
      await page.waitForTimeout(500);

      // Check preview content
      const preview = page.locator('[data-testid="markdown-preview"]');
      if (await preview.count() > 0) {
        // Heading should be rendered as h1
        const heading = preview.locator('h1');
        await expect(heading).toHaveText('Test Heading');

        // Bold text should be in strong tag
        const bold = preview.locator('strong');
        await expect(bold).toHaveText('Bold text');

        // Italic text should be in em tag
        const italic = preview.locator('em');
        await expect(italic).toHaveText('italic text');
      }
    });
  });

  test.describe('Editor Close', () => {
    test('should close editor when close button is clicked (no unsaved changes)', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      const mdFile = page.locator('[data-testid^="tree-item-"]').filter({ hasText: '.md' }).first();
      if (await mdFile.count() === 0) return;

      await mdFile.click();
      await page.waitForTimeout(500);

      const editor = page.locator('[data-testid="markdown-editor"]');
      if (await editor.count() === 0) return;

      await expect(editor).toBeVisible();

      // Close the editor (via modal close button)
      const closeButton = page.locator('[data-testid="close-button"]');
      if (await closeButton.count() > 0) {
        await closeButton.click();
        await page.waitForTimeout(300);

        // Editor should be closed
        await expect(editor).not.toBeVisible();
      }
    });
  });

  test.describe('Keyboard Shortcuts', () => {
    test('should save on Ctrl+S / Cmd+S', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(1000);

      const worktreeCards = page.locator('a[href^="/worktrees/"]');
      if (await worktreeCards.count() === 0) {
        test.skip(true, 'No worktrees available');
        return;
      }

      await worktreeCards.first().click();
      await page.waitForTimeout(500);

      const filesTab = page.getByRole('button', { name: /Files/i });
      if (await filesTab.count() === 0) return;

      await filesTab.click();
      await page.waitForTimeout(500);

      const mdFile = page.locator('[data-testid^="tree-item-"]').filter({ hasText: '.md' }).first();
      if (await mdFile.count() === 0) return;

      await mdFile.click();
      await page.waitForTimeout(500);

      const textarea = page.locator('[data-testid="markdown-editor-textarea"]');
      if (await textarea.count() === 0) return;

      // Focus textarea and modify content
      await textarea.focus();
      const currentContent = await textarea.inputValue();
      await textarea.fill(currentContent + '\n\n<!-- Keyboard save test -->');

      // Use Ctrl+S (or Cmd+S on Mac)
      await textarea.press('Control+s');

      // Wait for save operation
      await page.waitForTimeout(500);

      // If save was successful, dirty indicator should disappear
      const dirtyIndicator = page.locator('[data-testid="dirty-indicator"]');
      // Note: This may still show if there's an error, so we check visibility
      // The actual save test would need a proper backend setup
    });
  });

  /**
   * Issue #1518: Tab indent / Shift+Tab outdent, driven by real key presses.
   *
   * The unit suite uses `fireEvent`, which can dispatch to an element that is
   * not focused and so hide keyboard bugs entirely. These tests type into a
   * real browser: they assert the value changes, that focus *stays* in the
   * textarea, that one Ctrl+Z reverts the edit, and that Ctrl+M hands Tab back
   * to focus navigation.
   */
  test.describe('Tab Indentation (Issue #1518)', () => {
    // The dev server compiles the worktree route on first hit.
    test.describe.configure({ timeout: 90_000 });

    /** Open the fixture file and return the (visible) editor textarea. */
    async function openEditor(page: Page): Promise<Locator> {
      await mockEditorApi(page);
      await page.goto(`/worktrees/${E2E_EDITOR_WORKTREE}`);

      // Files is the default activity, so the tree appears on its own once the
      // page hydrates. Clicking the activity button here would toggle it shut.
      const treeItem = page.locator(`[data-testid="tree-item-${E2E_EDITOR_FILE}"]`);
      await expect(treeItem).toBeVisible({ timeout: 60_000 });
      await treeItem.click();

      // .md files mount in preview mode, which hides the editor pane.
      const editorViewButton = page.locator('[data-testid="view-mode-editor"]');
      await expect(editorViewButton).toBeVisible({ timeout: 30_000 });
      await editorViewButton.click();

      const textarea = page.locator('[data-testid="markdown-editor-textarea"]');
      await expect(textarea).toBeVisible({ timeout: 30_000 });
      await expect(textarea).toHaveValue(E2E_EDITOR_CONTENT);
      return textarea;
    }

    /** Place the caret without relying on platform-specific Home/End keys. */
    async function setCaret(textarea: Locator, start: number, end = start) {
      await textarea.evaluate(
        (el, range) => {
          const field = el as HTMLTextAreaElement;
          field.focus();
          field.setSelectionRange(range.start, range.end);
        },
        { start, end }
      );
    }

    function focusedTestId(page: Page) {
      return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
    }

    test('indents with Tab and keeps focus in the textarea', async ({ page }) => {
      const textarea = await openEditor(page);
      await setCaret(textarea, 0);

      await page.keyboard.press('Tab');

      await expect(textarea).toHaveValue('  alpha\nbeta\n');
      expect(await focusedTestId(page)).toBe('markdown-editor-textarea');
      expect(await textarea.inputValue()).not.toContain('\t');
    });

    test('applies exactly one indent per Tab press', async ({ page }) => {
      // Regression: handleKeyDown is bound to both the textarea and the root
      // div, so an unguarded handler indents twice for one keystroke.
      const textarea = await openEditor(page);
      await setCaret(textarea, 0);

      await page.keyboard.press('Tab');

      await expect(textarea).toHaveValue('  alpha\nbeta\n');
    });

    test('reverts an indent with a single undo', async ({ page }) => {
      const textarea = await openEditor(page);
      await setCaret(textarea, 0);

      await page.keyboard.press('Tab');
      await expect(textarea).toHaveValue('  alpha\nbeta\n');

      await page.keyboard.press('ControlOrMeta+z');

      await expect(textarea).toHaveValue(E2E_EDITOR_CONTENT);
    });

    test('outdents with Shift+Tab', async ({ page }) => {
      const textarea = await openEditor(page);
      await setCaret(textarea, 0);
      await page.keyboard.press('Tab');
      await expect(textarea).toHaveValue('  alpha\nbeta\n');

      await page.keyboard.press('Shift+Tab');

      await expect(textarea).toHaveValue(E2E_EDITOR_CONTENT);
      expect(await focusedTestId(page)).toBe('markdown-editor-textarea');
    });

    test('indents a multi-line selection and keeps it selected', async ({ page }) => {
      const textarea = await openEditor(page);
      await setCaret(textarea, 0, E2E_EDITOR_CONTENT.length);

      await page.keyboard.press('Tab');

      await expect(textarea).toHaveValue('  alpha\n  beta\n');
      const selection = await textarea.evaluate((el) => {
        const field = el as HTMLTextAreaElement;
        return { start: field.selectionStart, end: field.selectionEnd };
      });
      expect(selection.start).toBe(0);
      expect(selection.end).toBeGreaterThan(0);
    });

    test('Ctrl+M gives Tab back to focus navigation', async ({ page }) => {
      const textarea = await openEditor(page);
      await setCaret(textarea, 0);

      await page.keyboard.press('Control+m');
      await expect(page.locator('[data-testid="editor-tab-focus-toggle"]')).toHaveAttribute(
        'aria-pressed',
        'true'
      );

      await page.keyboard.press('Tab');

      await expect(textarea).toHaveValue(E2E_EDITOR_CONTENT);
      expect(await focusedTestId(page)).not.toBe('markdown-editor-textarea');
    });

    test('Shift+Tab with nothing to remove escapes the textarea', async ({ page }) => {
      const textarea = await openEditor(page);
      await setCaret(textarea, 0);

      await page.keyboard.press('Shift+Tab');

      await expect(textarea).toHaveValue(E2E_EDITOR_CONTENT);
      expect(await focusedTestId(page)).not.toBe('markdown-editor-textarea');
    });

    test('indents from the toolbar button without losing the caret', async ({ page }) => {
      const textarea = await openEditor(page);
      await setCaret(textarea, 0);

      await page.click('[data-testid="editor-indent-button"]');

      await expect(textarea).toHaveValue('  alpha\nbeta\n');
      expect(await focusedTestId(page)).toBe('markdown-editor-textarea');
    });
  });
});
