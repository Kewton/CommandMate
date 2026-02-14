/**
 * CommandMate CLI Entry Point
 * Issue #96: npm install CLI support
 */

import { Command } from 'commander';
import { initCommand } from './commands/init';
import { startCommand } from './commands/start';
import { stopCommand } from './commands/stop';
import { statusCommand } from './commands/status';
import { createIssueCommand } from './commands/issue';
import { createDocsCommand } from './commands/docs';

// Read version from package.json
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../../package.json');

const program = new Command();

program
  .name('commandmate')
  .description('Git worktree management with Claude CLI and tmux sessions')
  .version(pkg.version);

// Init command
program
  .command('init')
  .description('Initialize CommandMate configuration')
  .option('-d, --defaults', 'Use default values (non-interactive)')
  .option('-f, --force', 'Overwrite existing configuration')
  .action(async (options) => {
    await initCommand({
      defaults: options.defaults,
      force: options.force,
    });
  });

// Start command
// Issue #136: Add --issue and --auto-port flags for worktree support
program
  .command('start')
  .description('Start the CommandMate server')
  .option('--dev', 'Start in development mode')
  .option('--daemon', 'Run in background')
  .option('-p, --port <number>', 'Override port number', parseInt)
  .option('-i, --issue <number>', 'Start server for specific issue worktree', parseInt)
  .option('--auto-port', 'Automatically allocate port for worktree server')
  .action(async (options) => {
    await startCommand({
      dev: options.dev,
      daemon: options.daemon,
      port: options.port,
      issue: options.issue,
      autoPort: options.autoPort,
    });
  });

// Stop command
// Issue #136: Add --issue flag for worktree-specific server stop
program
  .command('stop')
  .description('Stop the CommandMate server')
  .option('-f, --force', 'Force stop (SIGKILL)')
  .option('-i, --issue <number>', 'Stop server for specific issue worktree', parseInt)
  .action(async (options) => {
    await stopCommand({
      force: options.force,
      issue: options.issue,
    });
  });

// Status command
// Issue #136: Add --issue and --all flags for worktree-specific status
program
  .command('status')
  .description('Show server status')
  .option('-i, --issue <number>', 'Show status for specific issue worktree', parseInt)
  .option('-a, --all', 'Show status for all servers (main + worktrees)')
  .action(async (options) => {
    await statusCommand({
      issue: options.issue,
      all: options.all,
    });
  });

// Issue #264: issue/docs commands (addCommand pattern for subcommand support)
program.addCommand(createIssueCommand());
program.addCommand(createDocsCommand());

// Issue #264: AI Tool Integration help section
program.addHelpText('after', `
AI Tool Integration:
  Use with Claude Code or Codex to manage issues:
    commandmate issue create --bug --title "Title" --body "Description"
    commandmate issue create --question --title "How to..." --body "Details"
    commandmate docs --section quick-start
`);

// Parse and execute
program.parse();
