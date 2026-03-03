/**
 * Interface definitions for external apps module
 * Issue #42: Proxy routing for multiple frontend applications
 *
 * These interfaces follow the Strategy pattern similar to CLIToolManager
 * to ensure extensibility and testability.
 */

import type {
  ExternalApp,
  CreateExternalAppInput,
  UpdateExternalAppInput,
  ExternalAppHealth,
} from '@/types/external-apps';

/**
 * External app management interface
 * Provides CRUD operations and health checks for external apps
 */
export interface IExternalAppManager {
  /**
   * Get external app by path prefix
   * @param pathPrefix - The path prefix to look up
   * @returns ExternalApp if found, null otherwise
   */
  getByPathPrefix(pathPrefix: string): Promise<ExternalApp | null>;

  /**
   * Get external app by ID
   * @param id - The app ID
   * @returns ExternalApp if found, null otherwise
   */
  getById(id: string): Promise<ExternalApp | null>;

  /**
   * Get all external apps (including disabled)
   * @returns Array of all ExternalApps
   */
  getAll(): Promise<ExternalApp[]>;

  /**
   * Get only enabled external apps
   * @returns Array of enabled ExternalApps
   */
  getEnabled(): Promise<ExternalApp[]>;

  /**
   * Create a new external app
   * @param input - Creation input
   * @returns Created ExternalApp
   * @throws Error if name or pathPrefix already exists
   */
  create(input: CreateExternalAppInput): Promise<ExternalApp>;

  /**
   * Update an existing external app
   * @param id - App ID to update
   * @param input - Update input (only provided fields are updated)
   * @returns Updated ExternalApp
   * @throws Error if app not found
   */
  update(id: string, input: UpdateExternalAppInput): Promise<ExternalApp>;

  /**
   * Delete an external app
   * @param id - App ID to delete
   */
  delete(id: string): Promise<void>;

  /**
   * Check health of an external app (port connectivity)
   * @param id - App ID to check
   * @returns Health status
   */
  checkHealth(id: string): Promise<ExternalAppHealth>;
}

/**
 * Proxy handler interface for HTTP and WebSocket proxying
 */
export interface IProxyHandler {
  /**
   * Proxy an HTTP request to the upstream app
   * @param request - Incoming request
   * @param app - Target external app configuration
   * @param path - Request path (after removing /proxy/{pathPrefix})
   * @returns Proxied response
   */
  proxyHttp(
    request: Request,
    app: ExternalApp,
    path: string
  ): Promise<Response>;

  /**
   * Handle a WebSocket upgrade request
   *
   * Note: Next.js Route Handlers do not support WebSocket upgrades directly.
   * Returns a 426 Upgrade Required response with a fixed error message.
   * Issue #395: Response no longer includes directUrl or internal URL information
   * to prevent leaking upstream host/port details.
   *
   * @param request - Incoming WebSocket upgrade request
   * @param app - Target external app configuration
   * @param path - Request path
   * @returns A 426 response indicating WebSocket is not supported
   */
  proxyWebSocket(
    request: Request,
    app: ExternalApp,
    path: string
  ): Promise<Response>;
}
