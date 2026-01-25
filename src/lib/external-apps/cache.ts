/**
 * Cache layer for external apps
 * Issue #42: Proxy routing for multiple frontend applications
 *
 * Provides memory caching with TTL to reduce DB queries during proxy requests.
 * Uses Map-based cache with configurable TTL (default: 30 seconds).
 */

import type Database from 'better-sqlite3';
import type { ExternalApp } from '@/types/external-apps';
import { getEnabledExternalApps } from './db';

/**
 * External app cache class
 * Caches enabled external apps for fast proxy lookups
 */
export class ExternalAppCache {
  private cache: Map<string, ExternalApp> = new Map();
  private allAppsCache: ExternalApp[] | null = null;
  private lastRefresh: number = 0;
  private readonly ttl: number;
  private readonly db: Database.Database;

  /**
   * Create a new cache instance
   * @param db - Database instance
   * @param ttl - Time-to-live in milliseconds (default: 30000 = 30 seconds)
   */
  constructor(db: Database.Database, ttl: number = 30000) {
    this.db = db;
    this.ttl = ttl;
  }

  /**
   * Get the configured TTL
   */
  getTTL(): number {
    return this.ttl;
  }

  /**
   * Check if cache is stale (TTL expired or never refreshed)
   */
  isStale(): boolean {
    return Date.now() - this.lastRefresh > this.ttl;
  }

  /**
   * Refresh cache from database
   */
  async refresh(): Promise<void> {
    const apps = getEnabledExternalApps(this.db);

    this.cache.clear();
    for (const app of apps) {
      this.cache.set(app.pathPrefix, app);
    }

    this.allAppsCache = apps;
    this.lastRefresh = Date.now();
  }

  /**
   * Get external app by path prefix
   * Only returns enabled apps
   * @param pathPrefix - The path prefix to look up
   * @returns ExternalApp if found and enabled, null otherwise
   */
  async getByPathPrefix(pathPrefix: string): Promise<ExternalApp | null> {
    if (this.isStale()) {
      await this.refresh();
    }

    return this.cache.get(pathPrefix) ?? null;
  }

  /**
   * Get all enabled external apps
   * @returns Array of enabled ExternalApps
   */
  async getAll(): Promise<ExternalApp[]> {
    if (this.isStale()) {
      await this.refresh();
    }

    return this.allAppsCache ?? [];
  }

  /**
   * Invalidate cache
   * Should be called after create/update/delete operations
   */
  invalidate(): void {
    this.cache.clear();
    this.allAppsCache = null;
    this.lastRefresh = 0;
  }
}

// Singleton instance (will be lazily initialized)
let _cacheInstance: ExternalAppCache | null = null;

/**
 * Get or create the singleton cache instance
 * Note: This requires a database instance to be available
 * @param db - Database instance (required for first call)
 */
export function getExternalAppCache(db?: Database.Database): ExternalAppCache {
  if (!_cacheInstance) {
    if (!db) {
      throw new Error('Database instance required to initialize cache');
    }
    _cacheInstance = new ExternalAppCache(db);
  }
  return _cacheInstance;
}

/**
 * Reset the singleton cache instance (for testing)
 */
export function resetCacheInstance(): void {
  _cacheInstance = null;
}

/**
 * Export the singleton for direct access
 * Note: This is a getter that throws if not initialized
 */
export const externalAppCache = {
  get instance(): ExternalAppCache {
    if (!_cacheInstance) {
      throw new Error('Cache not initialized. Call getExternalAppCache(db) first.');
    }
    return _cacheInstance;
  },
};
