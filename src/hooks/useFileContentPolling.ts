/**
 * useFileContentPolling Hook
 *
 * Manages polling for file content updates using HTTP conditional requests.
 * Uses If-Modified-Since / 304 Not Modified for efficient change detection.
 *
 * Issue #469: File auto-update (external change detection)
 */

'use client';

import { useRef } from 'react';
import { useFilePolling } from '@/hooks/useFilePolling';
import { FILE_CONTENT_POLL_INTERVAL_MS } from '@/config/file-polling-config';
import { POLLING_DISABLED_THRESHOLD_BYTES } from '@/config/file-viewer-config';
import { encodePathForUrl } from '@/lib/url-path-encoder';
import type { FileTab } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';

export interface UseFileContentPollingOptions {
  /** The file tab to poll for updates */
  tab: FileTab;
  /** Worktree ID for API URL construction */
  worktreeId: string;
  /** Callback invoked when new content is available */
  onLoadContent: (path: string, data: FileContent) => void;
}

/**
 * Decide whether the polling effect should run for the given tab.
 *
 * Polling is disabled when:
 * - content has not loaded yet (`null`), the tab is loading, or the user is
 *   actively editing (`isDirty`);
 * - the content is a PDF (Issue #673 — Base64 payloads are too costly to refetch);
 * - the file size exceeds {@link POLLING_DISABLED_THRESHOLD_BYTES} (Issue #723).
 *
 * `totalBytes === undefined` keeps polling enabled for backward compatibility
 * with pre-Issue #723 callers that never reported size.
 */
function isPollingEnabled(tab: FileTab): boolean {
  if (tab.content === null || tab.loading || tab.isDirty) return false;
  if (tab.content.isPdf) return false;
  const { totalBytes } = tab.content;
  if (totalBytes !== undefined && totalBytes >= POLLING_DISABLED_THRESHOLD_BYTES) {
    return false;
  }
  return true;
}

/**
 * Custom hook for polling file content changes.
 *
 * - Polls at FILE_CONTENT_POLL_INTERVAL_MS intervals
 * - Uses If-Modified-Since header for efficient 304 responses
 * - Disabled when isDirty (user editing), content is null, or loading
 * - lastModifiedRef starts as null (first request has no If-Modified-Since)
 */
export function useFileContentPolling({
  tab,
  worktreeId,
  onLoadContent,
}: UseFileContentPollingOptions): void {
  // Initial null: first request has no If-Modified-Since header (always gets 200)
  const lastModifiedRef = useRef<string | null>(null);
  const onLoadContentRef = useRef(onLoadContent);
  onLoadContentRef.current = onLoadContent;
  const tabPathRef = useRef(tab.path);
  tabPathRef.current = tab.path;

  // Polling is enabled only when the tab is in a "settled" state and the file
  // is small enough to refetch cheaply. See {@link isPollingEnabled}.
  const pollingEnabled = isPollingEnabled(tab);

  useFilePolling({
    intervalMs: FILE_CONTENT_POLL_INTERVAL_MS,
    enabled: pollingEnabled,
    onPoll: async () => {
      const url = `/api/worktrees/${worktreeId}/files/${encodePathForUrl(tabPathRef.current)}`;
      const headers: Record<string, string> = {};
      if (lastModifiedRef.current) {
        headers['If-Modified-Since'] = lastModifiedRef.current;
      }

      try {
        const response = await fetch(url, { headers });

        if (response.status === 304) return; // No changes
        if (!response.ok) return; // Ignore errors in polling

        lastModifiedRef.current = response.headers.get('Last-Modified');
        const data: FileContent = await response.json();
        onLoadContentRef.current(tabPathRef.current, data);
      } catch {
        // Silently ignore network errors during polling
      }
    },
  });
}
