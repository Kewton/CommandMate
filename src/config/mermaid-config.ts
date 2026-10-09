/**
 * Mermaid configuration constants
 *
 * Centralizes all mermaid.initialize() settings for DRY principle.
 * Theme switching or configuration changes should only modify this file.
 *
 * @module config/mermaid-config
 * @see https://mermaid.js.org/config/setup/modules/mermaidAPI.html#mermaidapi-configuration-defaults
 */

/** The two mermaid themes the app draws with — one per app theme (Issue #3503). */
export type MermaidTheme = 'default' | 'dark';

/**
 * Config keys a diagram's own frontmatter / `%%{init}%%` directive may NOT
 * override (mermaid's `secure` list; its sanitizer deletes them from every
 * directive).
 *
 * The first six are mermaid's own defaults — `secure` replaces the default list
 * rather than extending it, so they are restated. The theme keys are added by
 * Issue #3503: the app's theme wins over a `theme:` written in the source, so a
 * diagram drawn in a dark bubble is never forced back to light colours (or the
 * reverse). Every non-theme setting a source writes is still honoured.
 */
export const MERMAID_SECURE_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'theme',
  'themeVariables',
  'themeCSS',
  'darkMode',
] as const;

/**
 * Mermaid configuration for secure diagram rendering
 *
 * SECURITY WARNING: Do not change securityLevel from 'strict'.
 * This is a critical security setting that prevents XSS attacks.
 *
 * @see SEC-SF-003 Security review requirement
 */
export const MERMAID_CONFIG = {
  /**
   * [SEC-001] XSS script prevention - must be 'strict' in production
   *
   * WARNING: Do not change this value to anything other than 'strict'.
   * Values other than 'strict' can introduce XSS vulnerabilities.
   * MermaidDiagram.tsx validates this setting at initialization.
   *
   * @see SEC-SF-003 Security review requirement
   */
  securityLevel: 'strict' as const,
  /** Disable auto-rendering (use manual render() call) */
  startOnLoad: false,
  /**
   * Base theme. The theme actually drawn with is chosen per app theme by
   * {@link buildMermaidConfig} (Issue #3503).
   */
  theme: 'default' as MermaidTheme,
  /**
   * [Issue #3503] A syntax error throws instead of drawing mermaid's error
   * diagram, and the temporary element mermaid adds to `document.body` is
   * removed on that path too (without this, a failed render leaves it behind).
   */
  suppressErrorRendering: true,
  /** [Issue #3503] See {@link MERMAID_SECURE_KEYS}. */
  secure: MERMAID_SECURE_KEYS,
} as const;

/** Type definition for Mermaid configuration */
export type MermaidConfig = typeof MERMAID_CONFIG;

/**
 * Map the app's resolved theme (`next-themes`' `resolvedTheme`) to a mermaid
 * theme. Anything that is not a known app theme returns `null` — "not decided
 * yet" — so the caller does not draw with a guess.
 */
export function resolveMermaidTheme(appTheme: string | null | undefined): MermaidTheme | null {
  if (appTheme === 'dark') return 'dark';
  if (appTheme === 'light') return 'default';
  return null;
}

/** The object handed to `mermaid.initialize` for one theme. */
export function buildMermaidConfig(theme: MermaidTheme): {
  securityLevel: 'strict';
  startOnLoad: false;
  theme: MermaidTheme;
  suppressErrorRendering: true;
  secure: string[];
} {
  return {
    ...MERMAID_CONFIG,
    theme,
    secure: [...MERMAID_CONFIG.secure],
  };
}
