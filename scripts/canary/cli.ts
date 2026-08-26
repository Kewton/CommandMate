/**
 * Argument parsing and help text for `npm run canary` (Issue #1727).
 *
 * Kept pure and separate from the runner so the flag semantics — especially
 * `--mutate`, the harness's own non-vacuity self-test — are unit-testable
 * without tmux or a Claude session.
 */

import { CANARY_TOOL_IDS, DEFAULT_CANARY_TOOL } from './tool-profiles';
import type { CanaryToolId } from './types';

export interface CanaryOptions {
  /**
   * Which CLI to drive (Issue #2050).
   *
   * A run drives exactly one tool: the throwaway HOME, the pane geometry, the
   * readiness row and the launch flags all differ per tool, so mixing them in
   * one run would mean tearing the harness down and rebuilding it mid-flight.
   */
  tool: CanaryToolId;
  /** Run only these scenario ids. */
  only: string[];
  /** Skip these scenario ids. */
  skip: string[];
  /** Emit a machine-readable summary instead of the human table. */
  json: boolean;
  /** Keep the throwaway HOME and tmux sessions for inspection. */
  keep: boolean;
  /**
   * Replace every expectation with a plausible-but-wrong one. A healthy harness
   * must then report EVERY scenario as failed — that is the proof the assertions
   * are actually evaluated and not vacuously satisfied.
   */
  mutate: boolean;
  /**
   * Mutate the RECEIVER instead of the expectation, for the Auto-Yes v2
   * scenarios (Issue #1847): answer `{}` where the adjudicator said `allow`, and
   * `allow` where it declined to decide. Every selected hook scenario must then
   * go red; scenarios with no receiver are skipped.
   *
   * A separate flag from `--mutate` because it mutates a different thing. Those
   * two scenarios both expect the screen a session with NO verdict shows, so a
   * wrong predicate does not test what they are for — a wrong reply does.
   */
  mutateVerdict: boolean;
  /**
   * Turn a version drift into a non-zero exit (Issue #2050).
   *
   * The canary always REPORTS whether the tool's `verifiedAgainst` stamp still
   * names the installed build; this makes that report fail the run. Off by
   * default because a drift is not by itself a detection regression — the day
   * opencode ships 1.18.23 every scenario may still be green, and a canary that
   * goes red for a version bump alone teaches its operator to ignore it.
   */
  strictVersion: boolean;
  /** Print the scenario table and exit. */
  list: boolean;
  /** Print help and exit. */
  help: boolean;
}

export const DEFAULT_OPTIONS: CanaryOptions = {
  tool: DEFAULT_CANARY_TOOL,
  only: [],
  skip: [],
  json: false,
  keep: false,
  mutate: false,
  mutateVerdict: false,
  strictVersion: false,
  list: false,
  help: false,
};

function parseIdList(value: string | undefined, flag: string): string[] {
  if (!value) throw new Error(`canary: ${flag} needs a comma-separated scenario list`);
  return value
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
}

/** Parse argv (already sliced past `node script`). Throws on unknown flags. */
export function parseArgs(argv: readonly string[]): CanaryOptions {
  const options: CanaryOptions = { ...DEFAULT_OPTIONS, only: [], skip: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inlineValue] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    const takeValue = (): string | undefined => (inlineValue !== undefined ? inlineValue : argv[++i]);

    switch (flag) {
      case '--tool': {
        const value = takeValue();
        if (!value) throw new Error('canary: --tool needs a tool id');
        if (!(CANARY_TOOL_IDS as readonly string[]).includes(value)) {
          throw new Error(
            `canary: unknown tool "${value}" (known: ${CANARY_TOOL_IDS.join(', ')})`
          );
        }
        options.tool = value as CanaryToolId;
        break;
      }
      case '--only':
        options.only.push(...parseIdList(takeValue(), '--only'));
        break;
      case '--skip':
        options.skip.push(...parseIdList(takeValue(), '--skip'));
        break;
      case '--json':
        options.json = true;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--mutate':
        options.mutate = true;
        break;
      case '--mutate-verdict':
        options.mutateVerdict = true;
        break;
      case '--strict-version':
        options.strictVersion = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`canary: unknown argument "${arg}" (try --help)`);
    }
  }

  const overlap = options.only.filter(id => options.skip.includes(id));
  if (overlap.length > 0) {
    throw new Error(`canary: ${overlap.join(', ')} passed to both --only and --skip`);
  }
  // Both mutate the run in a different place; combining them would leave a red
  // scenario unattributable to either.
  if (options.mutate && options.mutateVerdict) {
    throw new Error('canary: --mutate and --mutate-verdict are mutually exclusive');
  }
  return options;
}

export function formatHelp(scenarioIds: readonly string[]): string {
  return `Detection canary — drives a real agent CLI and asserts what the
detection layer concludes about each frame (Issue #1727, opencode in #2050).

Usage:
  npm run canary [-- <options>]

Options:
  --tool <id>    CLI to drive: ${CANARY_TOOL_IDS.join(' | ')} (default ${DEFAULT_CANARY_TOOL}).
                 A run drives one tool; the scenario list is filtered to it.
  --only <ids>   Run only these scenarios (comma-separated)
  --skip <ids>   Skip these scenarios (comma-separated)
  --list         Print the scenario table and exit
  --json         Print a machine-readable summary
  --keep         Keep the throwaway HOME and tmux sessions for inspection
  --mutate       Self-test: run every scenario against a plausible-but-WRONG
                 expectation. A healthy harness fails all of them.
  --mutate-verdict
                 Self-test for the Auto-Yes v2 scenarios: the hook receiver
                 answers the OPPOSITE verdict (allow becomes {} and back), with
                 the real expectations left in place. A healthy harness fails
                 every hook scenario; the others are skipped.
  --strict-version
                 Exit non-zero when the installed CLI is newer than the build
                 the detector rules were read off (tools/verified-against.ts).
                 The drift is reported either way.
  -h, --help     Show this help

Scenarios: ${scenarioIds.join(', ')}

Requires: tmux >= 3.2 and the tool on PATH.
  claude   — auth via CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY, or the macOS keychain
  opencode — auth via ~/.local/share/opencode/auth.json (\`opencode auth login\`);
             CM_CANARY_OPENCODE_MODEL overrides the pinned model
See docs/qa/detection-canary.md.`;
}
