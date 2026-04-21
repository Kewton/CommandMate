/**
 * PdfPreview Component
 * Issue #673: PDF viewer implementation
 *
 * Renders a PDF inside an iframe by:
 *   1. Fetching the incoming Base64 data URI into a Blob
 *   2. Creating a Blob URL via `URL.createObjectURL`
 *   3. Pointing an iframe with `sandbox="allow-scripts"` at the Blob URL
 *
 * Security:
 *   - The iframe uses `sandbox="allow-scripts"` without `allow-same-origin`,
 *     putting the PDF in an opaque origin so that even if embedded scripts
 *     were to run, they cannot read cookies/storage from the host document.
 *   - CSP `frame-src 'self' blob:` (see next.config.js) explicitly allows
 *     `blob:` URIs required by this component.
 *
 * UX:
 *   - Shows a loading indicator until the Blob URL is ready.
 *   - On fetch failure, falls back to a download link pointing at the
 *     original data URI.
 */

'use client';

import React, { useEffect, useState } from 'react';
import { PDF_IFRAME_SANDBOX } from '@/config/pdf-extensions';

export interface PdfPreviewProps {
  /** Base64 data URI (`data:application/pdf;base64,...`) returned by the API */
  dataUri: string;
  /** Relative file path (used for iframe title and download link name) */
  filePath: string;
  /** Optional file size in bytes (reserved for future UI display) */
  sizeBytes?: number;
}

/**
 * Core PDF preview: Blob URL + iframe.
 */
export function PdfPreview({ dataUri, filePath }: PdfPreviewProps): React.JSX.Element {
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
