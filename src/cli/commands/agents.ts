/**
 * `agents` Command — read the installed agent CLI versions, and update one
 * (Issue #2069).
 *
 *   commandmate agents versions [--json]
 *   commandmate agents update <tool> [--yes] [--json] [--check]
 *
 * ## Why the update runs here rather than through the server
 *
 * The whole point of this Issue is that the updater must not run inside an
 * agent's tmux pane: codex's own "Update now" terminates codex and does not
 * restart it, leaving the pane at a bare shell (#2070). A CLI process is
 * already the "somewhere else" that requirement asks for, so this command runs
 * `lib/updates/agent-updater` directly — no server, no port, and it works on a
 * machine where CommandMate is not running at all. The GUI's button reaches the
 * same two functions through `POST /api/agents/update`.
 *
 * ## Imports are relative on purpose
 *
 * `tsconfig.cli.json` resets `"paths"` to `{}`, so a single `@/...` anywhere in
 * this file's transitive closure breaks `npm run build:cli` (the #1933 defect
 * PR #1991 fixed). `lib/updates/*` is written to that constraint — see the note
 * in `codex-version.ts` about not importing `getCodexHome`.
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import { CLILogger } from '../utils/logger';
import { handleCommandError } from '../utils/command-helpers';
import { confirm, isInteractive, closeReadline } from '../utils/prompt';
import {
  resolveAgentUpdatePlan,
  runAgentUpdate,
  UPDATABLE_AGENT_TOOLS,
} from '../../lib/updates/agent-updater';
import { getAgentVersions } from '../../lib/updates/agent-versions';

const logger = new CLILogger();

/** Options accepted by `agents versions` / `agents update`. */
export interface AgentsCommandOptions {
  json?: boolean;
  yes?: boolean;
  /** Report the plan and stop, changing nothing. */
  check?: boolean;
}

/** Render the version rows as a fixed-width table, mirroring `ls` / `instances`. */
function formatVersionsTable(
  rows: Array<{ tool: string; installed: string | null; latestVersion: string | null; updateAvailable: boolean }>
): string {
  if (rows.length === 0) return 'No agent CLIs found.';

  const headers = ['TOOL', 'INSTALLED', 'LATEST', 'UPDATE'];
  const dataRows = rows.map((row) => [
    row.tool,
    // Blank rather than a placeholder, exactly as `instances` prints an unknown
    // model: "not installed" is the ordinary state for most of this table.
    row.installed ?? '',
    row.latestVersion ?? '',
    row.updateAvailable ? 'available' : '',
  ]);

  const widths = headers.map((header, i) =>
    Math.max(header.length, ...dataRows.map((row) => row[i].length))
  );
  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');

  return [
    line(headers),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...dataRows.map(line),
  ].join('\n');
}

/** `commandmate agents versions` — print what is installed. */
async function showVersions(options: AgentsCommandOptions): Promise<void> {
  const rows = await getAgentVersions({ force: true });

  if (options.json) {
    console.log(JSON.stringify({ tools: rows, updatable: [...UPDATABLE_AGENT_TOOLS] }, null, 2));
    return;
  }

  console.log(formatVersionsTable(rows));

  const stale = rows.filter((row) => row.updateAvailable);
  if (stale.length > 0) {
    console.log('');
    for (const row of stale) {
      console.log(
        `Update available for ${row.tool}: ${row.installed ?? 'unknown'} -> ${row.latestVersion ?? 'unknown'}` +
          (row.dismissedInCodex ? ' (dismissed inside codex)' : '')
      );
    }
    console.log(`Run "commandmate agents update ${stale[0].tool}" to install it.`);
  }
}

/**
 * `commandmate agents update <tool>` — run the tool's own updater here.
 *
 * Exit codes follow `commandmate update`: 2 when the request cannot be honoured
 * (unknown tool, nothing to run it with, non-interactive without `--yes`), and
 * 5 when the updater itself failed.
 */
async function updateAgent(tool: string, options: AgentsCommandOptions): Promise<void> {
  const planned = await resolveAgentUpdatePlan(tool);
  if (!planned.ok) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, code: planned.code, error: planned.message }, null, 2));
    } else {
      logger.error(planned.message);
    }
    process.exit(ExitCode.CONFIG_ERROR);
    return;
  }

  const plan = planned.plan;

  if (options.check) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            tool: plan.tool,
            strategy: plan.strategy,
            command: plan.display,
            installed: plan.installed,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Installed: ${plan.installed ?? 'not installed'}`);
      console.log(`Would run: ${plan.display}`);
    }
    return;
  }

  if (!options.yes) {
    if (!isInteractive()) {
      logger.error('Non-interactive環境では --yes が必要です');
      logger.info(`Run "commandmate agents update ${plan.tool} --yes" to update without a prompt.`);
      process.exit(ExitCode.CONFIG_ERROR);
      return;
    }
    const proceed = await confirm(`Run "${plan.display}" now?`, { default: true });
    closeReadline();
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }
  }

  if (!options.json) {
    console.log(`Running: ${plan.display}`);
    console.log('');
  }

  // Streamed straight through: an install is exactly the case where the user
  // wants to watch npm talk rather than stare at a spinner.
  const captured: string[] = [];
  const result = await runAgentUpdate(plan, {
    onChunk: (chunk) => {
      if (options.json) {
        captured.push(chunk.text);
        return;
      }
      if (chunk.stream === 'stderr') process.stderr.write(chunk.text);
      else process.stdout.write(chunk.text);
    },
  });

  // Re-probed rather than assumed: "the updater exited 0" and "the binary on
  // PATH changed" are different claims, and this Issue's acceptance criterion
  // is the second one.
  const after = (await getAgentVersions({ force: true })).find((row) => row.tool === plan.tool);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: result.ok,
          tool: plan.tool,
          strategy: plan.strategy,
          command: plan.display,
          previousVersion: plan.installed,
          installed: after?.installed ?? null,
          exitCode: result.exitCode,
          output: captured.join(''),
          ...(result.error ? { error: result.error } : {}),
        },
        null,
        2
      )
    );
  } else {
    console.log('');
    if (result.ok) {
      logger.success(
        `${plan.tool}: ${plan.installed ?? 'unknown'} -> ${after?.installed ?? 'unknown'}`
      );
      logger.info('Running sessions keep the old binary until they are restarted.');
    } else {
      logger.error(result.error ?? `Update exited with status ${String(result.exitCode)}`);
    }
  }

  if (!result.ok) {
    process.exit(ExitCode.UPDATE_FAILED);
  }
}

/** Build the `agents` command tree. */
export function createAgentsCommand(): Command {
  const cmd = new Command('agents');
  cmd
    .description('Inspect and update the agent CLIs CommandMate drives')
    .argument('[action]', 'versions (default) or update')
    .argument('[tool]', `Tool to update (${UPDATABLE_AGENT_TOOLS.join(', ')})`)
    .option('--json', 'JSON output')
    .option('--yes', 'Skip the confirmation prompt (required in non-interactive shells)')
    .option('--check', 'Report what would run, and change nothing')
    .action(async (action: string | undefined, tool: string | undefined, options: AgentsCommandOptions) => {
      try {
        switch (action ?? 'versions') {
          case 'versions':
            await showVersions(options);
            break;

          case 'update': {
            if (!tool) {
              console.error(
                `Error: update requires a <tool> argument. Valid tools: ${UPDATABLE_AGENT_TOOLS.join(', ')}.`
              );
              process.exit(ExitCode.CONFIG_ERROR);
            }
            await updateAgent(tool, options);
            break;
          }

          default:
            console.error(`Error: unknown action '${action}'. Valid actions: versions, update.`);
            process.exit(ExitCode.CONFIG_ERROR);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
