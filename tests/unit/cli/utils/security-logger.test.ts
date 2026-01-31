/**
 * Security Logger Tests
 * Tests for CLI security event logging
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logSecurityEvent, SecurityEvent, maskSensitiveData } from '../../../../src/cli/utils/security-logger';

vi.mock('fs');
vi.mock('os');

describe('logSecurityEvent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/home/user');
    delete process.env.CM_LOG_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should log event to default location', () => {
    vi.mocked(fs.appendFileSync).mockReturnValue(undefined);

    const event: SecurityEvent = {
      timestamp: '2026-01-31T10:00:00.000Z',
      command: 'init',
      action: 'success',
      details: 'Configuration initialized',
    };

    logSecurityEvent(event);

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/home/user/.commandmate-security.log',
      expect.stringContaining('[SUCCESS]'),
      expect.objectContaining({ mode: 0o600 })
    );
  });

  it('should log event to CM_LOG_DIR when set', () => {
    process.env.CM_LOG_DIR = '/var/log/commandmate';
    vi.mocked(fs.appendFileSync).mockReturnValue(undefined);

    const event: SecurityEvent = {
      timestamp: '2026-01-31T10:00:00.000Z',
      command: 'start',
      action: 'success',
    };

    logSecurityEvent(event);

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/var/log/commandmate/security.log',
      expect.any(String),
      expect.any(Object)
    );
  });

  it('should format log line correctly', () => {
    vi.mocked(fs.appendFileSync).mockReturnValue(undefined);

    const event: SecurityEvent = {
      timestamp: '2026-01-31T10:00:00.000Z',
      command: 'stop',
      action: 'warning',
      details: '--force flag used (SIGKILL)',
    };

    logSecurityEvent(event);

    const logContent = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
    expect(logContent).toContain('2026-01-31T10:00:00.000Z');
    expect(logContent).toContain('[WARNING]');
    expect(logContent).toContain('stop');
    expect(logContent).toContain('--force flag used (SIGKILL)');
    expect(logContent.endsWith('\n')).toBe(true);
  });

  it('should handle failure action', () => {
    vi.mocked(fs.appendFileSync).mockReturnValue(undefined);

    const event: SecurityEvent = {
      timestamp: '2026-01-31T10:00:00.000Z',
      command: 'start',
      action: 'failure',
      details: 'Port 3000 already in use',
    };

    logSecurityEvent(event);

    const logContent = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
    expect(logContent).toContain('[FAILURE]');
  });

  it('should not throw when fs operation fails', () => {
    vi.mocked(fs.appendFileSync).mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const event: SecurityEvent = {
      timestamp: '2026-01-31T10:00:00.000Z',
      command: 'init',
      action: 'success',
    };

    // Should not throw
    expect(() => logSecurityEvent(event)).not.toThrow();
  });
});

describe('maskSensitiveData', () => {
  it('should mask auth token values', () => {
    const input = 'Auth token: abc123def456ghi789';
    const result = maskSensitiveData(input);
    expect(result).not.toContain('abc123def456ghi789');
    expect(result).toContain('***');
  });

  it('should mask CM_AUTH_TOKEN in env format', () => {
    const input = 'CM_AUTH_TOKEN=supersecrettoken123';
    const result = maskSensitiveData(input);
    expect(result).not.toContain('supersecrettoken123');
    expect(result).toContain('***masked***');
  });

  it('should not mask non-sensitive data', () => {
    const input = 'Port: 3000, Bind: 127.0.0.1';
    const result = maskSensitiveData(input);
    expect(result).toBe(input);
  });

  it('should handle undefined input', () => {
    expect(maskSensitiveData(undefined)).toBeUndefined();
  });
});
