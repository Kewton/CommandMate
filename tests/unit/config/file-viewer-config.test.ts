/**
 * File Viewer Configuration Tests (Issue #723)
 *
 * TDD: Red -> Green -> Refactor
 */

import { describe, it, expect } from 'vitest';
import {
  VIEWER_CHUNK_LINE_SIZE,
  VIEWER_OVERSCAN_LINES,
  POLLING_DISABLED_THRESHOLD_BYTES,
} from '@/config/file-viewer-config';

describe('file-viewer-config (Issue #723)', () => {
  it('VIEWER_CHUNK_LINE_SIZE should be 500', () => {
    expect(VIEWER_CHUNK_LINE_SIZE).toBe(500);
  });

  it('VIEWER_OVERSCAN_LINES should be 100', () => {
    expect(VIEWER_OVERSCAN_LINES).toBe(100);
  });

  it('POLLING_DISABLED_THRESHOLD_BYTES should be 1MB', () => {
    expect(POLLING_DISABLED_THRESHOLD_BYTES).toBe(1 * 1024 * 1024);
  });

  it('VIEWER_OVERSCAN_LINES should be less than VIEWER_CHUNK_LINE_SIZE', () => {
    expect(VIEWER_OVERSCAN_LINES).toBeLessThan(VIEWER_CHUNK_LINE_SIZE);
  });
});
