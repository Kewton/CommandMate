/**
 * Validation module tests for external-apps
 * Issue #42: Proxy routing for multiple frontend applications
 */

import { describe, it, expect } from 'vitest';
import {
  PORT_CONSTRAINTS,
  VALID_TARGET_HOSTS,
  PATH_PREFIX_PATTERN,
  VALID_APP_TYPES,
  APP_TYPE_LABELS,
  isValidPort,
  isValidPathPrefix,
  isValidTargetHost,
  isValidAppType,
  validateCreateInput,
  validateFormData,
} from '@/lib/external-apps/validation';

describe('External Apps Validation Module', () => {
  describe('Constants', () => {
    it('should have correct port constraints', () => {
      expect(PORT_CONSTRAINTS.MIN).toBe(1024);
      expect(PORT_CONSTRAINTS.MAX).toBe(65535);
    });

    it('should have valid target hosts', () => {
      expect(VALID_TARGET_HOSTS).toContain('localhost');
      expect(VALID_TARGET_HOSTS).toContain('127.0.0.1');
    });

    it('should have all app types with labels', () => {
      for (const appType of VALID_APP_TYPES) {
        expect(APP_TYPE_LABELS[appType]).toBeDefined();
        expect(typeof APP_TYPE_LABELS[appType]).toBe('string');
      }
    });
  });

  describe('isValidPort', () => {
    it('should accept valid ports', () => {
      expect(isValidPort(1024)).toBe(true);
      expect(isValidPort(3000)).toBe(true);
      expect(isValidPort(8080)).toBe(true);
      expect(isValidPort(65535)).toBe(true);
    });

    it('should reject ports below minimum', () => {
      expect(isValidPort(1023)).toBe(false);
      expect(isValidPort(80)).toBe(false);
      expect(isValidPort(0)).toBe(false);
      expect(isValidPort(-1)).toBe(false);
    });

    it('should reject ports above maximum', () => {
      expect(isValidPort(65536)).toBe(false);
      expect(isValidPort(100000)).toBe(false);
    });

    it('should reject non-integer values', () => {
      expect(isValidPort(3000.5)).toBe(false);
      expect(isValidPort(NaN)).toBe(false);
    });
  });

  describe('isValidPathPrefix', () => {
    it('should accept valid path prefixes', () => {
      expect(isValidPathPrefix('app')).toBe(true);
      expect(isValidPathPrefix('my-app')).toBe(true);
      expect(isValidPathPrefix('app123')).toBe(true);
      expect(isValidPathPrefix('App-Name-123')).toBe(true);
    });

    it('should reject invalid path prefixes', () => {
      expect(isValidPathPrefix('')).toBe(false);
      expect(isValidPathPrefix('app/path')).toBe(false);
      expect(isValidPathPrefix('app path')).toBe(false);
      expect(isValidPathPrefix('app_name')).toBe(false);
      expect(isValidPathPrefix('app.name')).toBe(false);
    });
  });

  describe('isValidTargetHost', () => {
    it('should accept valid hosts', () => {
      expect(isValidTargetHost('localhost')).toBe(true);
      expect(isValidTargetHost('127.0.0.1')).toBe(true);
    });

    it('should reject invalid hosts', () => {
      expect(isValidTargetHost('example.com')).toBe(false);
      expect(isValidTargetHost('192.168.1.1')).toBe(false);
      expect(isValidTargetHost('0.0.0.0')).toBe(false);
    });
  });

  describe('isValidAppType', () => {
    it('should accept valid app types', () => {
      expect(isValidAppType('sveltekit')).toBe(true);
      expect(isValidAppType('streamlit')).toBe(true);
      expect(isValidAppType('nextjs')).toBe(true);
      expect(isValidAppType('other')).toBe(true);
    });

    it('should reject invalid app types', () => {
      expect(isValidAppType('react')).toBe(false);
      expect(isValidAppType('vue')).toBe(false);
      expect(isValidAppType('')).toBe(false);
    });
  });

  describe('validateCreateInput', () => {
    const validInput = {
      name: 'test-app',
      displayName: 'Test App',
      pathPrefix: 'test',
      targetPort: 3000,
      appType: 'nextjs',
    };

    it('should return no errors for valid input', () => {
      const errors = validateCreateInput(validInput);
      expect(errors).toHaveLength(0);
    });

    it('should require body', () => {
      const errors = validateCreateInput(null);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('body');
    });

    it('should require name', () => {
      const errors = validateCreateInput({ ...validInput, name: undefined });
      expect(errors.find(e => e.field === 'name')).toBeDefined();
    });

    it('should require displayName', () => {
      const errors = validateCreateInput({ ...validInput, displayName: undefined });
      expect(errors.find(e => e.field === 'displayName')).toBeDefined();
    });

    it('should validate pathPrefix format', () => {
      const errors = validateCreateInput({ ...validInput, pathPrefix: 'invalid/path' });
      expect(errors.find(e => e.field === 'pathPrefix')).toBeDefined();
    });

    it('should validate port range', () => {
      const errors = validateCreateInput({ ...validInput, targetPort: 80 });
      expect(errors.find(e => e.field === 'targetPort')).toBeDefined();
    });

    it('should validate appType', () => {
      const errors = validateCreateInput({ ...validInput, appType: 'invalid' });
      expect(errors.find(e => e.field === 'appType')).toBeDefined();
    });

    it('should validate targetHost if provided', () => {
      const errors = validateCreateInput({ ...validInput, targetHost: 'example.com' });
      expect(errors.find(e => e.field === 'targetHost')).toBeDefined();
    });
  });

  describe('validateFormData', () => {
    it('should validate create mode', () => {
      const errors = validateFormData(
        {
          displayName: '',
          name: '',
          pathPrefix: '',
          targetPort: '',
          appType: '',
        },
        false
      );

      expect(errors.displayName).toBeDefined();
      expect(errors.name).toBeDefined();
      expect(errors.pathPrefix).toBeDefined();
      expect(errors.targetPort).toBeDefined();
      expect(errors.appType).toBeDefined();
    });

    it('should skip name/pathPrefix validation in edit mode', () => {
      const errors = validateFormData(
        {
          displayName: 'Valid Name',
          name: '',
          pathPrefix: '',
          targetPort: 3000,
          appType: 'nextjs',
        },
        true
      );

      expect(errors.name).toBeUndefined();
      expect(errors.pathPrefix).toBeUndefined();
      expect(errors.appType).toBeUndefined();
    });

    it('should return no errors for valid data', () => {
      const errors = validateFormData(
        {
          displayName: 'Test App',
          name: 'test-app',
          pathPrefix: 'test',
          targetPort: 3000,
          appType: 'nextjs',
        },
        false
      );

      expect(Object.keys(errors)).toHaveLength(0);
    });
  });
});
