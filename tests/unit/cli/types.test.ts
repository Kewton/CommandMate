/**
 * CLI Types Tests
 * Tests for ExitCode enum and common types
 */

import { describe, it, expect } from 'vitest';
import {
  ExitCode,
  InitOptions,
  StartOptions,
  StopOptions,
  DaemonStatus,
  DependencyCheck,
  PreflightResult,
  getErrorMessage,
} from '../../../src/cli/types';

describe('ExitCode enum', () => {
  it('should have SUCCESS as 0', () => {
    expect(ExitCode.SUCCESS).toBe(0);
  });

  it('should have DEPENDENCY_ERROR as 1', () => {
    expect(ExitCode.DEPENDENCY_ERROR).toBe(1);
  });

  it('should have CONFIG_ERROR as 2', () => {
    expect(ExitCode.CONFIG_ERROR).toBe(2);
  });

  it('should have START_FAILED as 3', () => {
    expect(ExitCode.START_FAILED).toBe(3);
  });

  it('should have STOP_FAILED as 4', () => {
    expect(ExitCode.STOP_FAILED).toBe(4);
  });

  // Issue #1194 (D-1): update failure exit code
  it('should have UPDATE_FAILED as 5', () => {
    expect(ExitCode.UPDATE_FAILED).toBe(5);
  });

  it('should have UNEXPECTED_ERROR as 99', () => {
    expect(ExitCode.UNEXPECTED_ERROR).toBe(99);
  });
});

describe('InitOptions interface', () => {
  it('should accept valid options', () => {
    const options: InitOptions = {
      defaults: true,
      force: false,
    };
    expect(options.defaults).toBe(true);
    expect(options.force).toBe(false);
  });

  it('should allow undefined optional properties', () => {
    const options: InitOptions = {};
    expect(options.defaults).toBeUndefined();
    expect(options.force).toBeUndefined();
  });
});

describe('StartOptions interface', () => {
  it('should accept valid options', () => {
    const options: StartOptions = {
      dev: true,
      daemon: false,
      port: 3000,
    };
    expect(options.dev).toBe(true);
    expect(options.daemon).toBe(false);
    expect(options.port).toBe(3000);
  });

  it('should allow undefined optional properties', () => {
    const options: StartOptions = {};
    expect(options.dev).toBeUndefined();
    expect(options.daemon).toBeUndefined();
    expect(options.port).toBeUndefined();
  });
});

describe('StopOptions interface', () => {
  it('should accept valid options', () => {
    const options: StopOptions = {
      force: true,
    };
    expect(options.force).toBe(true);
  });

  it('should allow undefined optional properties', () => {
    const options: StopOptions = {};
    expect(options.force).toBeUndefined();
  });
});

describe('DaemonStatus interface', () => {
  it('should accept running status', () => {
    const status: DaemonStatus = {
      running: true,
      pid: 12345,
      port: 3000,
      uptime: 3600,
      url: 'http://127.0.0.1:3000',
    };
    expect(status.running).toBe(true);
    expect(status.pid).toBe(12345);
    expect(status.port).toBe(3000);
    expect(status.uptime).toBe(3600);
    expect(status.url).toBe('http://127.0.0.1:3000');
  });

  it('should accept not running status', () => {
    const status: DaemonStatus = {
      running: false,
    };
    expect(status.running).toBe(false);
    expect(status.pid).toBeUndefined();
  });
});

describe('DependencyCheck interface', () => {
  it('should accept required dependency', () => {
    const dep: DependencyCheck = {
      name: 'Node.js',
      command: 'node',
      versionArg: '-v',
      required: true,
      minVersion: '20.0.0',
    };
    expect(dep.name).toBe('Node.js');
    expect(dep.required).toBe(true);
    expect(dep.minVersion).toBe('20.0.0');
  });

  it('should accept optional dependency', () => {
    const dep: DependencyCheck = {
      name: 'Claude CLI',
      command: 'claude',
      versionArg: '--version',
      required: false,
    };
    expect(dep.required).toBe(false);
    expect(dep.minVersion).toBeUndefined();
  });
});

describe('PreflightResult interface', () => {
  it('should accept success result', () => {
    const result: PreflightResult = {
      success: true,
      results: [
        { name: 'Node.js', status: 'ok', version: '20.0.0' },
        { name: 'npm', status: 'ok', version: '10.0.0' },
      ],
    };
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);
  });

  it('should accept failure result', () => {
    const result: PreflightResult = {
      success: false,
      results: [
        { name: 'Node.js', status: 'ok', version: '20.0.0' },
        { name: 'tmux', status: 'missing' },
      ],
    };
    expect(result.success).toBe(false);
  });
});

describe('getErrorMessage', () => {
  it('should extract message from Error object', () => {
    const error = new Error('Test error message');
    expect(getErrorMessage(error)).toBe('Test error message');
  });

  it('should handle TypeError', () => {
    const error = new TypeError('Type error occurred');
    expect(getErrorMessage(error)).toBe('Type error occurred');
  });

  it('should handle RangeError', () => {
    const error = new RangeError('Range error occurred');
    expect(getErrorMessage(error)).toBe('Range error occurred');
  });

  it('should convert string to message', () => {
    const error = 'String error message';
    expect(getErrorMessage(error)).toBe('String error message');
  });

  it('should convert number to message', () => {
    const error = 42;
    expect(getErrorMessage(error)).toBe('42');
  });

  it('should convert null to message', () => {
    const error = null;
    expect(getErrorMessage(error)).toBe('null');
  });

  it('should convert undefined to message', () => {
    const error = undefined;
    expect(getErrorMessage(error)).toBe('undefined');
  });

  it('should convert object to message', () => {
    const error = { code: 'ERR_TEST', detail: 'test detail' };
    expect(getErrorMessage(error)).toBe('[object Object]');
  });

  it('should handle Error subclass with custom message', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }
    const error = new CustomError('Custom error message');
    expect(getErrorMessage(error)).toBe('Custom error message');
  });
});
