/**
 * ImageViewer Component
 * Displays image files in the file viewer modal
 *
 * [KISS] Uses simple img tag instead of next/image
 * Base64 data URI images don't benefit from next/image optimization
 *
 * Display constraints:
 * - Maximum width: 100%
 * - Maximum height: 500px
 * - Object fit: contain (preserves aspect ratio)
 */

'use client';

import React, { useState } from 'react';

export interface ImageViewerProps {
  /** Image source (Base64 data URI) */
  src: string;
  /** Alt text for the image (typically filename) */
  alt: string;
  /** MIME type of the image (for future use) */
  mimeType?: string;
  /** Callback when image fails to load */
  onError?: () => void;
}

/**
 * Image viewer component
 *
 * @example
 * ```tsx
 * <ImageViewer
 *   src="data:image/png;base64,..."
 *   alt="screenshot.png"
 *   mimeType="image/png"
 *   onError={() => console.error('Failed to load image')}
 * />
 * ```
 */
export function ImageViewer({ src, alt, onError }: ImageViewerProps) {
  const [hasError, setHasError] = useState(false);

  const handleError = () => {
    setHasError(true);
    onError?.();
  };

  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-500">
        <svg
          className="w-16 h-16 mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <p className="text-sm">Failed to load image</p>
        <p className="text-xs text-gray-400 mt-1">{alt}</p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center p-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onError={handleError}
        style={{
          maxWidth: '100%',
          maxHeight: '500px',
          objectFit: 'contain',
        }}
        className="rounded-lg shadow-sm"
      />
    </div>
  );
}
