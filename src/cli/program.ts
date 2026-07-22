/**
 * CommandMate CLI Program Construction
 * Issue #96: npm install CLI support
 * Issue #1195: Extracted from index.ts so the program can be built without parsing argv
 */

import { Command, Option } from 'commander';
import { initCommand } from './commands/init';
import { startCommand } from './commands/start';
import { stopCommand } from './commands/stop';
import { statusCommand } from './commands/status';
// Issue #1194: update command (stop -> npm install -g -> start)
import { updateCommand } from './commands/update';
import { createIssueCommand } from './commands/issue';
import { createDocsCommand } from './commands/docs';
// Issue #518: Agent orchestration commands
import { createLsCommand } from './commands/ls';
import { createSendCommand } from './commands/send';
import { createWaitCommand } from './commands/wait';
import { createRespondCommand } from './commands/respond';
import { createCaptureCommand } from './commands/capture';
import { createAutoYesCommand } from './commands/auto-yes';
// Issue #636: Report command
import { createReportCommand } from './commands/report';
// Issue #1000: Agent-instance roster management (discover/add/remove/alias/kill)
import { createInstancesCommand } from './commands/instances';
// Issue #1237: Skill management as a thin client over the Skill APIs
import { createSkillCommand } from './commands/skill';
// Issue #1195: Guided quickstart for bare `npx commandmate`
import { quickstartCommand } from './commands/quickstart';
import { isInteractive } from './utils/prompt';

// Read version from package.json
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../../package.json');

/** commander marks unknownCommand() as private, so it is absent from the published typings */
interface UnknownCommandReporter {
  unknownCommand(): void;
}

/**
 * Report an unknown command the way commander does when a program has no root action.
 *
 * Issue #1195: adding a root action stops commander from reaching unknownCommand() on its own,
 * so it is invoked explicitly to keep the message, exit code and "(Did you mean ...?)"
 * suggestion identical to the previous behaviour.
 *
 * @param program - The program that parsed the operand
 * @param command - The unrecognised command name
 */
function reportUnknownCommand(program: Command, command: string): void {
  const reporter = program as unknown as Partial<UnknownCommandReporter>;

  if (typeof reporter.unknownCommand === 'function') {
    reporter.unknownCommand();
    return;
  }

  // Fallback if commander ever drops the private method: same message, minus the suggestion
  program.error(`error: unknown command '${command}'`, {
    code: 'commander.unknownCommand',
    exitCode: 1,
  });
}

/**
 * Build the CommandMate CLI program.
 *
 * Constructing the program must stay free of side effects (no argv parsing, no process.exit)
 * so it can be exercised in tests; src/cli/index.ts owns the parse() call.
 *
 * @returns A fully configured commander program
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('commandmate')
    .description('Git worktree management with Claude CLI and tmux sessions')
    // Issue #1462: parse root options only before the command name, then hand the
    // rest to the matched subcommand. Without this, commander's default lets the
    // root's `--version` flag (from .version() below) swallow a subcommand's
    // `--version <v>` in space form (`skill install X --version 0.1.0`), printing
    // the CLI version and exiting 0 — a silent no-op. Positional parsing leaves
    // options after the command name for the subcommand that owns them.
    .enablePositionalOptions()
    .version(pkg.version)
    // Issue #1195: commander drops its implicit `help [command]` as soon as a root action
    // exists, so it is re-enabled explicitly to keep `commandmate help <cmd>` working
    .helpCommand(true)
    // Issue #1195: pinned because the root arguments below would otherwise repeat '[command]'
    .usage('[options] [command]')
    // Issue #1195: operands are captured so an unknown command is still reported as one; without
    // them commander answers "too many arguments" as soon as a root action exists. Descriptions
    // are omitted on purpose - any description would add an "Arguments:" section to --help.
    .argument('[command]')
    .argument('[args...]')
    .option('--no-open', 'Do not open the browser automatically')
    .action((command: string | undefined, _args: string[], options: { open: boolean }) => {
      if (command !== undefined) {
        reportUnknownCommand(program, command);
        return undefined;
      }

      // Raised from this program instance (not a fresh one) so exitOverride/configureOutput
      // callers observe it, keeping the pre-quickstart behaviour: help on stderr, exit 1.
      if (!isInteractive()) {
        program.help({ error: true });
      }

      return quickstartCommand({ open: options.open });
    });

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
  // Issue #331: Add --auth, --auth-expire, --https, --cert, --key, --allow-http flags
  program
    .command('start')
    .description('Start the CommandMate server')
    .option('--dev', 'Start in development mode')
    .option('--daemon', 'Run in background')
    .option('-p, --port <number>', 'Override port number', parseInt)
    .option('-i, --issue <number>', 'Start server for specific issue worktree', parseInt)
    .option('--auto-port', 'Automatically allocate port for worktree server')
    .option('--auth', 'Enable token authentication')
    .option('--auth-expire <duration>', 'Token expiration (e.g., 24h, 7d, 90m)')
    .option('--https', 'Enable HTTPS')
    .option('--cert <path>', 'Path to TLS certificate file')
    .option('--key <path>', 'Path to TLS private key file')
    .option('--allow-http', 'Suppress HTTPS warning when using --auth without certificates')
    .option('--allowed-ips <cidrs>', 'Allowed IP addresses/CIDR ranges (comma-separated)')
    .option('--trust-proxy', 'Trust X-Forwarded-For header from reverse proxy')
    .action(async (options) => {
      await startCommand({
        dev: options.dev,
        daemon: options.daemon,
        port: options.port,
        issue: options.issue,
        autoPort: options.autoPort,
        auth: options.auth,
        authExpire: options.authExpire,
        https: options.https,
        cert: options.cert,
        key: options.key,
        allowHttp: options.allowHttp,
        allowedIps: options.allowedIps,
        trustProxy: options.trustProxy,
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

  // Update command
  // Issue #1194: bundle stop -> npm install -g commandmate@latest -> start
  program
    .command('update')
    .description('Update CommandMate to the latest version')
    .option('--check', 'Only check for updates (no install, stop or restart)')
    .option('-y, --yes', 'Skip the confirmation prompt (required for non-interactive use)')
    // Issue #1395: hidden — the GUI update route uses this to relaunch an
    // npx-launched server from a fresh npx cache. Hidden so the user-facing
    // `commandmate update` under npx stays a no-op (§6). Fixed argv, no request
    // input reaches it (§5).
    .addOption(
      new Option('--relaunch-npx', 'Internal: relaunch an npx server from a fresh cache').hideHelp()
    )
    .action(async (options) => {
      await updateCommand({
        check: options.check,
        yes: options.yes,
        relaunchNpx: options.relaunchNpx,
      });
    });

  // Issue #264: issue/docs commands (addCommand pattern for subcommand support)
  program.addCommand(createIssueCommand());
  program.addCommand(createDocsCommand());

  // Issue #518: Agent orchestration commands [DR1-08] [IA3-07]
  // These commands enable CLI-based agent control for worktree operations.
  program.addCommand(createLsCommand());
  program.addCommand(createSendCommand());
  program.addCommand(createWaitCommand());
  program.addCommand(createRespondCommand());
  program.addCommand(createCaptureCommand());
  program.addCommand(createAutoYesCommand());

  // Issue #636: Report command
  program.addCommand(createReportCommand());

  // Issue #1000: Agent-instance roster management
  program.addCommand(createInstancesCommand());

  // Issue #1237: Skill management (catalog / plan / install / uninstall / status)
  program.addCommand(createSkillCommand());

  // Issue #264: AI Tool Integration help section
  program.addHelpText('after', `
AI Tool Integration:
  Use with Claude Code or Codex to manage issues:
    commandmate issue create --bug --title "Title" --body "Description"
    commandmate issue create --question --title "How to..." --body "Details"
    commandmate docs --section quick-start
`);

  return program;
}
