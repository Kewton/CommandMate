/**
 * Link Utilities for File Link Navigation
 *
 * Issue #505: Common utilities for link classification, relative path resolution,
 * and href sanitization. Used by MarkdownPreview and HtmlPreview.
 *
 * [DR1-001, DR1-002] Shared module to avoid DRY violations between
 * MarkdownPreview and HtmlPreview.
 *
 * Security note: Client-side path checks are UX-purpose only.
 * Server-side path-validator.ts is the primary security boundary. [DR1-005]
 *
 * @module lib/link-utils
 */

import { defaultSchema } from 'rehype-sanitize';

// ============================================================================
// Types
// ============================================================================

/** Link classification type */
export type LinkType = 'anchor' | 'external' | 'relative';

// ============================================================================
// Functions
// ============================================================================

/**
 * Classify a link href into one of three types.
 * [DR1-002] Shared between MarkdownPreview and HtmlPreview.
 *
 * @param href - The href attribute value
 * @returns The link type classification
 */
export function classifyLink(href: string): LinkType {
  if (href.startsWith('#')) return 'anchor';
  if (
    href.startsWith('http://') ||
    href.startsWith('https://') ||
    href.startsWith('mailto:') ||
    href.startsWith('tel:')
  ) {
    return 'external';
  }
  return 'relative';
}

/**
 * Resolve a relative path against the current file's directory.
 *
 * Uses the URL API for path normalization (resolves ./ and ../ segments).
 * This is a UX-purpose simple check only; security is handled by
 * server-side path-validator.ts. [DR1-005]
 *
 * @param currentFilePath - Path of the file containing the link
 * @param href - The relative href to resolve
 * @returns Resolved path (without leading /), or null if invalid
 */
export function resolveRelativePath(currentFilePath: string, href: string): string | null {
  if (!href) return null;

  const baseDir = currentFilePath.substring(0, currentFilePath.lastIndexOf('/') + 1);

  try {
    const base = new URL(baseDir, 'file:///');
    const resolved = new URL(href, base);
    const resolvedPath = decodeURIComponent(resolved.pathname);

    // [DR1-005] new URL() resolves away '..' so no includes('..') check needed.
    // Simple validation: ensure path is non-empty after stripping leading /
    if (resolvedPath.startsWith('/')) {
      const stripped = resolvedPath.substring(1);
      if (stripped.length > 0) {
        return stripped;
      }
    }
  } catch {
    // Invalid path
  }
  return null;
}

/**
 * Sanitize an href value from untrusted input (e.g., postMessage).
 * [DR4-003] Validates maximum length and excludes control characters.
 *
 * @param href - The href to sanitize
 * @returns The sanitized href, or null if invalid
 */
export function sanitizeHref(href: string): string | null {
  if (!href || href.length === 0) return null;
  if (href.length > 2048) return null;
  if (/[\x00-\x1f\x7f]/.test(href)) return null;
  return href;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Custom rehype-sanitize schema with allowlist approach for href values.
 * [DR4-001] Allows: http:, https:, mailto:, tel:, #anchors, and relative paths.
 * Rejects: javascript:, data:, vbscript:, and any other unknown scheme.
 *
 * The regex uses a negative lookahead to reject any href that looks like
 * an unknown URI scheme (e.g., "scheme:" pattern) unless it matches
 * the explicitly allowed protocols.
 */
export const REHYPE_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [
      // Keep all default 'a' attributes except bare 'href' (which allows any value)
      ...(defaultSchema.attributes?.a ?? []).filter(
        (attr) => attr !== 'href',
      ),
      // Replace with allowlist-filtered href [DR4-001]
      ['href', /^(?:#|mailto:|tel:|https?:\/\/|(?![a-zA-Z][a-zA-Z0-9+.-]*:))/],
    ],
  },
};
