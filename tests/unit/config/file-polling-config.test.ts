/**
 * Unit Tests for file polling configuration constants
 *
 * Issue #469: File auto-update (external change detection)
 */

import { describe, it, expect } from 'vitest';
import {
  FILE_TREE_POLL_INTERVAL_MS,
  FILE_CONTENT_POLL_INTERVAL_MS,
} from '@/config/file-polling-config';

describe('file-polling-config', () => {
  it('FILE_TREE_POLL_INTERVAL_MS should be 5000', () => {
    expect(FILE_TREE_POLL_INTERVAL_MS).toBe(5000);
  });

  it('FILE_CONTENT_POLL_INTERVAL_MS should be 5000', () => {
    expect(FILE_CONTENT_POLL_INTERVAL_MS).toBe(5000);
  });

  it('polling intervals should be positive numbers', () => {
    expect(FILE_TREE_POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(FILE_CONTENT_POLL_INTERVAL_MS).toBeGreaterThan(0);
  });
});
