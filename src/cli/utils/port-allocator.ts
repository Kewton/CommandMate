/**
 * Port Allocator
 * Issue #136: Phase 1 - Foundation
 *
 * Provides automatic port allocation for worktree servers.
 * SF-SEC-002: Implements MAX_WORKTREES limit to prevent port exhaustion attacks.
 *
 * @module port-allocator
 */

import { createServer, Server } from 'net';
import { AppError, ErrorCode } from '../../lib/errors';

/**
 * Default port range for worktree servers
 * Main server uses 3000, worktrees use 3001-3100
 */
export const DEFAULT_PORT_RANGE = {
  min: 3001,
  max: 3100,
} as const;

/**
 * Maximum number of concurrent worktree servers
 * SF-SEC-002: Prevents port exhaustion attacks
 */
export const MAX_WORKTREES = 10;

/**
 * Port range configuration
 */
export interface PortRange {
  min: number;
  max: number;
}

/**
 * Port allocator for managing worktree server ports
 *
 * @example
 * ```typescript
 * const allocator = new PortAllocator();
 * const port = await allocator.findAvailablePort();
 * allocator.markAllocated(port);
 * // ... start server on port ...
 * allocator.release(port);
 * ```
 */
export class PortAllocator {
  private static instance: PortAllocator | null = null;
  private readonly range: PortRange;
  private readonly allocatedPorts: Set<number>;
  private readonly issuePortMap: Map<number, number>;

  constructor(range: PortRange = DEFAULT_PORT_RANGE) {
    this.range = range;
    this.allocatedPorts = new Set();
    this.issuePortMap = new Map();
  }

  /**
   * Get singleton instance
   * Issue #136: Singleton pattern for CLI commands
   */
  static getInstance(): PortAllocator {
    if (!PortAllocator.instance) {
      PortAllocator.instance = new PortAllocator();
    }
    return PortAllocator.instance;
  }

  /**
   * Allocate a port for a specific issue (synchronous, deterministic)
   * Issue #136: Simple port allocation based on issue number
   *
   * @param issueNo - Issue number
   * @returns Allocated port number
   */
  allocate(issueNo: number): number {
    // Check if already allocated for this issue
    const existing = this.issuePortMap.get(issueNo);
    if (existing !== undefined) {
      return existing;
    }

    // Deterministic port based on issue number (3001 + issueNo % 100)
    const basePort = this.range.min + (issueNo % (this.range.max - this.range.min));
    this.issuePortMap.set(issueNo, basePort);
    this.allocatedPorts.add(basePort);
    return basePort;
  }

  /**
   * Find an available port in the configured range
   *
   * @returns Available port number
   * @throws AppError with code PORT_EXHAUSTED if no ports available
   * @throws AppError with code MAX_WORKTREES_EXCEEDED if limit reached
   */
  async findAvailablePort(): Promise<number> {
    // Check MAX_WORKTREES limit
    if (this.allocatedPorts.size >= MAX_WORKTREES) {
      throw new AppError(
        'MAX_WORKTREES_EXCEEDED',
        `Maximum number of worktrees (${MAX_WORKTREES}) exceeded`,
        { currentCount: this.allocatedPorts.size, limit: MAX_WORKTREES }
      );
    }

    for (let port = this.range.min; port <= this.range.max; port++) {
      // Skip already allocated ports
      if (this.allocatedPorts.has(port)) {
        continue;
      }

      if (await this.isPortAvailable(port)) {
        return port;
      }
    }

    throw new AppError(
      ErrorCode.PORT_EXHAUSTED,
      `No available ports in range ${this.range.min}-${this.range.max}`,
      { range: this.range, allocatedPorts: Array.from(this.allocatedPorts) }
    );
  }

  /**
   * Check if a specific port is available
   *
   * @param port - Port number to check
   * @returns true if port is available
   */
  async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server: Server = createServer();

      server.on('error', () => {
        resolve(false);
      });

      server.listen(port, () => {
        server.close(() => {
          resolve(true);
        });
      });
    });
  }

  /**
   * Mark a port as allocated
   *
   * @param port - Port number to mark as allocated
   */
  markAllocated(port: number): void {
    this.allocatedPorts.add(port);
  }

  /**
   * Release an allocated port
   *
   * @param port - Port number to release
   */
  release(port: number): void {
    this.allocatedPorts.delete(port);
  }

  /**
   * Get the count of allocated ports
   */
  getAllocatedCount(): number {
    return this.allocatedPorts.size;
  }

  /**
   * Check if a port is currently allocated (in-memory tracking)
   *
   * @param port - Port number to check
   * @returns true if port is allocated
   */
  isAllocated(port: number): boolean {
    return this.allocatedPorts.has(port);
  }

  /**
   * Get all allocated ports
   */
  getAllocatedPorts(): number[] {
    return Array.from(this.allocatedPorts);
  }
}

/**
 * Create a port allocator with default settings
 */
export function createPortAllocator(range?: PortRange): PortAllocator {
  return new PortAllocator(range);
}
