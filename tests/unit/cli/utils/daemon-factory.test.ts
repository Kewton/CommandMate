/**
 * DaemonManager Factory Tests
 * Issue #136: Phase 3 - Task 3.1 - DaemonManager abstraction
 * Tests for DaemonManagerFactory and DaemonManagerWrapper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { homedir } from 'os';

// Mock file system operations used by resource resolvers
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
  };
});

// Mock install-context
vi.mock('../../../../src/cli/utils/install-context', () => ({
  getConfigDir: vi.fn(() => path.join(homedir(), '.commandmate')),
  isGlobalInstall: vi.fn(() => true),
}));

import {
  DaemonManagerFactory,
  DaemonManagerWrapper,
  IDaemonManager,
  DaemonManagerConfig,
  getDaemonManagerFactory,
  resetDaemonManagerFactory,
} from '../../../../src/cli/utils/daemon-factory';
import { DaemonManager } from '../../../../src/cli/utils/daemon';

describe('DaemonManagerFactory', () => {
  const mockConfigDir = path.join(homedir(), '.commandmate');

  beforeEach(() => {
    vi.clearAllMocks();
    resetDaemonManagerFactory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('create', () => {
    it('should create IDaemonManager for main server (no issueNo)', () => {
      const factory = new DaemonManagerFactory();
      const manager = factory.create();

      expect(manager).toBeDefined();
      expect(typeof manager.start).toBe('function');
      expect(typeof manager.stop).toBe('function');
      expect(typeof manager.getStatus).toBe('function');
      expect(typeof manager.isRunning).toBe('function');
    });

    it('should create IDaemonManager for specific issue', () => {
      const factory = new DaemonManagerFactory();
      const manager = factory.create(135);

      expect(manager).toBeDefined();
      expect(typeof manager.start).toBe('function');
    });

    it('should return DaemonManagerWrapper instance', () => {
      const factory = new DaemonManagerFactory();
      const manager = factory.create(200);

      expect(manager).toBeInstanceOf(DaemonManagerWrapper);
    });
  });

  describe('singleton factory', () => {
    it('should return same factory instance', () => {
      const factory1 = getDaemonManagerFactory();
      const factory2 = getDaemonManagerFactory();

      expect(factory1).toBe(factory2);
    });

    it('should reset singleton with resetDaemonManagerFactory', () => {
      const factory1 = getDaemonManagerFactory();
      resetDaemonManagerFactory();
      const factory2 = getDaemonManagerFactory();

      expect(factory1).not.toBe(factory2);
    });
  });
});

describe('DaemonManagerWrapper', () => {
  const mockConfig: DaemonManagerConfig = {
    pidPath: '/tmp/test.pid',
    envPath: '/tmp/test.env',
    dbPath: '/tmp/test.db',
    issueNo: 135,
  };

  // Create a minimal mock DaemonManager
  const createMockDaemonManager = () => ({
    start: vi.fn().mockResolvedValue(12345),
    stop: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn().mockResolvedValue({ running: true, pid: 12345 }),
    isRunning: vi.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('start', () => {
    it('should delegate to inner DaemonManager', async () => {
      const mockInner = createMockDaemonManager();
      const wrapper = new DaemonManagerWrapper(
        mockInner as unknown as DaemonManager,
        mockConfig
      );

      const pid = await wrapper.start({ dev: true });

      expect(mockInner.start).toHaveBeenCalledWith({ dev: true });
      expect(pid).toBe(12345);
    });

    it('should set CM_DB_PATH environment variable for worktree', async () => {
      const mockInner = createMockDaemonManager();
      const wrapper = new DaemonManagerWrapper(
        mockInner as unknown as DaemonManager,
        mockConfig
      );

      await wrapper.start({});

      expect(process.env.CM_DB_PATH).toBe(mockConfig.dbPath);
      expect(process.env.CM_ISSUE_NO).toBe('135');
    });

    it('should not set CM_ISSUE_NO for main server', async () => {
      const mockInner = createMockDaemonManager();
      const mainConfig: DaemonManagerConfig = {
        ...mockConfig,
        issueNo: undefined,
      };
      const wrapper = new DaemonManagerWrapper(
        mockInner as unknown as DaemonManager,
        mainConfig
      );

      // Clear environment
      delete process.env.CM_ISSUE_NO;

      await wrapper.start({});

      // Should not be set for main server
      expect(process.env.CM_ISSUE_NO).toBeUndefined();
    });
  });

  describe('stop', () => {
    it('should delegate to inner DaemonManager', async () => {
      const mockInner = createMockDaemonManager();
      const wrapper = new DaemonManagerWrapper(
        mockInner as unknown as DaemonManager,
        mockConfig
      );

      const result = await wrapper.stop();

      expect(mockInner.stop).toHaveBeenCalledWith(false);
      expect(result).toBe(true);
    });

    it('should pass force parameter', async () => {
      const mockInner = createMockDaemonManager();
      const wrapper = new DaemonManagerWrapper(
        mockInner as unknown as DaemonManager,
        mockConfig
      );

      await wrapper.stop(true);

      expect(mockInner.stop).toHaveBeenCalledWith(true);
    });
  });

  describe('getStatus', () => {
    it('should delegate to inner DaemonManager', async () => {
      const mockInner = createMockDaemonManager();
      const wrapper = new DaemonManagerWrapper(
        mockInner as unknown as DaemonManager,
        mockConfig
      );

      const status = await wrapper.getStatus();

      expect(mockInner.getStatus).toHaveBeenCalled();
      expect(status).toEqual({ running: true, pid: 12345 });
    });
  });

  describe('isRunning', () => {
    it('should delegate to inner DaemonManager', async () => {
      const mockInner = createMockDaemonManager();
      const wrapper = new DaemonManagerWrapper(
        mockInner as unknown as DaemonManager,
        mockConfig
      );

      const running = await wrapper.isRunning();

      expect(mockInner.isRunning).toHaveBeenCalled();
      expect(running).toBe(true);
    });
  });

  describe('getConfig', () => {
    it('should return copy of configuration', () => {
      const mockInner = createMockDaemonManager();
      const wrapper = new DaemonManagerWrapper(
        mockInner as unknown as DaemonManager,
        mockConfig
      );

      const config = wrapper.getConfig();

      expect(config).toEqual(mockConfig);
      expect(config).not.toBe(mockConfig); // Should be a copy
    });
  });
});

describe('IDaemonManager interface compliance', () => {
  it('DaemonManagerWrapper should implement IDaemonManager', () => {
    const mockInner = {
      start: vi.fn().mockResolvedValue(1),
      stop: vi.fn().mockResolvedValue(true),
      getStatus: vi.fn().mockResolvedValue(null),
      isRunning: vi.fn().mockResolvedValue(false),
    };

    const config: DaemonManagerConfig = {
      pidPath: '/test.pid',
      envPath: '/test.env',
      dbPath: '/test.db',
    };

    const wrapper: IDaemonManager = new DaemonManagerWrapper(
      mockInner as unknown as DaemonManager,
      config
    );

    // Type check - should compile without errors
    expect(wrapper.start).toBeDefined();
    expect(wrapper.stop).toBeDefined();
    expect(wrapper.getStatus).toBeDefined();
    expect(wrapper.isRunning).toBeDefined();
  });
});
