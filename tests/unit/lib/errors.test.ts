/**
 * Error Definitions Tests
 * Issue #136: Phase 1 - Foundation
 * Tests for centralized error handling
 */

import { describe, it, expect } from 'vitest';
import {
  AppError,
  createAppError,
  ErrorCode,
  isAppError,
  wrapError,
  getErrorMessage,
} from '../../../src/lib/errors';

describe('errors', () => {

  describe('AppError', () => {
    it('should create error with code and message', () => {
      const error = new AppError('INVALID_ISSUE_NO', 'Invalid issue number');

      expect(error.code).toBe('INVALID_ISSUE_NO');
      expect(error.message).toBe('Invalid issue number');
      expect(error.name).toBe('AppError');
    });

    it('should include optional details', () => {
      const details = { issueNo: -1, expected: 'positive integer' };
      const error = new AppError('INVALID_ISSUE_NO', 'Invalid issue number', details);

      expect(error.details).toEqual(details);
    });

    it('should be instance of Error', () => {
      const error = new AppError('TEST_ERROR', 'Test message');

      expect(error instanceof Error).toBe(true);
      expect(error instanceof AppError).toBe(true);
    });

    it('should capture stack trace', () => {
      const error = new AppError('TEST_ERROR', 'Test message');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('AppError');
    });
  });

  describe('createAppError', () => {
    it('should create AppError with code and message', () => {
      const error = createAppError('PORT_EXHAUSTED', 'No available ports');

      expect(error.code).toBe('PORT_EXHAUSTED');
      expect(error.message).toBe('No available ports');
    });

    it('should pass through details', () => {
      const details = { attemptedPorts: [3001, 3002, 3003] };
      const error = createAppError('PORT_EXHAUSTED', 'No available ports', details);

      expect(error.details).toEqual(details);
    });
  });

  describe('ErrorCode', () => {
    it('should have INVALID_ISSUE_NO', () => {
      expect(ErrorCode.INVALID_ISSUE_NO).toBe('INVALID_ISSUE_NO');
    });

    it('should have ISSUE_NO_OUT_OF_RANGE', () => {
      expect(ErrorCode.ISSUE_NO_OUT_OF_RANGE).toBe('ISSUE_NO_OUT_OF_RANGE');
    });

    it('should have INVALID_BRANCH_NAME', () => {
      expect(ErrorCode.INVALID_BRANCH_NAME).toBe('INVALID_BRANCH_NAME');
    });

    it('should have PORT_EXHAUSTED', () => {
      expect(ErrorCode.PORT_EXHAUSTED).toBe('PORT_EXHAUSTED');
    });

    it('should have WORKTREE_NOT_FOUND', () => {
      expect(ErrorCode.WORKTREE_NOT_FOUND).toBe('WORKTREE_NOT_FOUND');
    });

    it('should have PID_FILE_EXISTS', () => {
      expect(ErrorCode.PID_FILE_EXISTS).toBe('PID_FILE_EXISTS');
    });

    it('should have PATH_TRAVERSAL', () => {
      expect(ErrorCode.PATH_TRAVERSAL).toBe('PATH_TRAVERSAL');
    });
  });

  describe('isAppError', () => {
    it('should return true for AppError instances', () => {
      const error = new AppError('TEST_ERROR', 'Test');

      expect(isAppError(error)).toBe(true);
    });

    it('should return false for regular Error', () => {
      const error = new Error('Test');

      expect(isAppError(error)).toBe(false);
    });

    it('should return false for non-error values', () => {
      expect(isAppError(null)).toBe(false);
      expect(isAppError(undefined)).toBe(false);
      expect(isAppError('error')).toBe(false);
      expect(isAppError({})).toBe(false);
    });
  });

  describe('AppError methods', () => {
    it('toClientError should return code and message only', () => {
      const error = new AppError('TEST_ERROR', 'Test message', { secret: 'hidden' });
      const clientError = error.toClientError();

      expect(clientError.code).toBe('TEST_ERROR');
      expect(clientError.message).toBe('Test message');
      expect(clientError).not.toHaveProperty('details');
      expect(clientError).not.toHaveProperty('timestamp');
    });

    it('toLogError should include details and timestamp', () => {
      const details = { userId: 123 };
      const error = new AppError('TEST_ERROR', 'Test message', details);
      const logError = error.toLogError();

      expect(logError.code).toBe('TEST_ERROR');
      expect(logError.message).toBe('Test message');
      expect(logError.details).toEqual(details);
      expect(logError.timestamp).toBeDefined();
    });

    it('should have timestamp set on creation', () => {
      const before = new Date().toISOString();
      const error = new AppError('TEST_ERROR', 'Test');
      const after = new Date().toISOString();

      expect(error.timestamp >= before).toBe(true);
      expect(error.timestamp <= after).toBe(true);
    });
  });

  describe('wrapError', () => {
    it('should return AppError unchanged', () => {
      const original = new AppError('ORIGINAL', 'Original error');
      const wrapped = wrapError(original);

      expect(wrapped).toBe(original);
    });

    it('should wrap regular Error with default code', () => {
      const original = new Error('Regular error');
      const wrapped = wrapError(original);

      expect(wrapped.code).toBe(ErrorCode.UNKNOWN_ERROR);
      expect(wrapped.message).toBe('Regular error');
    });

    it('should wrap regular Error with custom code', () => {
      const original = new Error('Regular error');
      const wrapped = wrapError(original, ErrorCode.GIT_ERROR);

      expect(wrapped.code).toBe(ErrorCode.GIT_ERROR);
      expect(wrapped.message).toBe('Regular error');
    });

    it('should wrap string error', () => {
      const wrapped = wrapError('String error');

      expect(wrapped.code).toBe(ErrorCode.UNKNOWN_ERROR);
      expect(wrapped.message).toBe('String error');
    });

    it('should wrap null/undefined error', () => {
      expect(wrapError(null).message).toBe('null');
      expect(wrapError(undefined).message).toBe('undefined');
    });
  });

  describe('getErrorMessage', () => {
    it('should extract message from Error', () => {
      const error = new Error('Test message');
      expect(getErrorMessage(error)).toBe('Test message');
    });

    it('should extract message from AppError', () => {
      const error = new AppError('CODE', 'App error message');
      expect(getErrorMessage(error)).toBe('App error message');
    });

    it('should convert non-error to string', () => {
      expect(getErrorMessage('string error')).toBe('string error');
      expect(getErrorMessage(123)).toBe('123');
      expect(getErrorMessage(null)).toBe('null');
      expect(getErrorMessage(undefined)).toBe('undefined');
    });
  });
});
