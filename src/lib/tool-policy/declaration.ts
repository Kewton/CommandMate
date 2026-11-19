/**
 * Reads the user's Antigravity usage declaration (Issue #4436).
 *
 * Kept apart from `policy.ts` because the source may move to a setting on the web UI or
 * the DB later; `policy.ts` takes the declaration as an argument and never imports this
 * file. The declaration is taken as stated — no credentials are read.
 *
 * @module lib/tool-policy/declaration
 */

import { USAGE_DECLARATION_ENV, type UsageDeclaration } from './policy';

const DECLARED_VALUES: readonly UsageDeclaration[] = ['personal', 'api-key', 'enterprise'];

/**
 * Read `CM_ANTIGRAVITY_USAGE`. Surrounding whitespace is trimmed and only the exact
 * lowercase values `api-key` / `enterprise` (or `personal`) are accepted; unset or any
 * other value is `'personal'` (refused by default).
 */
export function readUsageDeclaration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): UsageDeclaration {
  const raw = env[USAGE_DECLARATION_ENV];
  if (typeof raw !== 'string') return 'personal';
  const value = raw.trim();
  return (DECLARED_VALUES as readonly string[]).includes(value) ? (value as UsageDeclaration) : 'personal';
}
