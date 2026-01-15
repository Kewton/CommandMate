/**
 * Shared validation constants and utilities for external apps
 * Issue #42: Proxy routing for multiple frontend applications
 *
 * This module provides centralized validation logic used by both
 * the API layer and the UI components.
 */

import type { ExternalAppType } from '@/types/external-apps';

/**
 * Port range constants
 */
export const PORT_CONSTRAINTS = {
  /** Minimum valid port number (avoid reserved ports) */
  MIN: 1024,
  /** Maximum valid port number */
  MAX: 65535,
} as const;

/**
 * Valid target hosts for security
 * Only allow localhost connections for external apps
 */
export const VALID_TARGET_HOSTS = ['localhost', '127.0.0.1'] as const;

/**
 * Valid path prefix pattern
 * Only alphanumeric characters and hyphens are allowed
 */
export const PATH_PREFIX_PATTERN = /^[a-zA-Z0-9-]+$/;

/**
 * Valid app types for external applications
 */
export const VALID_APP_TYPES: readonly ExternalAppType[] = [
  'sveltekit',
  'streamlit',
  'nextjs',
  'other',
] as const;

/**
 * App type display labels for UI
 */
export const APP_TYPE_LABELS: Record<ExternalAppType, string> = {
  sveltekit: 'SvelteKit',
  streamlit: 'Streamlit',
  nextjs: 'Next.js',
  other: 'Other',
} as const;

/**
 * Validation error structure
 */
export interface ValidationError {
  /** Field that failed validation */
  field: string;
  /** Human-readable error message */
  message: string;
}

/**
 * Validate that a port number is within the allowed range
 *
 * @param port - Port number to validate
 * @returns true if port is valid
 */
export function isValidPort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= PORT_CONSTRAINTS.MIN &&
    port <= PORT_CONSTRAINTS.MAX
  );
}

/**
 * Validate that a path prefix matches the required pattern
 *
 * @param pathPrefix - Path prefix to validate
 * @returns true if path prefix is valid
 */
export function isValidPathPrefix(pathPrefix: string): boolean {
  return (
    typeof pathPrefix === 'string' &&
    pathPrefix.length > 0 &&
    PATH_PREFIX_PATTERN.test(pathPrefix)
  );
}

/**
 * Validate that a target host is in the allowed list
 *
 * @param host - Host to validate
 * @returns true if host is valid
 */
export function isValidTargetHost(host: string): boolean {
  return VALID_TARGET_HOSTS.includes(host as typeof VALID_TARGET_HOSTS[number]);
}

/**
 * Validate that an app type is valid
 *
 * @param appType - App type to validate
 * @returns true if app type is valid
 */
export function isValidAppType(appType: string): appType is ExternalAppType {
  return VALID_APP_TYPES.includes(appType as ExternalAppType);
}

/**
 * Validate create external app input (API-level validation)
 *
 * @param input - Raw input to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateCreateInput(input: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!input || typeof input !== 'object') {
    errors.push({ field: 'body', message: 'Request body is required' });
    return errors;
  }

  const data = input as Record<string, unknown>;

  // Required string fields
  if (!data.name || typeof data.name !== 'string') {
    errors.push({ field: 'name', message: 'name is required and must be a string' });
  }

  if (!data.displayName || typeof data.displayName !== 'string') {
    errors.push({ field: 'displayName', message: 'displayName is required and must be a string' });
  }

  // Path prefix validation
  if (!data.pathPrefix || typeof data.pathPrefix !== 'string') {
    errors.push({ field: 'pathPrefix', message: 'pathPrefix is required and must be a string' });
  } else if (!isValidPathPrefix(data.pathPrefix as string)) {
    errors.push({
      field: 'pathPrefix',
      message: 'pathPrefix must contain only alphanumeric characters and hyphens',
    });
  }

  // Port validation
  if (data.targetPort === undefined || typeof data.targetPort !== 'number') {
    errors.push({ field: 'targetPort', message: 'targetPort is required and must be a number' });
  } else if (!isValidPort(data.targetPort)) {
    errors.push({
      field: 'targetPort',
      message: `targetPort must be between ${PORT_CONSTRAINTS.MIN} and ${PORT_CONSTRAINTS.MAX}`,
    });
  }

  // App type validation
  if (!data.appType || typeof data.appType !== 'string') {
    errors.push({ field: 'appType', message: 'appType is required and must be a string' });
  } else if (!isValidAppType(data.appType)) {
    errors.push({
      field: 'appType',
      message: `appType must be one of: ${VALID_APP_TYPES.join(', ')}`,
    });
  }

  // Optional target host validation
  if (data.targetHost !== undefined && typeof data.targetHost === 'string') {
    if (!isValidTargetHost(data.targetHost)) {
      errors.push({
        field: 'targetHost',
        message: `targetHost must be one of: ${VALID_TARGET_HOSTS.join(', ')}`,
      });
    }
  }

  return errors;
}

/**
 * Form-level validation errors structure
 */
export interface FormValidationErrors {
  displayName?: string;
  name?: string;
  pathPrefix?: string;
  targetPort?: string;
  appType?: string;
}

/**
 * Validate form data for external app creation/editing
 * Used by UI components
 *
 * @param data - Form data to validate
 * @param isEdit - Whether this is an edit operation (skips immutable fields)
 * @returns Object with field-specific error messages
 */
export function validateFormData(
  data: {
    displayName?: string;
    name?: string;
    pathPrefix?: string;
    targetPort?: number | '';
    appType?: string;
  },
  isEdit: boolean
): FormValidationErrors {
  const errors: FormValidationErrors = {};

  // Display name is always required
  if (!data.displayName?.trim()) {
    errors.displayName = 'Display name is required';
  }

  // Name and pathPrefix are only validated for create (immutable on edit)
  if (!isEdit) {
    if (!data.name?.trim()) {
      errors.name = 'Identifier name is required';
    } else if (!PATH_PREFIX_PATTERN.test(data.name)) {
      errors.name = 'Only alphanumeric characters and hyphens are allowed';
    }

    if (!data.pathPrefix?.trim()) {
      errors.pathPrefix = 'Path prefix is required';
    } else if (!PATH_PREFIX_PATTERN.test(data.pathPrefix)) {
      errors.pathPrefix = 'Only alphanumeric characters and hyphens are allowed';
    }
  }

  // Port validation
  if (!data.targetPort) {
    errors.targetPort = 'Port number is required';
  } else if (typeof data.targetPort === 'number' && !isValidPort(data.targetPort)) {
    errors.targetPort = `Port must be between ${PORT_CONSTRAINTS.MIN} and ${PORT_CONSTRAINTS.MAX}`;
  }

  // App type (only for create)
  if (!isEdit && !data.appType) {
    errors.appType = 'App type is required';
  }

  return errors;
}
