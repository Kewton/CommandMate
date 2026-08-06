/**
 * Argument parsing and help text for `npm run canary` (Issue #1727).
 *
 * Kept pure and separate from the runner so the flag semantics — especially
 * `--mutate`, the harness's own non-vacuity self-test — are unit-testable
 * without tmux or a Claude session.
 */

export interface CanaryOptions {
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
  /** Print the scenario table and exit. */
  list: boolean;
  /** Print help and exit. */
  help: boolean;
}

export const DEFAULT_OPTIONS: CanaryOptions = {
  only: [],
  skip: [],
  json: false,
  keep: false,
  mutate: false,
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
  return options;
}

export function formatHelp(scenarioIds: readonly string[]): string {
  return `Detection canary — drives a real Claude Code TUI and asserts what the
detection layer concludes about each frame (Issue #1727).

Usage:
  npm run canary [-- <options>]

Options:
  --only <ids>   Run only these scenarios (comma-separated)
  --skip <ids>   Skip these scenarios (comma-separated)
  --list         Print the scenario table and exit
  --json         Print a machine-readable summary
  --keep         Keep the throwaway HOME and tmux sessions for inspection
  --mutate       Self-test: run every scenario against a plausible-but-WRONG
                 expectation. A healthy harness fails all of them.
  -h, --help     Show this help

Scenarios: ${scenarioIds.join(', ')}

Requires: tmux >= 3.2, a working \`claude\` on PATH, and Claude auth
(CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY, or the macOS keychain).
See docs/qa/detection-canary.md.`;
}
