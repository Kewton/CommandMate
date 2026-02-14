/**
 * Issue Command
 * Issue #264: gh CLI integration for issue management
 *
 * [MF-CONS-001] Uses createIssueCommand() factory + addCommand() pattern
 * because subcommands (create/search/list) require nested Command definition,
 * which is not possible with the inline program.command().action() pattern
 * used by init/start/stop/status.
 *
 * Security:
 * - [SEC-MF-001] Input length validation (title: 256, body: 65536)
 * - [SEC-SF-001] Label sanitization (control/zero-width character removal)
 * - Command injection prevention: spawnSync with array args (no shell: true)
 *
 * @module issue-command
 */

import { Command } from 'commander';
import { spawnSync } from 'child_process';
import { ExitCode, IssueCreateOptions } from '../types';
import {
  validateIssueTitle,
  validateIssueBody,
  sanitizeLabel,
} from '../utils/input-validators';

/**
 * gh CLI template name mapping.
 * Uses front matter `name` values, NOT filenames.
 * UI URLs use `template=bug_report.md` (filename) for web interface.
 */
const TEMPLATE_MAP: Record<string, string> = {
  bug: 'Bug Report',
  feature: 'Feature Request',
  question: 'Question',
};

/**
 * Check if gh CLI is available.
 */
function isGhAvailable(): boolean {
  const result = spawnSync('gh', ['--version'], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  return !result.error && result.status === 0;
}

/**
 * Guard: exit with DEPENDENCY_ERROR if gh CLI is not installed.
 * [DRY] Extracted from repeated checks in create/search/list subcommands.
 */
function requireGhCli(): void {
  if (!isGhAvailable()) {
    console.error('Error: gh CLI is not installed. Install it from https://cli.github.com/');
    process.exit(ExitCode.DEPENDENCY_ERROR);
  }
}

/**
 * Create the issue command with subcommands.
 * [MF-CONS-001] Returns a Command instance for program.addCommand().
 */
export function createIssueCommand(): Command {
  const issueCommand = new Command('issue')
    .description('Manage GitHub issues (requires gh CLI)');

  // Subcommand: create
  issueCommand
    .command('create')
    .description('Create a new GitHub issue')
    .option('--bug', 'Use bug report template')
    .option('--feature', 'Use feature request template')
    .option('--question', 'Use question template')
    .option('--title <title>', 'Issue title')
    .option('--body <body>', 'Issue body')
    .option('--labels <labels>', 'Labels (comma-separated)')
    .action((options: IssueCreateOptions) => {
      requireGhCli();

      // [SEC-MF-001] Input length validation
      if (options.title) {
        const titleResult = validateIssueTitle(options.title);
        if (!titleResult.valid) {
          console.error(`Error: ${titleResult.error}`);
          process.exit(ExitCode.UNEXPECTED_ERROR);
        }
      }

      if (options.body) {
        const bodyResult = validateIssueBody(options.body);
        if (!bodyResult.valid) {
          console.error(`Error: ${bodyResult.error}`);
          process.exit(ExitCode.UNEXPECTED_ERROR);
        }
      }

      const args: string[] = ['issue', 'create'];

      // Template selection
      const templateKey = options.bug ? 'bug' : options.feature ? 'feature' : options.question ? 'question' : null;
      if (templateKey && TEMPLATE_MAP[templateKey]) {
        args.push('--template', TEMPLATE_MAP[templateKey]);
      }

      if (options.title) {
        args.push('--title', options.title);
      }

      if (options.body) {
        args.push('--body', options.body);
      }

      // [SEC-SF-001] Label sanitization
      if (options.labels) {
        const sanitized = options.labels
          .split(',')
          .map(l => sanitizeLabel(l))
          .filter(l => l.length > 0)
          .join(',');
        if (sanitized) {
          args.push('--label', sanitized);
        }
      }

      // Execute gh CLI with array args (no shell injection)
      const result = spawnSync('gh', args, {
        stdio: 'inherit',
        encoding: 'utf-8',
      });

      process.exit(result.status ?? ExitCode.UNEXPECTED_ERROR);
    });

  // Subcommand: search
  issueCommand
    .command('search <query>')
    .description('Search GitHub issues')
    .action((query: string) => {
      requireGhCli();

      const result = spawnSync('gh', ['issue', 'list', '--search', query], {
        stdio: 'inherit',
        encoding: 'utf-8',
      });

      process.exit(result.status ?? ExitCode.UNEXPECTED_ERROR);
    });

  // Subcommand: list
  issueCommand
    .command('list')
    .description('List GitHub issues')
    .action(() => {
      requireGhCli();

      const result = spawnSync('gh', ['issue', 'list'], {
        stdio: 'inherit',
        encoding: 'utf-8',
      });

      process.exit(result.status ?? ExitCode.UNEXPECTED_ERROR);
    });

  return issueCommand;
}
