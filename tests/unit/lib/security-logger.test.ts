/**
 * Tests for security-logger.ts
 * SecurityAction type and logSecurityEvent helper
 */

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@/lib/logger';
import { logSecurityEvent } from '@/lib/security/security-logger';
import type { SecurityAction } from '@/lib/security/security-logger';

describe('logSecurityEvent', () => {
  function createMockLogger(): Logger {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      withContext: vi.fn(),
    } as unknown as Logger;
  }

  it('should call logger.warn with security: prefix for symlink-rejected', () => {
    const logger = createMockLogger();
    const details = { targetPath: '/some/path', resolvedTarget: '/other/path' };

    logSecurityEvent(logger, 'symlink-rejected', details);

    expect(logger.warn).toHaveBeenCalledWith('security:symlink-rejected', details);
  });

  it('should call logger.warn with security: prefix for dangling-symlink-rejected', () => {
    const logger = createMockLogger();
    const details = { targetPath: '/some/link', resolvedLinkTarget: '/dangling/target' };

    logSecurityEvent(logger, 'dangling-symlink-rejected', details);

    expect(logger.warn).toHaveBeenCalledWith('security:dangling-symlink-rejected', details);
  });

  it('should call logger.warn with security: prefix for symlink-ancestor-rejected', () => {
    const logger = createMockLogger();
    const details = { currentPath: '/ancestor/path', resolvedAncestor: '/resolved/ancestor' };

    logSecurityEvent(logger, 'symlink-ancestor-rejected', details);

    expect(logger.warn).toHaveBeenCalledWith('security:symlink-ancestor-rejected', details);
  });

  it('should call logger.warn with security: prefix for trust-proxy-unexpected', () => {
    const logger = createMockLogger();
    const details = { value: 'TRUE' };

    logSecurityEvent(logger, 'trust-proxy-unexpected', details);

    expect(logger.warn).toHaveBeenCalledWith('security:trust-proxy-unexpected', details);
  });

  it('should pass details object to logger.warn unchanged', () => {
    const logger = createMockLogger();
    const details = { key1: 'value1', key2: 42, nested: { a: true } };

    logSecurityEvent(logger, 'symlink-rejected', details);

    expect(logger.warn).toHaveBeenCalledWith('security:symlink-rejected', details);
  });

  it('should accept empty details object', () => {
    const logger = createMockLogger();

    logSecurityEvent(logger, 'trust-proxy-unexpected', {});

    expect(logger.warn).toHaveBeenCalledWith('security:trust-proxy-unexpected', {});
  });

  it('should enforce SecurityAction type at compile time', () => {
    // This test ensures the type is correctly exported and usable
    const action: SecurityAction = 'symlink-rejected';
    expect(action).toBe('symlink-rejected');
  });
});
