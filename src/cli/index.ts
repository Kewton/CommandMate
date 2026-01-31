/**
 * CommandMate CLI Entry Point
 * Issue #96: npm install CLI support
 */

import { Command } from 'commander';
import { initCommand } from './commands/init';
import { startCommand } from './commands/start';
import { stopCommand } from './commands/stop';
import { statusCommand } from './commands/status';

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
program
  .command('start')
  .description('Start the CommandMate server')
  .option('--dev', 'Start in development mode')
  .option('--daemon', 'Run in background')
  .option('-p, --port <number>', 'Override port number', parseInt)
  .action(async (options) => {
    await startCommand({
      dev: options.dev,
      daemon: options.daemon,
      port: options.port,
    });
  });

// Stop command
program
  .command('stop')
  .description('Stop the CommandMate server')
  .option('-f, --force', 'Force stop (SIGKILL)')
  .action(async (options) => {
    await stopCommand({
      force: options.force,
    });
  });

// Status command
program
  .command('status')
  .description('Show server status')
  .action(async () => {
    await statusCommand();
  });

// Parse and execute
program.parse();
