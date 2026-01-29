/**
 * Structured logging utility for CommandMate
 *
 * Issue #41: Structured logging + log level control
 *
 * Features:
 * - [MF-1] Sensitive data filtering (sanitize)
 * - [MF-2] Server/Client log separation
 * - [SF-2] Request ID generation
 *
 * @example
 * ```typescript
 * const logger = createLogger('prompt-detector');
 * logger.debug('detectPrompt:start', { outputLength: 1500 });
 *
 * const log = logger.withContext({ worktreeId: 'wt-1', requestId: generateRequestId() });
 * log.info('action:complete', { result: 'success' });
 * ```
 */

import { getLogConfig } from './env';

// ============================================================
// Type Definitions
// ============================================================

/**
 * Log level definition
 * debug < info < warn < error
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured log entry
 */
export interface LogEntry {
  level: LogLevel;
  module: string;
  action: string;
  data?: Record<string, unknown>;
  timestamp: string;
  worktreeId?: string;
  cliToolId?: string;
  requestId?: string;
}

/**
 * Logger context
 */
export interface LoggerContext {
  worktreeId?: string;
  cliToolId?: string;
  requestId?: string;
}

/**
 * Logger instance type
 */
export interface Logger {
  debug: (action: string, data?: Record<string, unknown>) => void;
  info: (action: string, data?: Record<string, unknown>) => void;
  warn: (action: string, data?: Record<string, unknown>) => void;
  error: (action: string, data?: Record<string, unknown>) => void;
  /** Generate context-attached logger */
  withContext: (context: LoggerContext) => Logger;
}

// ============================================================
// [MF-1] Sensitive Data Filtering
// ============================================================

/**
 * Sensitive data patterns
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Bearer token
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: 'Bearer [REDACTED]' },
  // Password related
  { pattern: /(password|passwd|pwd)[=:]\s*\S+/gi, replacement: '$1=[REDACTED]' },
  // Token/secret related
  { pattern: /(token|secret|api_key|apikey|auth)[=:]\s*\S+/gi, replacement: '$1=[REDACTED]' },
  // CM_AUTH_TOKEN (new name - Issue #76)
  { pattern: /CM_AUTH_TOKEN=\S+/gi, replacement: 'CM_AUTH_TOKEN=[REDACTED]' },
  // MCBD_AUTH_TOKEN (legacy name)
  { pattern: /MCBD_AUTH_TOKEN=\S+/gi, replacement: 'MCBD_AUTH_TOKEN=[REDACTED]' },
  // Authorization header
  { pattern: /Authorization:\s*\S+/gi, replacement: 'Authorization: [REDACTED]' },
  // SSH key
  { pattern: /-----BEGIN\s+\w+\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+\w+\s+PRIVATE\s+KEY-----/g, replacement: '[SSH_KEY_REDACTED]' },
];

/**
 * Sensitive key name patterns
 */
const SENSITIVE_KEY_PATTERN = /password|secret|token|key|auth/i;

/**
 * Sanitize value (mask sensitive data)
 */
function sanitize(value: unknown): unknown {
  if (typeof value === 'string') {
    let sanitized = value;
    for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
      sanitized = sanitized.replace(pattern, replacement);
    }
    return sanitized;
  }

  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return value.map(sanitize);
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Mask if key name is sensitive
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = sanitize(v);
      }
    }
    return result;
  }

  return value;
}

// ============================================================
// [MF-2] Server/Client Log Separation
// ============================================================

/**
 * Check if running on server side
 */
function isServer(): boolean {
  return typeof window === 'undefined';
}

/**
 * Check if should log on client side
 * Only output in development environment
 */
function shouldLogOnClient(): boolean {
  return process.env.NODE_ENV === 'development';
}

// ============================================================
// Log Level Control
// ============================================================

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Get current log level
 * [SF-1] Get from env.ts
 */
function getCurrentLogLevel(): LogLevel {
  const config = getLogConfig();
  return config.level;
}

/**
 * Get log output format
 * [SF-1] Get from env.ts
 */
function getLogFormat(): 'json' | 'text' {
  const config = getLogConfig();
  return config.format;
}

// ============================================================
// Log Output
// ============================================================

/**
 * Format log entry
 */
function formatLogEntry(entry: LogEntry): string {
  if (getLogFormat() === 'json') {
    return JSON.stringify(entry);
  }

  // Text format
  const { timestamp, level, module, action, data, worktreeId, cliToolId, requestId } = entry;
  const contextParts = [worktreeId, cliToolId].filter(Boolean);
  const contextStr = contextParts.length > 0 ? ` [${contextParts.join(':')}]` : '';
  const requestIdStr = requestId ? ` (${requestId.slice(0, 8)})` : '';
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';

  return `[${timestamp}] [${level.toUpperCase()}] [${module}]${contextStr}${requestIdStr} ${action}${dataStr}`;
}

/**
 * Execute log output
 */
function log(
  level: LogLevel,
  module: string,
  action: string,
  data?: Record<string, unknown>,
  context?: LoggerContext
): void {
  const currentLevel = getCurrentLogLevel();
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) {
    return; // Do not output if below threshold
  }

  // [MF-2] Only output on client side in development environment
  if (!isServer() && !shouldLogOnClient()) {
    return;
  }

  // [MF-1] Sanitize data
  const sanitizedData = data ? (sanitize(data) as Record<string, unknown>) : undefined;

  const entry: LogEntry = {
    level,
    module,
    action,
    timestamp: new Date().toISOString(),
    ...context,
    ...(sanitizedData && { data: sanitizedData }),
  };

  const formatted = formatLogEntry(entry);

  // Server side: structured log, Client side: console group
  if (isServer()) {
    switch (level) {
      case 'error':
        console.error(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      default:
        console.log(formatted);
    }
  } else {
    // Client side (development only)
    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[consoleMethod](`[${module}] ${action}`, sanitizedData || '');
  }
}

// ============================================================
// [SF-2] Request ID Generation
// ============================================================

/**
 * Generate request ID
 * UUID v4 format
 */
export function generateRequestId(): string {
  // crypto.randomUUID() is available in Node.js 19+ and modern browsers
  // Provide fallback implementation
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: simple random ID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================================
// Logger Factory
// ============================================================

/**
 * Create module-specific logger
 *
 * @param module - Module name (e.g., 'prompt-detector', 'cli-session')
 * @returns Logger instance
 *
 * @example
 * ```typescript
 * const logger = createLogger('api-worktrees');
 *
 * // Basic usage
 * logger.info('GET:start');
 * logger.debug('statusCheck', { worktreeId: 'wt-1' });
 *
 * // With context
 * const log = logger.withContext({ worktreeId: 'wt-1', requestId: generateRequestId() });
 * log.info('action:complete');
 * ```
 */
export function createLogger(module: string): Logger {
  const createLoggerWithContext = (context?: LoggerContext): Logger => ({
    debug: (action, data) => log('debug', module, action, data, context),
    info: (action, data) => log('info', module, action, data, context),
    warn: (action, data) => log('warn', module, action, data, context),
    error: (action, data) => log('error', module, action, data, context),
    withContext: (newContext) => createLoggerWithContext({ ...context, ...newContext }),
  });

  return createLoggerWithContext();
}
