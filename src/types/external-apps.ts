/**
 * Type definitions for external apps module
 * Issue #42: Proxy routing for multiple frontend applications
 */

/**
 * External app type (framework/runtime)
 */
export type ExternalAppType = 'sveltekit' | 'streamlit' | 'nextjs' | 'other';

/**
 * External app entity (corresponds to DB record)
 * - DB column names: snake_case
 * - TypeScript property names: camelCase
 */
export interface ExternalApp {
  /** Unique identifier (UUID) */
  id: string;

  /** App identifier name (alphanumeric, hyphens) - must be unique */
  name: string;

  /** Display name for UI */
  displayName: string;

  /** Optional description */
  description?: string;

  /** Path prefix for routing (e.g., "app-svelte") - must be unique */
  pathPrefix: string;

  /** Target port number (1024-65535) */
  targetPort: number;

  /** Target host (default: 'localhost') */
  targetHost: string;

  /** Application type/framework */
  appType: ExternalAppType;

  /** Whether WebSocket proxying is enabled */
  websocketEnabled: boolean;

  /** WebSocket path pattern (regex) for matching WS upgrade requests */
  websocketPathPattern?: string;

  /** Whether the app is currently enabled for proxying */
  enabled: boolean;

  /** Creation timestamp (Unix ms) */
  createdAt: number;

  /** Last update timestamp (Unix ms) */
  updatedAt: number;
}

/**
 * Input for creating a new external app
 */
export interface CreateExternalAppInput {
  /** App identifier name (alphanumeric, hyphens) */
  name: string;

  /** Display name for UI */
  displayName: string;

  /** Optional description */
  description?: string;

  /** Path prefix for routing */
  pathPrefix: string;

  /** Target port number */
  targetPort: number;

  /** Target host (default: 'localhost') */
  targetHost?: string;

  /** Application type/framework */
  appType: ExternalAppType;

  /** Whether WebSocket proxying is enabled (default: false) */
  websocketEnabled?: boolean;

  /** WebSocket path pattern (regex) */
  websocketPathPattern?: string;
}

/**
 * Input for updating an existing external app
 * All fields are optional - only provided fields will be updated
 */
export interface UpdateExternalAppInput {
  /** Display name for UI */
  displayName?: string;

  /** Optional description */
  description?: string;

  /** Target port number */
  targetPort?: number;

  /** Target host */
  targetHost?: string;

  /** Whether WebSocket proxying is enabled */
  websocketEnabled?: boolean;

  /** WebSocket path pattern (regex) */
  websocketPathPattern?: string;

  /** Whether the app is currently enabled */
  enabled?: boolean;
}

/**
 * Health status for an external app
 */
export interface ExternalAppHealth {
  /** App ID */
  id: string;

  /** Whether the app is healthy (port is reachable) */
  healthy: boolean;

  /** Response time in milliseconds (only present if healthy) */
  responseTime?: number;

  /** Last health check timestamp (Unix ms) */
  lastChecked: number;

  /** Error message (only present if unhealthy) */
  error?: string;
}
