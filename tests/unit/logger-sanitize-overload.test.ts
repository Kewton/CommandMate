/**
 * Logger sanitize overload tests
 * Issue #573: Verify sanitize function overload type inference
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '@/lib/logger';

describe('Logger sanitize overload (Issue #573)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CM_LOG_FORMAT = 'json';
    process.env.CM_LOG_LEVEL = 'debug';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  });

  it('should sanitize Record<string, unknown> data and preserve structure', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const logger = createLogger('test');

    logger.info('test-action', {
      username: 'user1',
      password: 'secret123',
      nested: { token: 'my-token' },
    });

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    // data field should be Record<string, unknown> (not unknown)
    expect(parsed.data).toBeDefined();
    expect(parsed.data.username).toBe('user1');
    expect(parsed.data.password).toBe('[REDACTED]');
    expect(parsed.data.nested.token).toBe('[REDACTED]');
  });

  it('should handle data with no sensitive fields unchanged', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const logger = createLogger('test');

    logger.info('test-action', { count: 42, name: 'test' });

    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.data.count).toBe(42);
    expect(parsed.data.name).toBe('test');
  });

  it('should work without data parameter', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const logger = createLogger('test');

    logger.info('no-data-action');

    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.data).toBeUndefined();
  });
});
