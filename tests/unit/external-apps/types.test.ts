/**
 * Type definition tests for external-apps module
 * Tests type exports and type constraints
 */

import { describe, it, expect } from 'vitest';
import type {
  ExternalApp,
  ExternalAppType,
  CreateExternalAppInput,
  UpdateExternalAppInput,
  ExternalAppHealth,
} from '@/types/external-apps';

describe('External Apps Type Definitions', () => {
  describe('ExternalAppType', () => {
    it('should accept valid app types', () => {
      const types: ExternalAppType[] = ['sveltekit', 'streamlit', 'nextjs', 'other'];
      expect(types).toHaveLength(4);
    });
  });

  describe('ExternalApp', () => {
    it('should create valid ExternalApp object', () => {
      const app: ExternalApp = {
        id: 'test-id-123',
        name: 'sveltekit-app',
        displayName: 'SvelteKit App',
        description: 'A SvelteKit application',
        pathPrefix: 'app-svelte',
        targetPort: 5173,
        targetHost: 'localhost',
        appType: 'sveltekit',
        websocketEnabled: true,
        websocketPathPattern: '.*',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(app.id).toBe('test-id-123');
      expect(app.name).toBe('sveltekit-app');
      expect(app.displayName).toBe('SvelteKit App');
      expect(app.pathPrefix).toBe('app-svelte');
      expect(app.targetPort).toBe(5173);
      expect(app.targetHost).toBe('localhost');
      expect(app.appType).toBe('sveltekit');
      expect(app.websocketEnabled).toBe(true);
      expect(app.enabled).toBe(true);
    });

    it('should allow optional fields to be undefined', () => {
      const app: ExternalApp = {
        id: 'test-id',
        name: 'app',
        displayName: 'App',
        pathPrefix: 'test',
        targetPort: 3000,
        targetHost: 'localhost',
        appType: 'other',
        websocketEnabled: false,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(app.description).toBeUndefined();
      expect(app.websocketPathPattern).toBeUndefined();
    });
  });

  describe('CreateExternalAppInput', () => {
    it('should create valid input with required fields only', () => {
      const input: CreateExternalAppInput = {
        name: 'new-app',
        displayName: 'New App',
        pathPrefix: 'new-app',
        targetPort: 3000,
        appType: 'nextjs',
      };

      expect(input.name).toBe('new-app');
      expect(input.displayName).toBe('New App');
      expect(input.pathPrefix).toBe('new-app');
      expect(input.targetPort).toBe(3000);
      expect(input.appType).toBe('nextjs');
    });

    it('should create input with all optional fields', () => {
      const input: CreateExternalAppInput = {
        name: 'streamlit-app',
        displayName: 'Streamlit App',
        description: 'A Streamlit dashboard',
        pathPrefix: 'app-streamlit',
        targetPort: 8501,
        targetHost: '127.0.0.1',
        appType: 'streamlit',
        websocketEnabled: true,
        websocketPathPattern: '/_stcore/stream',
      };

      expect(input.description).toBe('A Streamlit dashboard');
      expect(input.targetHost).toBe('127.0.0.1');
      expect(input.websocketEnabled).toBe(true);
      expect(input.websocketPathPattern).toBe('/_stcore/stream');
    });
  });

  describe('UpdateExternalAppInput', () => {
    it('should allow partial updates', () => {
      const input1: UpdateExternalAppInput = {
        displayName: 'Updated Name',
      };

      const input2: UpdateExternalAppInput = {
        targetPort: 8080,
        enabled: false,
      };

      const input3: UpdateExternalAppInput = {};

      expect(input1.displayName).toBe('Updated Name');
      expect(input2.targetPort).toBe(8080);
      expect(input2.enabled).toBe(false);
      expect(Object.keys(input3)).toHaveLength(0);
    });
  });

  describe('ExternalAppHealth', () => {
    it('should create healthy status', () => {
      const health: ExternalAppHealth = {
        id: 'app-123',
        healthy: true,
        responseTime: 50,
        lastChecked: Date.now(),
      };

      expect(health.id).toBe('app-123');
      expect(health.healthy).toBe(true);
      expect(health.responseTime).toBe(50);
      expect(health.error).toBeUndefined();
    });

    it('should create unhealthy status with error', () => {
      const health: ExternalAppHealth = {
        id: 'app-456',
        healthy: false,
        lastChecked: Date.now(),
        error: 'Connection refused',
      };

      expect(health.healthy).toBe(false);
      expect(health.error).toBe('Connection refused');
      expect(health.responseTime).toBeUndefined();
    });
  });
});
