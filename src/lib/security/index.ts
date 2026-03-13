// security/ barrel export (named export method)
// isWithinRoot() is @internal - excluded from barrel
// generateToken(), hashToken() are auth-internal - excluded from barrel

// auth.ts: public functions only
export {
  verifyToken,
  parseCookies,
  createRateLimiter,
  isAuthEnabled,
  isHttpsEnabled,
  getTokenMaxAge,
  buildAuthCookieOptions,
  AUTH_COOKIE_NAME,
  AUTH_EXCLUDED_PATHS,
  parseDuration,
  computeExpireAt,
  DEFAULT_EXPIRE_DURATION_MS,
  DEFAULT_COOKIE_MAX_AGE_SECONDS,
  RATE_LIMIT_CONFIG,
  isValidTokenHash,
} from './auth'
export type { AuthCookieOptions, RateLimitResult, RateLimiter } from './auth'

// ip-restriction.ts
export {
  getAllowedRanges,
  isIpAllowed,
  isIpRestrictionEnabled,
  normalizeIp,
  getClientIp,
  parseAllowedIps,
} from './ip-restriction'
export type { CidrRange } from './ip-restriction'

// path-validator.ts: isWithinRoot() excluded (@internal)
export { isPathSafe, validateWorktreePath, resolveAndValidateRealPath } from './path-validator'

// env-sanitizer.ts
export { SENSITIVE_ENV_KEYS, sanitizeEnvForChildProcess } from './env-sanitizer'

// sanitize.ts
export { sanitizeTerminalOutput, sanitizeUserInput, containsDangerousContent } from './sanitize'

// worktree-path-validator.ts
export { isValidWorktreePath } from './worktree-path-validator'
