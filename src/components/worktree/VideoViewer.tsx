/**
 * VideoViewer Component
 * Displays video files in the file viewer with HTML5 video player
 *
 * Issue #302: mp4 file upload and playback support
 *
 * [KISS] Uses simple HTML5 video tag
 * Base64 data URI videos don't benefit from complex player libraries
 *
 * Follows the same pattern as ImageViewer.tsx for consistency.
 *
 * Display constraints:
 * - Maximum width: 100%
 * - Maximum height: 500px
 * - HTML5 video controls enabled
 */

'use client';

import React, { useState } from 'react';

export interface VideoViewerProps {
  /** Video source (Base64 data URI) */
  src: string;
  /** MIME type of the video (for future use) */
  mimeType?: string;
  /** Callback when video fails to load */
  onError?: () => void;
}

/**
 * Video viewer component with loading indicator and error fallback
 *
 * @example
 * ```tsx
 * <VideoViewer
 *   src="data:video/mp4;base64,..."
 *   mimeType="video/mp4"
 *   onError={() => console.error('Failed to load video')}
 * />
 * ```
 */
export function VideoViewer({ src, onError }: VideoViewerProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const handleLoadedData = () => {
    setIsLoading(false);
  };

  const handleError = () => {
    setIsLoading(false);
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
            d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
        <p className="text-sm">Failed to load video</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center p-4">
      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600" />
          <p className="ml-3 text-gray-600">Loading video...</p>
        </div>
      )}
      {/* [KISS] src on <video> is sufficient; <source> would be redundant for a single format */}
      <video
        controls
        src={src}
        onLoadedData={handleLoadedData}
        onError={handleError}
        style={{
          maxWidth: '100%',
          maxHeight: '500px',
          display: isLoading ? 'none' : 'block',
        }}
        className="rounded-lg shadow-sm"
      >
        Your browser does not support the video tag.
      </video>
    </div>
  );
}
