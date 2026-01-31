/**
 * CLI Logger with colored output
 * Issue #96: npm install CLI support
 */

export interface LoggerOptions {
  /** Enable verbose/debug output */
  verbose?: boolean;
}

/**
 * ANSI color codes for terminal output
 */
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // Text colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

/**
 * CLI Logger with colored output
 */
export class CLILogger {
  private verbose: boolean;

  constructor(options: LoggerOptions = {}) {
    this.verbose = options.verbose ?? false;
  }

  /**
   * Log info message
   */
  info(message: string): void {
    console.log(`${colors.blue}[INFO]${colors.reset} ${message}`);
  }

  /**
   * Log success message with checkmark
   */
  success(message: string): void {
    console.log(`${colors.green}[✓]${colors.reset} ${message}`);
  }

  /**
   * Log warning message
   */
  warn(message: string): void {
    console.log(`${colors.yellow}[WARN]${colors.reset} ${message}`);
  }

  /**
   * Log error message to stderr
   */
  error(message: string): void {
    console.error(`${colors.red}[ERROR]${colors.reset} ${message}`);
  }

  /**
   * Log debug message (only when verbose is enabled)
   */
  debug(message: string): void {
    if (this.verbose) {
      console.log(`${colors.gray}[DEBUG]${colors.reset} ${message}`);
    }
  }

  /**
   * Print blank line
   */
  blank(): void {
    console.log('');
  }

  /**
   * Print formatted header
   */
  header(title: string): void {
    const line = '='.repeat(title.length + 4);
    console.log(`${colors.bold}${colors.cyan}${line}${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}  ${title}  ${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}${line}${colors.reset}`);
  }

  /**
   * Format duration in human-readable format
   */
  static formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}s`;
    }

    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (days > 0) {
      return `${days}d ${hours}h`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m ${secs}s`;
  }
}
