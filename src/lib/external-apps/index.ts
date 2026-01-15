/**
 * External apps module
 * Issue #42: Proxy routing for multiple frontend applications
 */

// Re-export types
export type {
  ExternalApp,
  ExternalAppType,
  CreateExternalAppInput,
  UpdateExternalAppInput,
  ExternalAppHealth,
} from '@/types/external-apps';

// Re-export interfaces
export type { IExternalAppManager, IProxyHandler } from './interfaces';

// Re-export DB operations
export {
  createExternalApp,
  getExternalAppById,
  getExternalAppByPathPrefix,
  getAllExternalApps,
  getEnabledExternalApps,
  updateExternalApp,
  deleteExternalApp,
  mapDbRowToExternalApp,
  mapExternalAppToDbRow,
} from './db';

// Re-export cache
export {
  ExternalAppCache,
  getExternalAppCache,
  resetCacheInstance,
  externalAppCache,
} from './cache';
