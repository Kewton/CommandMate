/**
 * CLI Logger Tests
 * Tests for CLILogger with colored output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CLILogger } from '../../../../src/cli/utils/logger';

describe('CLILogger', () => {
  let logger: CLILogger;
  let consoleSpy: { log: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    logger = new CLILogger();
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    consoleSpy.log.mockRestore();
    consoleSpy.error.mockRestore();
  });

  describe('info', () => {
    it('should log info messages', () => {
      logger.info('Test message');
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Test message'));
    });

    it('should include INFO prefix', () => {
      logger.info('Test message');
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('INFO'));
    });
  });

  describe('success', () => {
    it('should log success messages', () => {
      logger.success('Operation completed');
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Operation completed'));
    });

    it('should include checkmark symbol', () => {
      logger.success('Done');
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringMatching(/[✓✔]/));
    });
  });

  describe('warn', () => {
    it('should log warning messages', () => {
      logger.warn('Warning message');
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Warning message'));
    });

    it('should include WARN prefix', () => {
      logger.warn('Test');
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('WARN'));
    });
  });

  describe('error', () => {
    it('should log error messages to stderr', () => {
      logger.error('Error message');
      expect(consoleSpy.error).toHaveBeenCalledWith(expect.stringContaining('Error message'));
    });

    it('should include ERROR prefix', () => {
      logger.error('Test');
      expect(consoleSpy.error).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
    });
  });

  describe('debug', () => {
    it('should log debug messages when verbose is true', () => {
      const verboseLogger = new CLILogger({ verbose: true });
      verboseLogger.debug('Debug message');
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Debug message'));
    });

    it('should not log debug messages when verbose is false', () => {
      const quietLogger = new CLILogger({ verbose: false });
      quietLogger.debug('Debug message');
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    it('should not log debug by default', () => {
      logger.debug('Debug message');
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });
  });

  describe('blank', () => {
    it('should log an empty line', () => {
      logger.blank();
      expect(consoleSpy.log).toHaveBeenCalledWith('');
    });
  });

  describe('header', () => {
    it('should log a formatted header', () => {
      logger.header('CommandMate');
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('CommandMate'));
    });
  });

  describe('formatDuration', () => {
    it('should format seconds', () => {
      expect(CLILogger.formatDuration(45)).toBe('45s');
    });

    it('should format minutes and seconds', () => {
      expect(CLILogger.formatDuration(125)).toBe('2m 5s');
    });

    it('should format hours and minutes', () => {
      expect(CLILogger.formatDuration(3665)).toBe('1h 1m');
    });

    it('should format days', () => {
      expect(CLILogger.formatDuration(90000)).toBe('1d 1h');
    });
  });
});
