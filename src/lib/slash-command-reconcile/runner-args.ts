/**
 * Slash Command Catalog reconcile — runner argument parsing (Issue #2036)
 *
 * Extracted from `scripts/refresh-slash-command-catalog.ts` for the same reason
 * `locale.ts` was: the script ends in a top-level `main()`, so nothing inside it
 * can be imported by a test without also running a reconcile pass. Parsing lives
 * here instead, pure and total, and the script keeps only the I/O.
 *
 * ## Why this module exists at all (the #2036 defect)
 *
 * `RunReconcileOptions.opencode` and `FetchOpencodeOptions` have existed since
 * the opencode provider landed, and **no caller ever built one**: `index.ts` read
 * `options.opencode ?? false` and every call site left it unset, so every run —
 * including the weekly `catalog-drift` workflow — took the `false` branch and
 * printed `opencode provider skipped: no loopback port given`. The types were a
 * socket with nothing plugged into it. `--opencode-port` is the plug.
 *
 * ## Why the port is an argument and not a discovery
 *
 * It belongs to a process CommandMate did not start, and #1758 §5.9.2 measured
 * that opencode does not write it anywhere on disk that a later process can read
 * back. So there is nothing to guess and nothing to probe; the operator who
 * started the server is the only party that knows the number. Absent the flag the
 * provider stays skipped, which is what keeps the weekly workflow — which has no
 * opencode server and passes no flag — behaving exactly as it did before.
 *
 * Nothing here is reachable from the app runtime; see the directory docblock in
 * `index.ts`.
 */

import { isUsableOpencodePort, type FetchOpencodeOptions } from './providers/opencode';

/**
 * A malformed command line, as opposed to a source being down.
 *
 * Distinct from a plain `Error` so the runner can answer it with a usage
 * message and exit 2 instead of the `refresh-slash-command-catalog failed:`
 * stack that an unexpected fault deserves. A reconcile is fail-soft about
 * *sources*; it is not fail-soft about being asked the wrong question.
 */
export class RunnerArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerArgsError';
  }
}

/** Exit code for a malformed command line (usage error, not a run failure). */
export const RUNNER_USAGE_EXIT_CODE = 2;

/** Long flag that supplies the loopback port of a running opencode server. */
export const OPENCODE_PORT_FLAG = '--opencode-port';

/** Everything the runner can be told to do, after validation. */
export interface RunnerArgs {
  /** `--write`: apply changes. `--check` (default) leaves it false. */
  write: boolean;
  /** `--json`: print the machine-readable result instead of the report. */
  json: boolean;
  /** `--help` / `-h`: print usage and do nothing else. */
  help: boolean;
  /** `--codex-ref <tag>`: pin the codex enum to a tag instead of @latest. */
  codexRef?: string;
  skipClaude: boolean;
  skipCodex: boolean;
  skipAntigravity: boolean;
  /**
   * `--opencode-port <port>`: loopback port of a running opencode server.
   *
   * `undefined` — not the sentinel `0` — when the flag is absent, because 0 is a
   * port number a caller could type and it must be rejected as invalid rather
   * than read as "skip".
   */
  opencodePort?: number;
  /** Arguments the runner did not recognise, in the order they were given. */
  unknownArgs: string[];
}

/**
 * `--help` text.
 *
 * Kept as data rather than a pile of `console.log` calls so a test can assert a
 * flag is documented without starting a subprocess — a flag that works and is
 * undiscoverable is the state #2036 found the opencode option in.
 */
export const RUNNER_USAGE = `Usage: tsx scripts/refresh-slash-command-catalog.ts [options]

Reconciles src/config/slash-commands-catalog.json against each CLI's
authoritative source.

Options:
  --check                 (default) report the diff; write nothing.
  --write                 apply changes to the catalog + en/ja locale dictionaries.
  --json                  print the machine-readable result instead of the report.
  --codex-ref <tag>       pin the codex enum to this git tag instead of @latest.
  ${OPENCODE_PORT_FLAG} <port>  reconcile opencode against GET /command on
                          http://127.0.0.1:<port> (integer, 1-65535).
                          The port belongs to an opencode server the operator
                          already started and cannot be read back off disk
                          (#1758 §5.9.2), so WITHOUT this flag the opencode
                          provider is skipped — which is what the weekly
                          catalog-drift workflow does. GET /command carries
                          markdown commands and Skills only; the 16 TUI
                          built-ins (/agents … /variants) are client-side and
                          stay on their palette attestation (measured on
                          opencode 1.18.22, Issue #2036).
  --skip-claude           skip the claude provider.
  --skip-codex            skip the codex provider.
  --skip-antigravity      skip the antigravity provider.
  -h, --help              print this help and exit.

Fail-soft: a source that is unreachable or has changed shape is skipped with a
warning. A malformed command line is not fail-soft and exits ${RUNNER_USAGE_EXIT_CODE}.`;

/** Decimal integer with no sign, no exponent, no padding — at most 5 digits. */
const PORT_LITERAL = /^[0-9]{1,5}$/;

/**
 * Validate the value given to `--opencode-port`.
 *
 * The literal is matched before `Number()` sees it, because `Number` is far more
 * permissive than a port ever is: `' 80 '`, `'8e3'`, `'0x50'` and `''` all parse
 * to a finite number, and `''` in particular parses to `0`, which would turn a
 * flag typed with a missing value into a silently different run.
 */
export function parseOpencodePort(raw: string | undefined): number {
  if (raw === undefined) {
    throw new RunnerArgsError(`${OPENCODE_PORT_FLAG} requires a port number (1-65535)`);
  }
  if (!PORT_LITERAL.test(raw) || !isUsableOpencodePort(Number(raw))) {
    throw new RunnerArgsError(
      `${OPENCODE_PORT_FLAG} expects an integer TCP port in 1-65535, got ${JSON.stringify(raw)}`
    );
  }
  return Number(raw);
}

/**
 * Parse the runner's argv tail (i.e. `process.argv.slice(2)`).
 *
 * Pure: unknown arguments are collected rather than warned about, so the caller
 * owns every byte that reaches stdout/stderr. Throws `RunnerArgsError` — and only
 * that — on a malformed command line.
 */
export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  const args: RunnerArgs = {
    write: false,
    json: false,
    help: false,
    skipClaude: false,
    skipCodex: false,
    skipAntigravity: false,
    unknownArgs: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--write':
        args.write = true;
        break;
      case '--check':
        args.write = false;
        break;
      case '--json':
        args.json = true;
        break;
      case '--codex-ref':
        args.codexRef = argv[++i];
        break;
      case OPENCODE_PORT_FLAG:
        args.opencodePort = parseOpencodePort(argv[++i]);
        break;
      case '--skip-claude':
        args.skipClaude = true;
        break;
      case '--skip-codex':
        args.skipCodex = true;
        break;
      case '--skip-antigravity':
        args.skipAntigravity = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        args.unknownArgs.push(arg);
    }
  }

  return args;
}

/**
 * The `opencode` field of `RunReconcileOptions` these arguments ask for.
 *
 * `false` without the flag: the provider stays skipped and the run keeps the
 * warning it has always printed, so a caller that passes nothing — the weekly
 * workflow — cannot tell this Issue landed.
 */
export function opencodeOptionFromArgs(args: RunnerArgs): FetchOpencodeOptions | false {
  return args.opencodePort === undefined ? false : { port: args.opencodePort };
}
