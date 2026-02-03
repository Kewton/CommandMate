/**
 * CLI Types Tests
 * Issue #136: Phase 3 - Task 3.2 - CLI Type Extensions
 * Tests for StopOptions, StatusOptions, and StartOptions extensions
 */

import { describe, it, expect } from 'vitest';
import type {
  StopOptions,
  StatusOptions,
  StartOptions,
} from '../../../../src/cli/types';

describe('CLI Types - Issue #136 Extensions', () => {
  describe('StopOptions', () => {
    it('should support optional issue property', () => {
      const options: StopOptions = {
        force: false,
        issue: 135,
      };
      expect(options.issue).toBe(135);
    });

    it('should allow StopOptions without issue (backward compatibility)', () => {
      const options: StopOptions = {
        force: true,
      };
      expect(options.issue).toBeUndefined();
    });
  });

  describe('StatusOptions', () => {
    it('should support optional issue property', () => {
      const options: StatusOptions = {
        issue: 200,
      };
      expect(options.issue).toBe(200);
    });

    it('should support optional all property', () => {
      const options: StatusOptions = {
        all: true,
      };
      expect(options.all).toBe(true);
    });

    it('should allow empty StatusOptions (backward compatibility)', () => {
      const options: StatusOptions = {};
      expect(options.issue).toBeUndefined();
      expect(options.all).toBeUndefined();
    });
  });

  describe('StartOptions', () => {
    it('should support optional issue property', () => {
      const options: StartOptions = {
        dev: true,
        daemon: false,
        issue: 150,
      };
      expect(options.issue).toBe(150);
    });

    it('should support optional autoPort property', () => {
      const options: StartOptions = {
        autoPort: true,
        issue: 135,
      };
      expect(options.autoPort).toBe(true);
    });

    it('should allow StartOptions without issue/autoPort (backward compatibility)', () => {
      const options: StartOptions = {
        dev: true,
        daemon: true,
        port: 3001,
      };
      expect(options.issue).toBeUndefined();
      expect(options.autoPort).toBeUndefined();
    });
  });
});
