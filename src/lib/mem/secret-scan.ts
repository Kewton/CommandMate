/**
 * Secret-like strings that mem refuses to store (Issue #4221, design §6.1).
 *
 * A rule set with a version: a stored row remembers the version it was checked
 * against, and every exit re-reads a row checked against an older one (§6.4). The
 * logger's `SENSITIVE_PATTERNS` replace text in logs and are not a refusal rule.
 * Nothing here judges by entropy alone.
 *
 * The functions answer the rule id and never the matched text, so a refusal can
 * be reported without repeating what was refused.
 *
 * @module lib/mem/secret-scan
 */

export interface MemSecretRule {
  id: string;
  pattern: RegExp;
}

/** Raise when a rule is added or widened; rows checked against an older one are re-read on the way out. */
export const MEM_SECRET_RULES_VERSION = 1;

export const MEM_SECRET_RULES: readonly MemSecretRule[] = [
  { id: 'private-key-block', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { id: 'authorization-header', pattern: /\bauthorization\s*:\s*(?:basic|bearer|token)\s+\S{8,}/i },
  { id: 'bearer', pattern: /\bbearer\s+[A-Za-z0-9\-._~+/]{16,}=*/i },
  { id: 'url-userinfo', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { id: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/ },
  { id: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/ },
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  {
    id: 'assignment',
    pattern: /\b(?:password|passwd|pwd|token|secret|api[_-]?key|auth)\s*[=:]\s*["']?[^\s"']{8,}/i,
  },
];

/**
 * The id of the first rule a value matches, or null.
 *
 * @param rules - The set to check against; the current one unless a caller re-reads with another
 */
export function findSecretRule(value: string, rules: readonly MemSecretRule[] = MEM_SECRET_RULES): string | null {
  for (const rule of rules) {
    if (rule.pattern.test(value)) return rule.id;
  }
  return null;
}
