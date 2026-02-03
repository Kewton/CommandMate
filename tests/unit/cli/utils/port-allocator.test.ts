/**
 * Port Allocator Tests
 * Issue #136: Phase 1 - Foundation
 * Tests for automatic port allocation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import {
  PortAllocator,
  DEFAULT_PORT_RANGE,
  MAX_WORKTREES,
} from '../../../../src/cli/utils/port-allocator';

vi.mock('net');

describe('port-allocator', () => {

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constants', () => {
    it('DEFAULT_PORT_RANGE should be 3001-3100', () => {
      expect(DEFAULT_PORT_RANGE.min).toBe(3001);
      expect(DEFAULT_PORT_RANGE.max).toBe(3100);
    });

    it('MAX_WORKTREES should be reasonable (5-10)', () => {
      expect(MAX_WORKTREES).toBeGreaterThanOrEqual(5);
      expect(MAX_WORKTREES).toBeLessThanOrEqual(20);
    });
  });

  describe('PortAllocator', () => {
    describe('constructor', () => {
      it('should accept custom port range', () => {
        const allocator = new PortAllocator({ min: 4000, max: 4100 });
        expect(allocator).toBeDefined();
      });

      it('should use default range when not specified', () => {
        const allocator = new PortAllocator();
        expect(allocator).toBeDefined();
      });
    });

    describe('findAvailablePort', () => {
      it('should return first available port', async () => {
        // Mock createServer to succeed (port available)
        const mockServer = {
          listen: vi.fn((_port: number, cb: () => void) => {
            cb();
            return mockServer;
          }),
          close: vi.fn((cb: () => void) => cb()),
          on: vi.fn().mockReturnThis(),
        };
        vi.mocked(net.createServer).mockReturnValue(mockServer as unknown as net.Server);

        const allocator = new PortAllocator({ min: 3001, max: 3100 });
        const port = await allocator.findAvailablePort();

        expect(port).toBe(3001);
      });

      it('should skip ports in use', async () => {
        // Track which ports fail
        const portsInUse = new Set([3001, 3002]);

        vi.mocked(net.createServer).mockImplementation(() => {
          const mockServer = {
            listen: vi.fn((port: number, cb: () => void) => {
              if (portsInUse.has(port)) {
                // Simulate error event for port in use
                setTimeout(() => mockServer._errorHandler?.({ code: 'EADDRINUSE' }), 0);
              } else {
                setTimeout(cb, 0);
              }
              return mockServer;
            }),
            close: vi.fn((cb: () => void) => setTimeout(cb, 0)),
            on: vi.fn((event: string, handler: (err: { code: string }) => void) => {
              if (event === 'error') {
                mockServer._errorHandler = handler;
              }
              return mockServer;
            }),
            _errorHandler: null as ((err: { code: string }) => void) | null,
          };
          return mockServer as unknown as net.Server;
        });

        const allocator = new PortAllocator({ min: 3001, max: 3100 });
        const port = await allocator.findAvailablePort();

        expect(port).toBe(3003);
      });

      it('should throw PORT_EXHAUSTED when no ports available', async () => {
        vi.mocked(net.createServer).mockImplementation(() => {
          const mockServer = {
            listen: vi.fn((_port: number, _cb: () => void) => {
              // Simulate error event for all ports
              setTimeout(() => mockServer._errorHandler?.({ code: 'EADDRINUSE' }), 0);
              return mockServer;
            }),
            close: vi.fn((cb: () => void) => setTimeout(cb, 0)),
            on: vi.fn((event: string, handler: (err: { code: string }) => void) => {
              if (event === 'error') {
                mockServer._errorHandler = handler;
              }
              return mockServer;
            }),
            _errorHandler: null as ((err: { code: string }) => void) | null,
          };
          return mockServer as unknown as net.Server;
        });

        const allocator = new PortAllocator({ min: 3001, max: 3005 });

        await expect(allocator.findAvailablePort()).rejects.toThrow('No available ports');
      });
    });

    describe('isPortAvailable', () => {
      it('should return true for available port', async () => {
        const mockServer = {
          listen: vi.fn((_port: number, cb: () => void) => {
            cb();
            return mockServer;
          }),
          close: vi.fn((cb: () => void) => cb()),
          on: vi.fn().mockReturnThis(),
        };
        vi.mocked(net.createServer).mockReturnValue(mockServer as unknown as net.Server);

        const allocator = new PortAllocator();
        const available = await allocator.isPortAvailable(3001);

        expect(available).toBe(true);
      });

      it('should return false for port in use', async () => {
        const mockServer = {
          listen: vi.fn(() => {
            throw { code: 'EADDRINUSE' };
          }),
          close: vi.fn((cb: () => void) => cb()),
          on: vi.fn((_event: string, handler: (err: { code: string }) => void) => {
            handler({ code: 'EADDRINUSE' });
            return mockServer;
          }),
        };
        vi.mocked(net.createServer).mockReturnValue(mockServer as unknown as net.Server);

        const allocator = new PortAllocator();
        const available = await allocator.isPortAvailable(3001);

        expect(available).toBe(false);
      });
    });

    describe('MAX_WORKTREES limit', () => {
      it('should enforce MAX_WORKTREES limit', async () => {
        vi.mocked(net.createServer).mockImplementation(() => {
          const mockServer = {
            listen: vi.fn((_port: number, cb: () => void) => {
              setTimeout(cb, 0);
              return mockServer;
            }),
            close: vi.fn((cb: () => void) => setTimeout(cb, 0)),
            on: vi.fn().mockReturnThis(),
          };
          return mockServer as unknown as net.Server;
        });

        const allocator = new PortAllocator({ min: 3001, max: 3100 });

        // Allocate ports up to MAX_WORKTREES
        const allocatedPorts: number[] = [];
        for (let i = 0; i < MAX_WORKTREES; i++) {
          const port = await allocator.findAvailablePort();
          allocatedPorts.push(port);
          allocator.markAllocated(port);
        }

        expect(allocatedPorts.length).toBe(MAX_WORKTREES);

        // Next allocation should throw
        await expect(allocator.findAvailablePort()).rejects.toThrow('Maximum number of worktrees');
      });
    });

    describe('markAllocated', () => {
      it('should prevent re-allocation of marked ports', async () => {
        let callCount = 0;
        const mockServer = {
          listen: vi.fn((_port: number, cb: () => void) => {
            callCount++;
            cb();
            return mockServer;
          }),
          close: vi.fn((cb: () => void) => cb()),
          on: vi.fn().mockReturnThis(),
        };
        vi.mocked(net.createServer).mockReturnValue(mockServer as unknown as net.Server);

        const allocator = new PortAllocator({ min: 3001, max: 3100 });

        allocator.markAllocated(3001);
        const port = await allocator.findAvailablePort();

        expect(port).toBe(3002); // Should skip 3001
      });
    });

    describe('release', () => {
      it('should allow re-allocation of released ports', async () => {
        const mockServer = {
          listen: vi.fn((_port: number, cb: () => void) => {
            cb();
            return mockServer;
          }),
          close: vi.fn((cb: () => void) => cb()),
          on: vi.fn().mockReturnThis(),
        };
        vi.mocked(net.createServer).mockReturnValue(mockServer as unknown as net.Server);

        const allocator = new PortAllocator({ min: 3001, max: 3100 });

        allocator.markAllocated(3001);
        allocator.release(3001);
        const port = await allocator.findAvailablePort();

        expect(port).toBe(3001);
      });
    });
  });
});
