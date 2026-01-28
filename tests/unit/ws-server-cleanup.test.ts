/**
 * WebSocket server cleanup unit tests
 * Issue #69: Repository delete feature
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to test cleanupRooms function behavior
// Since ws-server uses global state, we test through the exported functions

describe('WebSocket Server cleanupRooms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should be exported from ws-server', async () => {
    const wsServer = await import('@/lib/ws-server');
    expect(typeof wsServer.cleanupRooms).toBe('function');
  });

  it('should accept an array of worktree IDs', async () => {
    const wsServer = await import('@/lib/ws-server');

    // cleanupRooms should not throw when called with empty array
    expect(() => wsServer.cleanupRooms([])).not.toThrow();
  });

  it('should handle non-existent rooms gracefully', async () => {
    const wsServer = await import('@/lib/ws-server');

    // Should not throw when cleaning up rooms that don't exist
    expect(() => wsServer.cleanupRooms(['non-existent-1', 'non-existent-2'])).not.toThrow();
  });
});
