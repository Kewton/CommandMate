/**
 * Logger Unit Tests
 * Tests for structured logging utility
 *
 * Issue #41: Structured logging + log level control
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, generateRequestId } from '@/lib/logger';

describe('Logger', () => {
  // Store original env values
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset environment variables
    delete process.env.CM_LOG_LEVEL;
    delete process.env.CM_LOG_FORMAT;

    // Mock console methods
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original environment
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  });

  describe('createLogger', () => {
    it('should return a logger instance with debug, info, warn, error methods', () => {
      const logger = createLogger('test-module');

      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.withContext).toBe('function');
    });

    it('should create logger with module name', () => {
      process.env.CM_LOG_LEVEL = 'debug';
      const logger = createLogger('test-module');
      logger.info('test-action');

      expect(console.log).toHaveBeenCalled();
      const output = vi.mocked(console.log).mock.calls[0][0] as string;
      expect(output).toContain('test-module');
    });
  });

  describe('Log level filtering', () => {
    it('should respect log level - debug logs filtered when level is warn', () => {
      process.env.CM_LOG_LEVEL = 'warn';
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      logger.debug('test-debug');

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should respect log level - info logs filtered when level is warn', () => {
      process.env.CM_LOG_LEVEL = 'warn';
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      logger.info('test-info');

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should allow warn logs when level is warn', () => {
      process.env.CM_LOG_LEVEL = 'warn';
      const consoleSpy = vi.spyOn(console, 'warn');

      const logger = createLogger('test');
      logger.warn('test-warn');

      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should allow error logs when level is warn', () => {
      process.env.CM_LOG_LEVEL = 'warn';
      const consoleSpy = vi.spyOn(console, 'error');

      const logger = createLogger('test');
      logger.error('test-error');

      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should allow all logs when level is debug', () => {
      process.env.CM_LOG_LEVEL = 'debug';

      const logger = createLogger('test');
      logger.debug('test-debug');
      logger.info('test-info');
      logger.warn('test-warn');
      logger.error('test-error');

      expect(console.log).toHaveBeenCalledTimes(2); // debug and info
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('Log format', () => {
    it('should output JSON format when CM_LOG_FORMAT=json', () => {
      process.env.CM_LOG_FORMAT = 'json';
      process.env.CM_LOG_LEVEL = 'debug';
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      logger.info('action', { name: 'value' });

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(() => JSON.parse(output)).not.toThrow();

      const parsed = JSON.parse(output);
      expect(parsed.level).toBe('info');
      expect(parsed.module).toBe('test');
      expect(parsed.action).toBe('action');
      expect(parsed.data.name).toBe('value');
    });

    it('should output text format by default', () => {
      process.env.CM_LOG_LEVEL = 'debug';
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      logger.info('action', { key: 'value' });

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[INFO]');
      expect(output).toContain('[test]');
      expect(output).toContain('action');
    });
  });

  describe('withContext', () => {
    it('should add context to log entries', () => {
      process.env.CM_LOG_FORMAT = 'json';
      process.env.CM_LOG_LEVEL = 'debug';
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      const logWithContext = logger.withContext({
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        requestId: 'req-123',
      });

      logWithContext.info('action');

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.worktreeId).toBe('wt-1');
      expect(parsed.cliToolId).toBe('claude');
      expect(parsed.requestId).toBe('req-123');
    });

    it('should merge context when chained', () => {
      process.env.CM_LOG_FORMAT = 'json';
      process.env.CM_LOG_LEVEL = 'debug';
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      const log1 = logger.withContext({ worktreeId: 'wt-1' });
      const log2 = log1.withContext({ cliToolId: 'claude' });

      log2.info('action');

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.worktreeId).toBe('wt-1');
      expect(parsed.cliToolId).toBe('claude');
    });

    it('should include context in text format', () => {
      process.env.CM_LOG_LEVEL = 'debug';
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      const logWithContext = logger.withContext({
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        requestId: 'req-12345678-abcd',
      });

      logWithContext.info('action');

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('wt-1');
      expect(output).toContain('claude');
      expect(output).toContain('req-1234'); // First 8 chars of requestId
    });
  });

  describe('[MF-1] Sanitization - sensitive data filtering', () => {
    beforeEach(() => {
      process.env.CM_LOG_FORMAT = 'json';
      process.env.CM_LOG_LEVEL = 'debug';
    });

    it('should redact Bearer tokens in log data', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      logger.info('auth', {
        header: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxxxx'
      });

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    });

    it('should redact password fields by key name', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      logger.info('login', {
        username: 'user1',
        password: 'secret123',
      });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.data.username).toBe('user1');
      expect(parsed.data.password).toBe('[REDACTED]');
    });

    it('should redact MCBD_AUTH_TOKEN in log data', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      logger.info('env', {
        output: 'MCBD_AUTH_TOKEN=super-secret-token-123',
      });

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('MCBD_AUTH_TOKEN=[REDACTED]');
      expect(output).not.toContain('super-secret-token-123');
    });

    it('should redact nested sensitive data', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      logger.info('config', {
        database: {
          host: 'localhost',
          password: 'db-password',
        },
        api: {
          token: 'api-token-123',
        },
      });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.data.database.host).toBe('localhost');
      expect(parsed.data.database.password).toBe('[REDACTED]');
      expect(parsed.data.api.token).toBe('[REDACTED]');
    });

    it('should redact secret key fields', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      logger.info('config', {
        apiKey: 'my-api-key',
        secret: 'my-secret',
        auth: 'my-auth-value',
      });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.data.apiKey).toBe('[REDACTED]');
      expect(parsed.data.secret).toBe('[REDACTED]');
      expect(parsed.data.auth).toBe('[REDACTED]');
    });

    it('should handle arrays with sensitive data', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      logger.info('tokens', {
        items: [
          { name: 'token1', token: 'secret-1' },
          { name: 'token2', token: 'secret-2' },
        ],
      });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.data.items[0].name).toBe('token1');
      expect(parsed.data.items[0].token).toBe('[REDACTED]');
      expect(parsed.data.items[1].token).toBe('[REDACTED]');
    });

    it('should redact Authorization headers', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      logger.info('request', {
        headers: 'Authorization: secret-value',
      });

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('Authorization: [REDACTED]');
      expect(output).not.toContain('secret-value');
    });
  });

  describe('[SF-2] generateRequestId', () => {
    it('should return UUID-like string', () => {
      const id = generateRequestId();
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateRequestId());
      }
      expect(ids.size).toBe(100);
    });

    it('should generate valid UUID v4 with 4 in position 15', () => {
      for (let i = 0; i < 10; i++) {
        const id = generateRequestId();
        const parts = id.split('-');
        expect(parts[2][0]).toBe('4');
      }
    });

    it('should have variant bits in correct position', () => {
      for (let i = 0; i < 10; i++) {
        const id = generateRequestId();
        const parts = id.split('-');
        // Position 19 should be 8, 9, a, or b
        expect(['8', '9', 'a', 'b']).toContain(parts[3][0].toLowerCase());
      }
    });
  });

  describe('Log entry structure', () => {
    beforeEach(() => {
      process.env.CM_LOG_FORMAT = 'json';
      process.env.CM_LOG_LEVEL = 'debug';
    });

    it('should include timestamp in log entries', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test');
      logger.info('action');

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.timestamp).toBeDefined();
      expect(() => new Date(parsed.timestamp)).not.toThrow();
    });

    it('should include all fields in JSON format', () => {
      const consoleSpy = vi.spyOn(console, 'log');

      const logger = createLogger('test-module');
      const logWithContext = logger.withContext({
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        requestId: 'req-123',
      });
      logWithContext.info('test-action', { name: 'value' });

      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed).toMatchObject({
        level: 'info',
        module: 'test-module',
        action: 'test-action',
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        requestId: 'req-123',
        data: { name: 'value' },
      });
      expect(parsed.timestamp).toBeDefined();
    });
  });
});
