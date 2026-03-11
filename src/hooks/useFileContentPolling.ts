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

  useFilePolling({
    intervalMs: FILE_CONTENT_POLL_INTERVAL_MS,
    enabled: tab.content !== null && !tab.loading && !tab.isDirty,
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
