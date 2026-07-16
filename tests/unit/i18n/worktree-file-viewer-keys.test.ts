/**
 * Unit-level i18n guard for the worktree file viewer/editor keys (Issue #1275).
 *
 * The global next-intl mock (tests/setup.ts) echoes `namespace.key` back, so a
 * component test asserting a label stays green even when the real dictionary
 * has no such entry — the blind spot #1197 found and #1273 re-proved. These
 * checks read locales/<locale>/worktree.json directly so a one-sided locale
 * edit or a dropped key fails the required `npm run test:unit` gate.
 *
 * The en/ja parity check for the whole namespace lives in an integration test
 * that the unit gate does not run, hence the section-scoped duplicate here.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadWorktree(locale: string): Record<string, unknown> {
  const filePath = path.join(LOCALES_DIR, locale, 'worktree.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function leafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return leafKeys(value as Record<string, unknown>, full);
    }
    return [full];
  });
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
}

/** Sections Issue #1275 introduced or extended for the file viewer/editor surface. */
const SECTIONS = [
  'actions',
  'fileSearch',
  'fileTree',
  'fileViewer',
  'fileTabs',
  'editor',
  'markdownPreview',
  'mermaid',
  'imageViewer',
  'videoViewer',
  'logViewer',
  'pdfPreview',
  'htmlPreview',
  'diffViewer',
  'search',
] as const;

/**
 * English wording pinned byte-for-byte against the pre-migration markup.
 *
 * Issue #1275 migrated these from hardcoded JSX to `worktree.*`. The migration
 * must be display-neutral in English, so any drift here is a user-visible
 * regression rather than an intended copy change — exactly what the mocked
 * `t()` in component tests can never catch.
 */
const EN_PINNED: Record<string, string> = {
  'actions.copyPath': 'Copy path',
  'actions.copyContent': 'Copy content',
  'actions.copyFilePath': 'Copy file path',
  'actions.copyFileContent': 'Copy file content',
  'actions.search': 'Search',
  'actions.searchInFile': 'Search in file',
  'actions.edit': 'Edit',
  'actions.editFile': 'Edit file',
  'actions.download': 'Download',
  'actions.downloadFile': 'Download file',
  'actions.close': 'Close',
  'actions.save': 'Save',
  'actions.saving': 'Saving...',
  'actions.saved': 'Saved',
  'actions.prev': 'Prev',
  'actions.next': 'Next',
  'actions.fullscreen': 'Fullscreen',
  'actions.exitFullscreen': 'Exit fullscreen',
  'actions.minimize': 'Minimize',
  'actions.maximize': 'Maximize',
  'fileTree.loading': 'Loading files',
  'fileTree.empty': 'No files found',
  'fileTree.newFile': 'New File',
  'fileTree.newDirectory': 'New Directory',
  'fileTree.noResultsMatching': 'No files matching "{query}"',
  'fileTree.noResultsContaining': 'No files containing "{query}"',
  'fileTree.label': 'File tree',
  'fileTree.refreshing': 'Refreshing files',
  'fileTree.refreshLabel': 'Refresh file tree',
  'fileTree.resetViewLabel': 'Reset file tree view',
  'fileTree.loadError': 'Failed to load files',
  'fileTree.itemCount': '{count} items',
  'fileViewer.loading': 'Loading file...',
  'fileViewer.loadError': 'Failed to load file',
  'fileViewer.tabSource': 'Source',
  'fileViewer.tabPreview': 'Preview',
  'fileViewer.sandboxSafe': 'Safe',
  'fileViewer.sandboxInteractive': 'Interactive',
  'fileViewer.noSlides': 'No slides found in {fileName}',
  'fileViewer.slides': 'Slides',
  'fileViewer.editor': 'Editor',
  'fileTabs.unsavedChanges': 'Unsaved changes',
  'editor.loading': 'Loading...',
  'editor.placeholder': 'Start typing...',
  'editor.placeholderMarkdown': 'Start typing markdown...',
  'editor.saveSuccess': 'File saved successfully',
  'editor.saveError': 'Failed to save file',
  'editor.loadError': 'Failed to load file',
  'editor.sessionExpired': 'Session expired. Please re-login.',
  'editor.autoSaveFailed': 'Auto-save failed. Switched to manual save.',
  'editor.unsaved': 'Unsaved',
  'editor.auto': 'Auto',
  'editor.splitView': 'Split view',
  'editor.editorOnly': 'Editor only',
  'editor.previewOnly': 'Preview only',
  'editor.enterFullscreen': 'Enter fullscreen (Ctrl+Shift+F)',
  'editor.exitFullscreen': 'Exit fullscreen (ESC)',
  'markdownPreview.loadingImage': '[loading image...]',
  'markdownPreview.editor': 'Editor',
  'markdownPreview.preview': 'Preview',
  'markdownPreview.exitFullscreenHint': 'Press ESC to exit fullscreen',
  'markdownPreview.exitFullscreenHintSwipe': '(or swipe down)',
  'markdownPreview.largeFileWarning': 'Large file: Performance may be affected.',
  'mermaid.rendering': 'Rendering diagram...',
  'mermaid.loading': 'Loading diagram...',
  'mermaid.errorTitle': 'Diagram Error',
  'mermaid.emptyCode': 'Diagram code is empty',
  'mermaid.renderError': 'Failed to render diagram',
  'imageViewer.loadError': 'Failed to load image',
  'videoViewer.loadError': 'Failed to load video',
  'videoViewer.loading': 'Loading video...',
  'videoViewer.unsupported': 'Your browser does not support the video tag.',
  'logViewer.title': 'Log Files',
  'logViewer.empty': 'No log files found',
  'logViewer.copyTitle': 'Copy sanitized log to clipboard',
  'logViewer.export': 'Export',
  'logViewer.exporting': 'Exporting...',
  'logViewer.copied': 'Log copied to clipboard (sanitized)',
  'logViewer.searchPlaceholder': 'Search in log file...',
  'logViewer.prevMatch': 'Previous match (Shift+Enter)',
  'logViewer.nextMatch': 'Next match (Enter)',
  'logViewer.noMatches': 'No matches found for "{query}"',
  'pdfPreview.downloadPdf': 'Download PDF',
  'htmlPreview.modeSource': 'Source',
  'htmlPreview.modePreview': 'Preview',
  'htmlPreview.modeSplit': 'Split',
  'htmlPreview.sandboxSafe': 'Safe',
  'htmlPreview.sandboxInteractive': 'Interactive',
  'diffViewer.badge': 'DIFF',
  'diffViewer.close': 'Close diff view',
  'search.searching': 'Searching...',
  'search.placeholder': 'Search files...',
  'search.label': 'Search files',
  'search.clear': 'Clear search',
  'search.mode': 'Mode:',
  'search.modeName': 'Name',
  'search.modeContent': 'Content',
};

/**
 * Strings that were hardcoded *Japanese* before this Issue, so English users
 * were shown Japanese. There is no pre-migration English to stay faithful to —
 * these EN values are new by necessity, and ja must keep the original wording
 * byte-for-byte instead.
 */
const JA_PINNED: Record<string, string> = {
  'actions.retry': '再試行',
  'actions.refresh': '更新',
  'actions.resetView': '表示をリセット',
  'fileSearch.placeholder': '検索...',
  'fileSearch.prevMatch': '前の結果',
  'fileSearch.nextMatch': '次の結果',
  'fileSearch.close': '検索を閉じる',
  'pdfPreview.loadError': 'PDFプレビューを読み込めませんでした。',
  'pdfPreview.openInNewTab': 'PDFを新しいタブで開く',
  'pdfPreview.download': 'ダウンロード',
};

describe('worktree file viewer i18n keys (Issue #1275)', () => {
  it.each(['en', 'ja'])('%s/worktree.json defines every guarded section', (locale) => {
    const dict = loadWorktree(locale);
    for (const section of SECTIONS) {
      expect(dict[section], `${locale}: missing section "${section}"`).toBeDefined();
    }
  });

  it.each(['en', 'ja'])('%s/worktree.json has a non-empty string at every leaf', (locale) => {
    const dict = loadWorktree(locale);
    for (const section of SECTIONS) {
      const sub = dict[section] as Record<string, unknown>;
      for (const key of leafKeys(sub)) {
        const value = resolve(sub, key);
        expect(typeof value, `${locale}: ${section}.${key} is not a string`).toBe('string');
        expect((value as string).trim(), `${locale}: ${section}.${key} is empty`).not.toBe('');
      }
    }
  });

  it('en and ja expose the same key set for every guarded section (parity)', () => {
    const en = loadWorktree('en');
    const ja = loadWorktree('ja');
    for (const section of SECTIONS) {
      const enKeys = leafKeys(en[section] as Record<string, unknown>).sort();
      const jaKeys = leafKeys(ja[section] as Record<string, unknown>).sort();
      expect(jaKeys, `parity mismatch in section "${section}"`).toEqual(enKeys);
    }
  });

  it('en wording stays byte-identical to the pre-migration markup', () => {
    const en = loadWorktree('en');
    for (const [key, expected] of Object.entries(EN_PINNED)) {
      expect(resolve(en, key), `en drift at ${key}`).toBe(expected);
    }
  });

  it('ja keeps the wording that was hardcoded in Japanese before the migration', () => {
    const ja = loadWorktree('ja');
    for (const [key, expected] of Object.entries(JA_PINNED)) {
      expect(resolve(ja, key), `ja drift at ${key}`).toBe(expected);
    }
  });

  it('ja is actually translated, not an English copy', () => {
    const en = loadWorktree('en');
    const ja = loadWorktree('ja');
    // Product nouns and format-only values legitimately match across locales.
    const ALLOWED_IDENTICAL = new Set([
      'diffViewer.badge',
      'logViewer.toolCount',
      'editor.enterFullscreen',
      'editor.exitFullscreen',
    ]);
    const identical: string[] = [];
    for (const section of SECTIONS) {
      for (const key of leafKeys(en[section] as Record<string, unknown>)) {
        const full = `${section}.${key}`;
        if (ALLOWED_IDENTICAL.has(full)) continue;
        if (resolve(en, full) === resolve(ja, full)) identical.push(full);
      }
    }
    expect(identical, 'ja values identical to en (untranslated)').toEqual([]);
  });
});
