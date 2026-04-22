/**
 * PdfPreview Component
 * Issue #673: PDF viewer implementation
 *
 * Variants:
 *   - `iframe` (default, desktop): embeds the PDF via a Blob URL iframe.
 *     Desktop Chrome/Firefox render it with their built-in viewer.
 *   - `download`: shows "Open" / "Download" buttons wired to a Blob URL.
 *     Required on mobile Chrome, which lacks an in-page PDF viewer and
 *     blocks iframe-loaded PDFs ("このコンテンツはブロックされました").
 *
 * Security:
 *   - iframe variant: no `sandbox` attribute. Chrome's built-in PDF viewer
 *     runs via a MIME-handler navigation that conflicts with *any* sandbox
 *     value; see `PDF_IFRAME_SANDBOX` docs for the full rationale.
 *   - Clickjacking protection is enforced at the host page level via
 *     `X-Frame-Options: SAMEORIGIN` + CSP `frame-ancestors 'self'`.
 *   - CSP `frame-src 'self' blob:` / `connect-src 'self' data:` in
 *     next.config.js allow the Blob and data: fetches this component needs.
 *
 * UX:
 *   - Shows a loading indicator until the Blob URL is ready.
 *   - On fetch failure, falls back to a download link pointing at the
 *     original data URI.
 */

'use client';

import React, { useEffect, useState } from 'react';
import { PDF_IFRAME_SANDBOX } from '@/config/pdf-extensions';

export type PdfPreviewVariant = 'iframe' | 'download';

export interface PdfPreviewProps {
  /** Base64 data URI (`data:application/pdf;base64,...`) returned by the API */
  dataUri: string;
  /** Relative file path (used for iframe title and download link name) */
  filePath: string;
  /** Optional file size in bytes (reserved for future UI display) */
  sizeBytes?: number;
  /**
   * Rendering variant. Defaults to `iframe` for desktop.
   * Pass `download` on mobile where in-page PDF rendering is unreliable.
   */
  variant?: PdfPreviewVariant;
}

/**
 * Core PDF preview: Blob URL + iframe (desktop) or Blob URL + buttons (mobile).
 */
export function PdfPreview({ dataUri, filePath, variant = 'iframe' }: PdfPreviewProps): React.JSX.Element {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let currentUrl: string | null = null;

    setBlobUrl(null);
    setHasError(false);

    (async () => {
      try {
        const response = await fetch(dataUri);
        if (!response.ok) {
          throw new Error(`fetch failed: ${response.status}`);
        }
        const blob = await response.blob();
        if (cancelled) return;
        currentUrl = URL.createObjectURL(blob);
        setBlobUrl(currentUrl);
      } catch {
        if (cancelled) return;
        setHasError(true);
      }
    })();

    return () => {
      cancelled = true;
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl);
      }
    };
  }, [dataUri, filePath]);

  if (hasError) {
    return (
      <div
        className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center"
        data-testid="pdf-preview-error"
      >
        <p className="text-sm text-red-600 dark:text-red-400">
          PDFプレビューを読み込めませんでした。
        </p>
        <a
          href={dataUri}
          download={filePath.split('/').pop() || 'document.pdf'}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
          rel="noopener"
        >
          Download PDF
        </a>
      </div>
    );
  }

  if (!blobUrl) {
    return (
      <div
        className="h-full flex items-center justify-center"
        data-testid="pdf-preview-loading"
      >
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 dark:border-gray-600 border-t-cyan-600 dark:border-t-cyan-400" />
      </div>
    );
  }

  if (variant === 'download') {
    const fileName = filePath.split('/').pop() || 'document.pdf';
    return (
      <div
        className="h-full flex flex-col items-center justify-center gap-4 p-6 text-center"
        data-testid="pdf-preview-download"
      >
        <svg
          className="w-16 h-16 text-gray-400 dark:text-gray-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <p className="text-sm text-gray-700 dark:text-gray-300 break-all">
          {fileName}
        </p>
        <div className="flex flex-col gap-2 w-full max-w-xs">
          <a
            href={blobUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-cyan-600 hover:bg-cyan-700 active:bg-cyan-800 text-white text-sm font-medium transition-colors"
          >
            PDFを新しいタブで開く
          </a>
          <a
            href={blobUrl}
            download={fileName}
            className="inline-flex items-center justify-center gap-2 px-6 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            ダウンロード
          </a>
        </div>
      </div>
    );
  }

  return (
    <iframe
      src={blobUrl}
      sandbox={PDF_IFRAME_SANDBOX}
      title={`PDF Preview: ${filePath}`}
      className="w-full h-full border-0 bg-white"
      data-testid="pdf-preview-iframe"
    />
  );
}

export default PdfPreview;
