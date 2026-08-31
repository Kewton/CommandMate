/**
 * FileViewer Component
 *
 * Displays file contents in a modal with syntax highlighting.
 * Supports both text files and image files.
 *
 * Image file handling flow:
 * 1. API returns isImage: true for image files
 * 2. FileViewer detects isImage flag
 * 3. ImageViewer component renders the Base64 data URI
 *
 * Text file features:
 * - Syntax highlighting via language-specific CSS classes
 * - Copy to clipboard with visual feedback (Copy -> Check icon, 2s)
 *
 * @module components/worktree/FileViewer
 */

'use client';

import React, { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { Modal, Spinner } from '@/components/ui';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { FileContent } from '@/types/models';
import { ImageViewer } from './ImageViewer';
import { VideoViewer } from './VideoViewer';
import { PdfPreview } from './PdfPreview';
import { MarkdownPreview } from './MarkdownPreview';
import { MobileFileActionsSheet } from '@/components/mobile/MobileFileActionsSheet';
import type { SandboxLevel } from '@/config/html-extensions';
import { SANDBOX_ATTRIBUTES } from '@/config/html-extensions';
import { copyToClipboard } from '@/lib/clipboard-utils';
import { Copy, Check, Maximize2, Minimize2, ClipboardCopy, Eye, Pencil, Search, X, Download, MoreHorizontal } from 'lucide-react';
import { Z_INDEX } from '@/config/z-index';
import { encodePathForUrl } from '@/lib/url-path-encoder';
import { useFileContentSearch } from '@/hooks/useFileContentSearch';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

/** Loading placeholder while the markdown editor chunk resolves. */
function MarkdownEditorLoading() {
  const t = useTranslations('worktree');
  return (
    <div className="flex h-full items-center justify-center bg-surface text-muted-foreground">
      <Spinner size="lg" className="mr-2" />
      <span>{t('detail.loadingEditor')}</span>
    </div>
  );
}

/**
 * The editor is browser-only (highlight.js / rehype-highlight touch DOM APIs
 * during render), so it follows the same `ssr: false` dynamic-import pattern as
 * the other editor hosts.
 */
const MarkdownEditor = dynamic(
  () =>
    import('@/components/worktree/MarkdownEditor').then((mod) => ({
      default: mod.MarkdownEditor,
    })),
  { ssr: false, loading: () => <MarkdownEditorLoading /> },
);

/** 44px tap target for the unified markdown toolbar (Issue #1127). */
const TOOLBAR_ICON_BUTTON =
  'flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground transition-colors touch-manipulation';

/** MARP frontmatter detection pattern */
const MARP_FRONTMATTER_REGEX = /^---\s*\nmarp:\s*true/;

/** Maximum MARP content length (1MB) */
const MAX_MARP_CONTENT_LENGTH = 1_000_000;

/**
 * [Issue #47, Issue #723] Inline search bar shown beneath the toolbar in both
 * the modal and fullscreen variants of FileViewer. Extracted to remove the
 * verbatim duplication that previously existed at two render paths.
 */
function FileViewerSearchBar({
  searchInputRef,
  searchQuery,
  searchMatches,
  searchCurrentIdx,
  onQueryChange,
  onPrev,
  onNext,
  onClose,
}: {
  searchInputRef: React.RefObject<HTMLInputElement>;
  searchQuery: string;
  searchMatches: number[];
  searchCurrentIdx: number;
  onQueryChange: (value: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('worktree');

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-muted border-b border-border">
      <input
        ref={searchInputRef}
        type="text"
        value={searchQuery}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { onClose(); }
          if (e.key === 'Enter') { if (e.shiftKey) { onPrev(); } else { onNext(); } }
        }}
        placeholder={t('fileSearch.placeholder')}
        className="flex-1 min-w-0 px-2 py-0.5 text-sm bg-surface dark:bg-surface-2 text-foreground border border-input rounded outline-none focus:ring-1 focus:ring-ring"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <span className="text-xs text-muted-foreground min-w-[3rem] text-right">
        {searchMatches.length > 0 ? `${searchCurrentIdx + 1}/${searchMatches.length}` : '0/0'}
      </span>
      <button onClick={onPrev} disabled={searchMatches.length === 0} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-muted-foreground hover:text-foreground disabled:text-muted-foreground" aria-label={t('fileSearch.prevMatch')}>▲</button>
      <button onClick={onNext} disabled={searchMatches.length === 0} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-muted-foreground hover:text-foreground disabled:text-muted-foreground" aria-label={t('fileSearch.nextMatch')}>▼</button>
      <button onClick={onClose} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-muted-foreground hover:text-foreground" aria-label={t('fileSearch.close')}><X className="w-4 h-4" /></button>
    </div>
  );
}

/**
 * [Issue #490] Mobile HTML preview with tab switching (Source/Preview)
 * No split view on mobile due to space constraints.
 */
/**
 * Script injected into interactive mode iframes (mobile) to intercept link clicks.
 * External URLs are opened in a new browser tab via postMessage -> window.open.
 */
const MOBILE_LINK_CLICK_SCRIPT = `
<script>
document.addEventListener('click', function(e) {
  var target = e.target;
  while (target && target.tagName !== 'A') {
    target = target.parentElement;
  }
  if (target && target.href) {
    e.preventDefault();
    parent.postMessage({
      type: 'commandmate:link-click',
      href: target.getAttribute('href')
    }, '*');
  }
});
</script>`;

function HtmlPreviewMobile({
  htmlContent,
  filePath,
}: {
  htmlContent: string;
  filePath: string;
}) {
  const [activeTab, setActiveTab] = useState<'source' | 'preview'>('preview');
  const [sandboxLevel, setSandboxLevel] = useState<SandboxLevel>('safe');
  const confirmedFilesRef = useRef<Set<string>>(new Set());
  const tWorktree = useTranslations('worktree');
  const confirm = useConfirm();

  const handleSandboxChange = useCallback(async (newLevel: SandboxLevel) => {
    if (newLevel === 'interactive' && !confirmedFilesRef.current.has(filePath)) {
      const confirmed = await confirm({
        description: tWorktree('htmlPreview.interactiveModeConfirm'),
      });
      if (!confirmed) return;
      confirmedFilesRef.current.add(filePath);
    }
    setSandboxLevel(newLevel);
  }, [filePath, confirm, tWorktree]);

  // In interactive mode, inject link click script; in safe mode, pass as-is
  const iframeSrcDoc = useMemo(() => {
    if (sandboxLevel !== 'interactive') return htmlContent;
    if (htmlContent.includes('</body>')) {
      return htmlContent.replace('</body>', `${MOBILE_LINK_CLICK_SCRIPT}</body>`);
    }
    return htmlContent + MOBILE_LINK_CLICK_SCRIPT;
  }, [htmlContent, sandboxLevel]);

  // Listen for postMessage from iframe and open external links in new browser tab
  useEffect(() => {
    if (sandboxLevel !== 'interactive') return;

    const handler = (event: MessageEvent) => {
      if (event.origin !== 'null') return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'commandmate:link-click') return;
      if (typeof data.href !== 'string') return;

      const href = data.href;
      if (href.startsWith('http://') || href.startsWith('https://')) {
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [sandboxLevel]);

  const highlightedHtml = useMemo(() => {
    try {
      return hljs.highlight(htmlContent, { language: 'html', ignoreIllegals: true }).value;
    } catch {
      return hljs.highlightAuto(htmlContent).value;
    }
  }, [htmlContent]);

  const lineNumbers = useMemo(
    () => Array.from({ length: htmlContent.split('\n').length }, (_, i) => i + 1),
    [htmlContent],
  );
  const highlightedLines = useMemo(() => highlightedHtml.split('\n'), [highlightedHtml]);

  return (
    <div className="flex flex-col h-full" data-testid="html-preview-mobile">
      {/* Tab bar */}
      <div className="flex items-center justify-between p-1 border-b border-border bg-muted">
        <div className="flex gap-1">
          {(['source', 'preview'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                activeTab === tab
                  ? 'bg-accent-100 dark:bg-accent-900/50 text-accent-700 dark:text-accent-300'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {tab === 'source' ? tWorktree('fileViewer.tabSource') : tWorktree('fileViewer.tabPreview')}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(['safe', 'interactive'] as const).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => handleSandboxChange(level)}
              className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                sandboxLevel === level
                  ? level === 'safe'
                    ? 'bg-success-subtle text-success-foreground'
                    : 'bg-warning-subtle text-warning-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {level === 'safe' ? tWorktree('fileViewer.sandboxSafe') : tWorktree('fileViewer.sandboxInteractive')}
            </button>
          ))}
        </div>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-auto min-h-0">
        {activeTab === 'source' ? (
          <table className="text-sm w-full border-collapse">
            <tbody>
              {lineNumbers.map((lineNumber) => {
                const idx = lineNumber - 1;
                return (
                  <tr key={lineNumber}>
                    <td className="pl-3 pr-2 text-right select-none font-mono border-r border-border bg-muted dark:bg-muted/50 sticky left-0 align-top whitespace-nowrap text-muted-foreground">
                      {lineNumber}
                    </td>
                    <td className="px-4 text-foreground align-top">
                      <pre className="m-0 whitespace-pre-wrap break-words font-mono">
                        <code
                          className="hljs"
                          dangerouslySetInnerHTML={{ __html: highlightedLines[idx] ?? '' }}
                        />
                      </pre>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <iframe
            key={`${filePath}-${sandboxLevel}`}
            srcDoc={iframeSrcDoc}
            sandbox={SANDBOX_ATTRIBUTES[sandboxLevel]}
            title={tWorktree('htmlPreview.title', { path: filePath })}
            className="w-full h-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
}

/** Which surface the unified markdown screen is showing (Issue #1519). */
type MarkdownMode = 'viewer' | 'editor';

export interface FileViewerProps {
  isOpen: boolean;
  onClose: () => void;
  worktreeId: string;
  filePath: string;
  /** Notified after the embedded editor persists the file (Issue #1519) */
  onFileSaved?: (path: string) => void;
  /** Open another file from a relative markdown link (Issue #505) */
  onOpenFile?: (path: string) => void;
}

/**
 * File viewer modal component
 *
 * @example
 * ```tsx
 * <FileViewer
 *   isOpen={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   worktreeId="main"
 *   filePath="src/components/Foo.tsx"
 * />
 * ```
 */
export const FileViewer = memo(function FileViewer({ isOpen, onClose, worktreeId, filePath, onFileSaved, onOpenFile }: FileViewerProps) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two INDEPENDENT confirmations (Issue #2180): content and path each own a
  // timer, so copying the path does not cut the content confirmation short.
  const { copied, markCopied: markContentCopied, reset: resetContentCopied } = useCopyFeedback();
  const { copied: pathCopied, markCopied: markPathCopied } = useCopyFeedback();
  const [marpSlides, setMarpSlides] = useState<string[] | null>(null);
  const [marpCurrentSlide, setMarpCurrentSlide] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // [Issue #1519] Unified markdown screen state.
  const [markdownMode, setMarkdownMode] = useState<MarkdownMode>('viewer');
  const [actionsOpen, setActionsOpen] = useState(false);
  /** Live editor text, mirrored up so the viewer shows unsaved edits too. */
  const [draft, setDraft] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const codeContainerRef = useRef<HTMLDivElement>(null);
  const t = useTranslations('worktree');
  const confirm = useConfirm();

  // [Issue #723] Unified search hook (replaces previously inlined logic at
  // L242-318). Provides debounced (300ms, SEARCH_DEBOUNCE_MS) + minimum-2-char
  // query semantics shared with FilePanelContent.
  /**
   * Text currently on screen: the live editor draft when the user has typed,
   * otherwise the fetched file. Search, copy and the source view all read this
   * so they never disagree with what the editor shows (Issue #1519).
   */
  const sourceText = content ? draft ?? content.content : undefined;

  const {
    searchOpen,
    searchQuery,
    searchMatches,
    searchCurrentIdx,
    searchInputRef,
    openSearch,
    closeSearch,
    nextMatch: nextSearchMatch,
    prevMatch: prevSearchMatch,
    setSearchQuery,
  } = useFileContentSearch(sourceText);

  /** Whether the current content supports clipboard copy (text files only, not image/video/pdf) */
  const canCopy = useMemo(
    () => Boolean(content?.content && !content.isImage && !content.isVideo && !content.isPdf),
    [content]
  );

  /**
   * [Issue #1519] Every `.md` file gets the unified screen: rendered viewer,
   * editor, action sheet and a permanent maximize control on one surface.
   */
  const isUnifiedMarkdown = content?.extension === 'md';

  /**
   * [Issue #162] Copy file content to clipboard.
   * Icon changes from Copy to Check for 2 seconds on success.
   * Failure is silently handled (icon remains unchanged).
   */
  const handleCopy = useCallback(async () => {
    if (!canCopy || !sourceText) return;
    try {
      await copyToClipboard(sourceText);
      markContentCopied();
    } catch {
      // Failure is indicated by icon not changing
    }
  }, [canCopy, sourceText, markContentCopied]);

  /** Copy file path to clipboard */
  const handleCopyPath = useCallback(async () => {
    try {
      await copyToClipboard(filePath);
      markPathCopied();
    } catch {
      // Silent failure
    }
  }, [filePath, markPathCopied]);

  /** Toggle fullscreen mode */
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  /** Scroll to the current match line */
  useEffect(() => {
    if (searchMatches.length === 0 || !codeContainerRef.current) return;
    const lineNum = searchMatches[searchCurrentIdx];
    const lineEl = codeContainerRef.current.querySelector(`[data-line="${lineNum}"]`);
    if (lineEl && typeof lineEl.scrollIntoView === 'function') {
      lineEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [searchCurrentIdx, searchMatches]);

  // ESC to exit fullscreen. The unified markdown screen has its own Escape
  // ladder (search -> maximize -> close), so it opts out here.
  useEffect(() => {
    if (!isFullscreen || isUnifiedMarkdown) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen, isUnifiedMarkdown]);

  useEffect(() => {
    if (!isOpen || !filePath) {
      setContent(null);
      setError(null);
      resetContentCopied();
      setMarkdownMode('viewer');
      setActionsOpen(false);
      setDraft(null);
      setEditorDirty(false);
      closeSearch();
      return;
    }

    setMarkdownMode('viewer');
    setActionsOpen(false);
    setDraft(null);
    setEditorDirty(false);

    const fetchFile = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/worktrees/${worktreeId}/files/${encodePathForUrl(filePath)}`
        );

        if (!response.ok) {
          const errorData = await response.json();
          const errMsg = typeof errorData.error === 'string'
            ? errorData.error
            : errorData.error?.message || t('fileViewer.loadError');
          throw new Error(errMsg);
        }

        const data = await response.json();
        setContent(data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : t('fileViewer.loadError'));
      } finally {
        setLoading(false);
      }
    };

    fetchFile();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- closeSearch and resetContentCopied are stable (they only reset state)
  }, [isOpen, worktreeId, filePath]);

  // Fetch MARP slides when content is a MARP markdown file
  useEffect(() => {
    setMarpSlides(null);
    setMarpCurrentSlide(0);
    if (!content || content.extension !== 'md') return;
    if (!MARP_FRONTMATTER_REGEX.test(content.content)) return;
    if (content.content.length > MAX_MARP_CONTENT_LENGTH) return;

    const fetchMarpSlides = async () => {
      try {
        const response = await fetch(
          `/api/worktrees/${worktreeId}/marp-render`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ markdownContent: content.content }),
          },
        );
        if (response.ok) {
          const data = await response.json();
          setMarpSlides(data.slides);
        }
      } catch {
        // Best-effort; fall back to text
      }
    };

    fetchMarpSlides();
  }, [content, worktreeId]);

  /** Whether the current file is a MARP presentation */
  const isMarp = Boolean(marpSlides && marpSlides.length > 0);

  /**
   * Mirror the editor's live text so the viewer, the search source view and the
   * copy action all reflect unsaved edits.
   */
  const handleEditorContentChange = useCallback((value: string) => {
    setDraft(value);
  }, []);

  /** Adopt what the editor just persisted; the viewer renders it immediately. */
  const handleEditorSaved = useCallback(
    (savedPath: string, savedContent: string) => {
      setContent((prev) => (prev ? { ...prev, content: savedContent } : prev));
      setDraft(savedContent);
      onFileSaved?.(savedPath);
    },
    [onFileSaved]
  );

  /**
   * Close, guarding unsaved editor changes exactly like the standalone editor
   * modal did before the screens merged.
   */
  const requestClose = useCallback(async () => {
    if (editorDirty) {
      const confirmed = await confirm({
        description: t('editor.unsavedCloseConfirm'),
        variant: 'danger',
      });
      if (!confirmed) return;
    }
    onClose();
  }, [editorDirty, confirm, t, onClose]);

  /**
   * Escape ladder for the unified markdown screen, which owns the whole
   * viewport instead of sitting inside `Modal`: dismiss the search bar first,
   * then leave the maximized (chrome-collapsed) view, then close.
   */
  useEffect(() => {
    if (!isUnifiedMarkdown || actionsOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (searchOpen) {
        closeSearch();
      } else if (isFullscreen) {
        setIsFullscreen(false);
      } else {
        void requestClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- closeSearch is stable (only resets state)
  }, [isUnifiedMarkdown, actionsOpen, searchOpen, isFullscreen, requestClose]);

  /**
   * Text the viewer pane renders. It stays mounted behind the editor so its
   * scroll position survives a mode switch, which would otherwise make every
   * keystroke re-parse the whole document off-screen; freezing the input while
   * editing keeps typing cheap and still shows the latest text on the way back.
   */
  const [previewText, setPreviewText] = useState('');
  useEffect(() => {
    if (markdownMode === 'viewer' && sourceText !== undefined) {
      setPreviewText(sourceText);
    }
  }, [markdownMode, sourceText]);

  // The unified screen replaces Modal, so it takes over the body scroll lock.
  useEffect(() => {
    if (!isUnifiedMarkdown || !isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isUnifiedMarkdown, isOpen]);

  const codeViewData = useMemo(() => {
    if (!content || sourceText === undefined || content.isImage || content.isVideo || content.isHtml || content.isPdf) {
      return null;
    }
    const lineNumbers = Array.from(
      { length: sourceText.split('\n').length },
      (_, i) => i + 1,
    );
    try {
      return {
        lineNumbers,
        highlightedHtml: hljs.highlight(sourceText, {
          language: content.extension,
          ignoreIllegals: true,
        }).value,
      };
    } catch {
      return {
        lineNumbers,
        highlightedHtml: hljs.highlightAuto(sourceText).value,
      };
    }
  }, [content, sourceText]);

  /** Render the file content body (non-markdown paths keep the modal layout) */
  const renderContent = () => {
    if (!content) return null;

    if (content.isImage) {
      return <ImageViewer src={content.content} alt={content.path} mimeType={content.mimeType} />;
    }
    if (content.isVideo) {
      return <VideoViewer src={content.content} mimeType={content.mimeType} />;
    }
    // [Issue #673] PDF preview (mobile): iframe variant is blocked by
    // mobile Chrome, so show an open-in-new-tab / download UI instead.
    if (content.isPdf) {
      return (
        <div className="h-full min-h-[40vh]">
          <PdfPreview
            dataUri={content.content}
            filePath={filePath}
            variant="download"
          />
        </div>
      );
    }
    // [Issue #490] HTML preview with mobile tab switching (Source/Preview)
    if (content.isHtml) {
      return (
        <HtmlPreviewMobile
          htmlContent={content.content}
          filePath={filePath}
        />
      );
    }
    return renderSourceTable();
  };

  /** MARP slide deck viewer, shown inside the unified markdown screen. */
  const renderMarpSlides = () => {
    if (!marpSlides) return null;
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between p-2 bg-muted border-b border-border">
          <button
            type="button"
            onClick={() => setMarpCurrentSlide((prev) => Math.max(0, prev - 1))}
            disabled={marpCurrentSlide === 0}
            className="min-h-[44px] px-3 text-sm rounded-md bg-muted disabled:opacity-50 hover:bg-muted/80 transition-colors touch-manipulation"
          >
            {t('actions.prev')}
          </button>
          <span className="text-sm text-muted-foreground">
            {marpCurrentSlide + 1} / {marpSlides.length}
          </span>
          <button
            type="button"
            onClick={() => setMarpCurrentSlide((prev) => Math.min(marpSlides.length - 1, prev + 1))}
            disabled={marpCurrentSlide === marpSlides.length - 1}
            className="min-h-[44px] px-3 text-sm rounded-md bg-muted disabled:opacity-50 hover:bg-muted/80 transition-colors touch-manipulation"
          >
            {t('actions.next')}
          </button>
        </div>
        <iframe
          srcDoc={marpSlides[marpCurrentSlide]}
          sandbox=""
          title={t('fileViewer.slideTitle', { name: filePath, number: marpCurrentSlide + 1 })}
          className="w-full flex-1 border-0"
        />
      </div>
    );
  };

  /** Line-numbered highlighted source with search match highlighting. */
  const renderSourceTable = () => {
    if (!codeViewData) return null;

    const matchSet = new Set(searchMatches);
    const currentMatchLine = searchMatches.length > 0 ? searchMatches[searchCurrentIdx] : -1;

    const highlightedLines = codeViewData.highlightedHtml.split('\n');

    return (
      <div ref={codeContainerRef}>
        <table className="text-sm w-full border-collapse">
          <tbody>
            {codeViewData.lineNumbers.map((lineNumber) => {
              const idx = lineNumber - 1;
              const isCurrent = lineNumber === currentMatchLine;
              const isMatch = matchSet.has(lineNumber);
              const rowBg = isCurrent ? 'bg-warning/30' : isMatch ? 'bg-warning/15' : '';
              return (
                <tr key={lineNumber} data-line={lineNumber} className={rowBg}>
                  <td className={`pl-3 pr-2 text-right select-none font-mono border-r border-border bg-muted dark:bg-muted/50 sticky left-0 align-top whitespace-nowrap ${isCurrent ? 'text-warning-foreground' : isMatch ? 'text-warning-foreground' : 'text-muted-foreground'}`}>
                    {lineNumber}
                  </td>
                  <td className="px-4 text-foreground align-top">
                    <pre className="m-0 whitespace-pre-wrap break-words font-mono">
                      <code
                        className="hljs"
                        dangerouslySetInnerHTML={{ __html: highlightedLines[idx] ?? '' }}
                      />
                    </pre>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  /**
   * [Issue #1024] Download URL / link for the current file.
   *
   * Uses the same `encodePathForUrl` helper and `worktreeId` as the preview
   * fetch above, plus `?download=1` so the server streams the RAW bytes as an
   * attachment (bypassing base64 preview size limits). Rendered independently
   * of `canCopy`/preview success so it is reachable in EVERY state (success,
   * error, oversize FILE_TOO_LARGE, unsupported/binary).
   */
  const downloadUrl = `/api/worktrees/${worktreeId}/files/${encodePathForUrl(filePath)}?download=1`;
  const downloadName = filePath ? filePath.split('/').pop() || filePath : '';

  const renderDownloadLink = (className: string, showLabel = false) => (
    <a
      data-testid="download-file-button"
      href={downloadUrl}
      download={downloadName}
      className={className}
      aria-label={t('actions.downloadFile')}
      title={t('actions.download')}
    >
      <Download className="w-3.5 h-3.5" />
      {showLabel && <span>{t('actions.download')}</span>}
    </a>
  );

  /** Toolbar with path copy, content copy, download, and fullscreen buttons */
  const renderToolbar = () => (
    <div className="bg-muted px-3 py-1.5 border-b border-border flex items-center justify-between gap-2">
      <div className="flex items-center gap-1 min-w-0">
        <button
          onClick={handleCopyPath}
          className="flex-shrink-0 p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          aria-label={t('actions.copyFilePath')}
          title={t('actions.copyPath')}
        >
          {pathCopied ? (
            <Check className="w-3.5 h-3.5 text-success" />
          ) : (
            <ClipboardCopy className="w-3.5 h-3.5" />
          )}
        </button>
        <p className="text-xs text-muted-foreground font-mono truncate">
          {filePath}
        </p>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {/* [Issue #47] File content search button */}
        {canCopy && (
          <button
            onClick={openSearch}
            className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            aria-label={t('actions.searchInFile')}
            title={t('actions.search')}
          >
            <Search className="w-3.5 h-3.5" />
          </button>
        )}
        {canCopy && (
          <button
            data-testid="copy-content-button"
            onClick={handleCopy}
            className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            aria-label={t('actions.copyFileContent')}
            title={t('actions.copyContent')}
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-success" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        {/* [Issue #1024] Download link — always present (not gated on canCopy) */}
        {renderDownloadLink(
          'p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground'
        )}
        <button
          onClick={toggleFullscreen}
          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          aria-label={isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen')}
          title={isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen')}
        >
          {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );

  const renderSearchBar = () => (
    <FileViewerSearchBar
      searchInputRef={searchInputRef}
      searchQuery={searchQuery}
      searchMatches={searchMatches}
      searchCurrentIdx={searchCurrentIdx}
      onQueryChange={setSearchQuery}
      onPrev={prevSearchMatch}
      onNext={nextSearchMatch}
      onClose={closeSearch}
    />
  );

  /**
   * [Issue #1519] Unified markdown screen: one full-height surface holding the
   * rendered viewer, the editor, the action sheet and a permanent maximize
   * control. Replaces the old viewer-modal → editor-modal round trip, which
   * re-fetched the file and could not go back.
   */
  if (isUnifiedMarkdown && content && !loading && !error) {
    const modeButtonClass = (active: boolean) =>
      `flex min-h-[44px] items-center justify-center gap-1 rounded-md px-2 text-xs font-medium touch-manipulation transition-colors ${
        active
          ? 'bg-surface shadow-sm text-accent-600 dark:text-accent-400'
          : 'text-muted-foreground hover:text-foreground'
      }`;

    return (
      <>
        <div
          data-testid="markdown-file-screen"
          role="dialog"
          aria-modal="true"
          aria-label={filePath}
          className="fixed inset-0 flex h-[100dvh] flex-col bg-surface"
          style={{ zIndex: Z_INDEX.MAXIMIZED_EDITOR }}
        >
          {isFullscreen ? (
            /* Maximized: chrome collapses to a floating cluster that still
               offers restore + close, so the screen is never a dead end. */
            <div
              data-testid="markdown-file-immersive-controls"
              className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-lg border border-border bg-surface/90 shadow-sm"
            >
              <button
                type="button"
                data-testid="markdown-file-maximize"
                onClick={toggleFullscreen}
                aria-pressed
                aria-label={t('actions.exitFullscreen')}
                className={TOOLBAR_ICON_BUTTON}
              >
                <Minimize2 className="h-5 w-5" />
              </button>
              <button
                type="button"
                data-testid="markdown-file-close"
                onClick={() => void requestClose()}
                aria-label={t('actions.close')}
                className={TOOLBAR_ICON_BUTTON}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          ) : (
            <div className="flex flex-shrink-0 items-center gap-1 border-b border-border bg-muted px-2">
              <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {filePath}
              </p>
              <div
                data-testid="markdown-file-mode-switch"
                role="group"
                aria-label={t('fileViewer.modeSwitch')}
                className="flex flex-shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5"
              >
                <button
                  type="button"
                  data-testid="markdown-file-mode-viewer"
                  aria-pressed={markdownMode === 'viewer'}
                  onClick={() => setMarkdownMode('viewer')}
                  className={modeButtonClass(markdownMode === 'viewer')}
                >
                  <Eye className="h-4 w-4" />
                  {t('fileViewer.modeViewer')}
                </button>
                <button
                  type="button"
                  data-testid="markdown-file-mode-editor"
                  aria-pressed={markdownMode === 'editor'}
                  onClick={() => setMarkdownMode('editor')}
                  className={modeButtonClass(markdownMode === 'editor')}
                >
                  <Pencil className="h-4 w-4" />
                  {t('fileViewer.modeEditor')}
                </button>
              </div>
              <button
                type="button"
                data-testid="markdown-file-actions-trigger"
                onClick={() => setActionsOpen(true)}
                aria-label={t('fileViewer.moreActions')}
                className={TOOLBAR_ICON_BUTTON}
              >
                <MoreHorizontal className="h-5 w-5" />
              </button>
              <button
                type="button"
                data-testid="markdown-file-maximize"
                onClick={toggleFullscreen}
                aria-pressed={false}
                aria-label={t('actions.fullscreen')}
                className={TOOLBAR_ICON_BUTTON}
              >
                <Maximize2 className="h-5 w-5" />
              </button>
              <button
                type="button"
                data-testid="markdown-file-close"
                onClick={() => void requestClose()}
                aria-label={t('actions.close')}
                className={TOOLBAR_ICON_BUTTON}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          )}

          {searchOpen && <div className="flex-shrink-0">{renderSearchBar()}</div>}

          <div className="flex min-h-0 flex-1 flex-col">
            <div className={markdownMode === 'viewer' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
              {searchOpen ? (
                /* Search needs line anchors to scroll to, so it shows the
                   highlighted source; closing it returns to the rendered view. */
                <div className="min-h-0 flex-1 overflow-auto">{renderSourceTable()}</div>
              ) : isMarp ? (
                renderMarpSlides()
              ) : (
                <div
                  data-testid="markdown-file-preview"
                  className="prose prose-sm dark:prose-invert min-h-0 max-w-none flex-1 overflow-y-auto p-4"
                >
                  <MarkdownPreview
                    content={previewText}
                    currentFilePath={filePath}
                    worktreeId={worktreeId}
                    onOpenFile={onOpenFile}
                  />
                </div>
              )}
            </div>
            {/* The editor stays mounted across mode switches so an unsaved
                draft survives a trip to the viewer and back. */}
            <div
              data-testid="markdown-file-editor"
              className={markdownMode === 'editor' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
            >
              <MarkdownEditor
                key={filePath}
                worktreeId={worktreeId}
                filePath={filePath}
                initialContent={content.content}
                embedded
                onSave={handleEditorSaved}
                onDirtyChange={setEditorDirty}
                onContentChange={handleEditorContentChange}
                onOpenFile={onOpenFile}
              />
            </div>
          </div>

          {/* Must stay INSIDE this screen. The screen is fixed at
              Z_INDEX.MAXIMIZED_EDITOR (55) with an opaque background, so the
              sheet's own z-50 only outranks the document body while it shares
              this stacking context. Rendered as a sibling it paints *behind*
              the screen: every row stays in the a11y tree but hit-testing
              lands on the markdown content, so all four actions are dead
              (#1528). jsdom has no paint order, so only a real-browser e2e
              catches a regression here. */}
          <MobileFileActionsSheet
            open={actionsOpen}
            onClose={() => setActionsOpen(false)}
            onSearch={() => {
              setMarkdownMode('viewer');
              openSearch();
            }}
            onCopyContent={handleCopy}
            onCopyPath={handleCopyPath}
            downloadUrl={downloadUrl}
            downloadName={downloadName}
            contentCopied={copied}
            pathCopied={pathCopied}
          />
        </div>
      </>
    );
  }

  // Fullscreen mode: render as fixed overlay instead of modal
  if (isFullscreen && content && !loading && !error) {
    return (
      <div
        className="fixed inset-0 bg-surface flex flex-col"
        style={{ zIndex: Z_INDEX.MAXIMIZED_EDITOR }}
      >
        {renderToolbar()}
        {/* [Issue #47] File content search bar (fullscreen) */}
        {searchOpen && renderSearchBar()}
        <div className="flex-1 overflow-auto">
          {renderContent()}
        </div>
      </div>
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={filePath}
      size="xl"
    >
      <div className="max-h-[60vh] sm:max-h-[70vh] flex flex-col">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Spinner size="xl" variant="accent" />
            <p className="ml-3 text-muted-foreground">{t('fileViewer.loading')}</p>
          </div>
        )}

        {error && (
          <div className="bg-danger-subtle border border-danger-border rounded-lg p-4">
            <div className="flex items-center gap-2">
              <svg
                className="w-5 h-5 text-danger-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="text-sm text-danger-foreground">{error}</p>
            </div>
            {/* [Issue #1024] DL stays reachable even when preview fails
                (e.g. oversize FILE_TOO_LARGE / unsupported / read error). */}
            <div className="mt-3">
              {renderDownloadLink(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-surface border border-border text-foreground hover:bg-muted transition-colors',
                true
              )}
            </div>
          </div>
        )}

        {content && !loading && !error && (
          <div className="bg-muted rounded-lg overflow-hidden flex flex-col min-h-0 flex-1">
            {/* Fixed header: toolbar + search bar */}
            <div className="flex-shrink-0">
              {renderToolbar()}
              {/* [Issue #47] File content search bar */}
              {searchOpen && renderSearchBar()}
            </div>
            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto min-h-0">
              {renderContent()}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
});
