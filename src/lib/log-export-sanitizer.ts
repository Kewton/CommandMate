/**
 * Log Export Sanitizer
 * Issue #11: Sanitizes log content for safe export/sharing
 *
 * Masks sensitive information including:
 * - HOME directory paths -> [HOME]
 * - CM_ROOT_DIR (project root) paths -> [PROJECT]
 * - CM_DB_PATH -> [DB_PATH]
 * - Hostname (via os.hostname()) -> [HOST]
 * - Bearer tokens -> Bearer [REDACTED]
 * - Authorization headers -> Authorization: [REDACTED]
 * - Password/token/secret key-value pairs -> key=[REDACTED]
 * - SSH private keys -> [SSH_PRIVATE_KEY_REDACTED]
 * - Known environment variable values -> key=[REDACTED]
 *
 * Design: Rule-based pattern matching with longest-match-first sorting
 * for path rules to prevent double replacement.
 *
 * @module log-export-sanitizer
 */

import os from 'os';
import { escapeRegExp } from '@/lib/utils';
import { getEnv } from '@/lib/env';

/**
 * Sanitization rule definition
 */
interface SanitizeRule {
  pattern: RegExp;
  replacement: string;
  description: string;
}

/**
 * Build sanitization rules based on current environment.
 *
 * Path rules are sorted by pattern length (longest first) to ensure
 * the most specific path is matched before a more general one.
 * For example, CM_DB_PATH is matched before CM_ROOT_DIR which is
 * matched before HOME.
 *
 * @returns Array of sanitization rules ordered for correct application
 */
function buildSanitizeRules(): SanitizeRule[] {
  const home = process.env.HOME ?? '';
  const env = getEnv();
  const hostname = os.hostname();

  const rules: SanitizeRule[] = [];

  // === Path/environment info rules ===

  // HOME path replacement
  if (home) {
    rules.push({
      pattern: new RegExp(escapeRegExp(home), 'g'),
      replacement: '[HOME]',
      description: 'Home directory path masking',
    });
  }

  // CM_ROOT_DIR path replacement
  if (env.CM_ROOT_DIR) {
    rules.push({
      pattern: new RegExp(escapeRegExp(env.CM_ROOT_DIR), 'g'),
      replacement: '[PROJECT]',
      description: 'Project root path masking',
    });
  }

  // CM_DB_PATH path replacement
  if (env.CM_DB_PATH) {
    rules.push({
      pattern: new RegExp(escapeRegExp(env.CM_DB_PATH), 'g'),
      replacement: '[DB_PATH]',
      description: 'Database path masking',
    });
  }

  // Hostname replacement
  if (hostname) {
    rules.push({
      pattern: new RegExp(escapeRegExp(hostname), 'g'),
      replacement: '[HOST]',
      description: 'Hostname masking',
    });
  }

  // === Sensitive data patterns (S4-MF-002: same as logger.ts SENSITIVE_PATTERNS) ===

  // Bearer tokens
  rules.push({
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    replacement: 'Bearer [REDACTED]',
    description: 'Bearer token masking',
  });

  // Authorization header values
  rules.push({
    pattern: /[Aa]uthorization:\s*\S+/g,
    replacement: 'Authorization: [REDACTED]',
    description: 'Authorization header masking',
  });

  // Password/token/secret/api-key key-value pairs
  rules.push({
    pattern: /(password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)[=:]\s*\S+/gi,
    replacement: '$1=[REDACTED]',
    description: 'Password/token/secret key-value pair masking',
  });

  // SSH private keys
  rules.push({
    pattern: /-----BEGIN\s+(RSA|DSA|EC|OPENSSH)?\s*PRIVATE KEY-----[\s\S]*?-----END\s+(RSA|DSA|EC|OPENSSH)?\s*PRIVATE KEY-----/g,
    replacement: '[SSH_PRIVATE_KEY_REDACTED]',
    description: 'SSH private key masking',
  });

  // Known environment variable values (GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, etc.)
  rules.push({
    pattern: /(GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|OPENAI_API_KEY|ANTHROPIC_API_KEY|DATABASE_URL|REDIS_URL)[=:]\s*\S+/g,
    replacement: '$1=[REDACTED]',
    description: 'Known environment variable value masking',
  });

  // Sort path rules by pattern length (longest first) to ensure longest-match-first
  // Sensitive data patterns use fixed regex so they don't need sorting
  const pathReplacements = ['[HOME]', '[PROJECT]', '[DB_PATH]', '[HOST]'];
  const pathRules = rules.filter((r) => pathReplacements.includes(r.replacement));
  const sensitiveRules = rules.filter((r) => !pathReplacements.includes(r.replacement));
  pathRules.sort((a, b) => b.pattern.source.length - a.pattern.source.length);

  return [...pathRules, ...sensitiveRules];
}

/**
 * Sanitize log content for safe export/sharing.
 *
 * Applies all sanitization rules to mask sensitive information
 * while preserving relative paths, filenames, and error messages.
 *
 * @param content - Raw log content to sanitize
 * @returns Sanitized content with sensitive data masked
 *
 * @example
 * ```typescript
 * const sanitized = sanitizeForExport(logContent);
 * // HOME paths replaced with [HOME]
 * // Bearer tokens replaced with Bearer [REDACTED]
 * // etc.
 * ```
 */
export function sanitizeForExport(content: string): string {
  const rules = buildSanitizeRules();

  let result = content;
  for (const rule of rules) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  return result;
}
