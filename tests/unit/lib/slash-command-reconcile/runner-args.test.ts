/**
 * `--opencode-port` and the rest of the runner's command line (Issue #2036)
 *
 * The defect this covers was not a wrong value, it was an unreachable one:
 * `RunReconcileOptions.opencode` and `FetchOpencodeOptions` both existed, and
 * `grep -rn 'opencode:' scripts src` on develop f5903168 found no caller that
 * ever built one. Every run therefore took `options.opencode ?? false` and
 * printed `opencode provider skipped: no loopback port given`.
 *
 * So the assertions here are about *reachability*: that a typed port becomes an
 * option object, that the option object reaches the provider's fetch, and that
 * the absent flag still produces the exact skip the weekly catalog-drift
 * workflow has always seen.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  OPENCODE_PORT_FLAG,
  RUNNER_USAGE,
  RUNNER_USAGE_EXIT_CODE,
  RunnerArgsError,
  opencodeOptionFromArgs,
  parseOpencodePort,
  parseRunnerArgs,
} from '@/lib/slash-command-reconcile/runner-args';
import { runReconcile } from '@/lib/slash-command-reconcile';
import { opencodeCommandUrl } from '@/lib/slash-command-reconcile/providers/opencode';
import type { SlashCommandsCatalog } from '@/lib/slash-command-reconcile/types';

describe('parseRunnerArgs — the flags that existed before Issue #2036', () => {
  it('defaults to check mode with every provider enabled', () => {
    expect(parseRunnerArgs([])).toEqual({
      write: false,
      json: false,
      help: false,
      skipClaude: false,
      skipCodex: false,
      skipAntigravity: false,
      unknownArgs: [],
    });
  });

  it('still reads --write / --check / --json / --codex-ref / the skips', () => {
    const args = parseRunnerArgs([
      '--write',
      '--json',
      '--codex-ref',
      'rust-v0.149.0',
      '--skip-claude',
      '--skip-codex',
      '--skip-antigravity',
    ]);
    expect(args.write).toBe(true);
    expect(args.json).toBe(true);
    expect(args.codexRef).toBe('rust-v0.149.0');
    expect(args.skipClaude).toBe(true);
    expect(args.skipCodex).toBe(true);
    expect(args.skipAntigravity).toBe(true);
  });

  it('lets a later --check turn an earlier --write back off', () => {
    expect(parseRunnerArgs(['--write', '--check']).write).toBe(false);
  });

  it('collects unknown arguments instead of printing or throwing', () => {
    // Pure on purpose: the runner owns every byte that reaches stderr, and the
    // wording ("Ignoring unknown argument: …") is unchanged from before #2036.
    const args = parseRunnerArgs(['--nope', 'stray']);
    expect(args.unknownArgs).toEqual(['--nope', 'stray']);
  });
});

describe('parseRunnerArgs — --help (Issue #2036)', () => {
  it('is set by --help and by -h', () => {
    expect(parseRunnerArgs(['--help']).help).toBe(true);
    expect(parseRunnerArgs(['-h']).help).toBe(true);
    expect(parseRunnerArgs([]).help).toBe(false);
  });

  it('documents the opencode port flag', () => {
    // The acceptance criterion is discoverability: an option nobody can find is
    // the state this Issue found `RunReconcileOptions.opencode` in.
    expect(RUNNER_USAGE).toContain(OPENCODE_PORT_FLAG);
    expect(RUNNER_USAGE).toContain('127.0.0.1');
    expect(RUNNER_USAGE).toContain('1-65535');
  });

  it('documents every flag the parser accepts', () => {
    for (const flag of [
      '--check',
      '--write',
      '--json',
      '--codex-ref',
      OPENCODE_PORT_FLAG,
      '--skip-claude',
      '--skip-codex',
      '--skip-antigravity',
      '--help',
    ]) {
      expect(RUNNER_USAGE, flag).toContain(flag);
    }
  });
});

describe('parseOpencodePort (Issue #2036)', () => {
  it('accepts the ends of the range and a plausible loopback port', () => {
    expect(parseOpencodePort('1')).toBe(1);
    expect(parseOpencodePort('4096')).toBe(4096);
    expect(parseOpencodePort('65535')).toBe(65535);
  });

  it('rejects everything Number() would have accepted and a port is not', () => {
    // Each of these is finite under Number(): ' 80 ' -> 80, '8e3' -> 8000,
    // '0x50' -> 80, '' -> 0. A bare Number() cast would have run a pass against
    // a port the operator never typed.
    for (const bad of ['', ' 80 ', '8e3', '0x50', '80.0', '+80', '-1', '0', '65536', 'banana']) {
      expect(() => parseOpencodePort(bad), JSON.stringify(bad)).toThrow(RunnerArgsError);
    }
  });

  it('names the flag and echoes what it was given', () => {
    expect(() => parseOpencodePort('banana')).toThrow(/--opencode-port.*1-65535.*"banana"/);
  });

  it('rejects a flag typed with no value at all', () => {
    expect(() => parseOpencodePort(undefined)).toThrow(/requires a port number/);
    expect(() => parseRunnerArgs([OPENCODE_PORT_FLAG])).toThrow(RunnerArgsError);
  });

  it('throws RunnerArgsError, which the runner answers with a usage exit', () => {
    // Distinct from a plain Error so the runner can tell "you asked the wrong
    // question" (exit 2) from "something unexpected broke" (exit 1).
    expect(RUNNER_USAGE_EXIT_CODE).toBe(2);
    const thrown = (() => {
      try {
        parseRunnerArgs([OPENCODE_PORT_FLAG, 'banana']);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(RunnerArgsError);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('RunnerArgsError');
  });
});

describe('opencodeOptionFromArgs (Issue #2036)', () => {
  it('builds { port } from --opencode-port 4096', () => {
    const args = parseRunnerArgs([OPENCODE_PORT_FLAG, '4096']);
    expect(args.opencodePort).toBe(4096);
    expect(opencodeOptionFromArgs(args)).toEqual({ port: 4096 });
  });

  it('is false without the flag, so the weekly workflow keeps its skip', () => {
    const args = parseRunnerArgs(['--check']);
    expect(args.opencodePort).toBeUndefined();
    expect(opencodeOptionFromArgs(args)).toBe(false);
  });
});

/** A catalog with nothing in it: this suite is about the plumbing, not the diff. */
const EMPTY_CATALOG: SlashCommandsCatalog = { frequentlyUsed: {}, commands: [] };

/** What a live 1.18.22 server answers, cut to what the reconcile reads. */
const LIVE_BODY = [
  { name: 'init', description: 'guided AGENTS.md setup', source: 'command', hints: [] },
  { name: 'review', description: 'review the current changes', source: 'command', hints: [] },
  { name: 'probe-skill', description: 'a per-project Skill', source: 'skill', hints: [] },
];

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

describe('runReconcile carries the opencode option to the provider (Issue #2036)', () => {
  it('fetches http://127.0.0.1:<port>/command when the option is built', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return jsonResponse(LIVE_BODY);
    }) as unknown as typeof fetch;

    const args = parseRunnerArgs([OPENCODE_PORT_FLAG, '4096']);
    const result = await runReconcile(EMPTY_CATALOG, {
      claude: false,
      codex: false,
      antigravity: false,
      // Exactly what scripts/refresh-slash-command-catalog.ts now passes.
      opencode: { ...opencodeOptionFromArgs(args), fetchImpl } as {
        port: number;
        fetchImpl: typeof fetch;
      },
    });

    expect(seen).toEqual([opencodeCommandUrl(4096)]);
    expect(seen[0]).toBe('http://127.0.0.1:4096/command');
    // The skip warning the Issue quoted is gone, and the rows arrived.
    expect(result.warnings.join(' ')).not.toContain('no loopback port given');
    expect(result.diff.added.map((added) => `${added.tool}:${added.name}`)).toEqual([
      'opencode:init',
      'opencode:review',
    ]);
  });

  it('reproduces the exact skip warning when no port is given', async () => {
    const args = parseRunnerArgs([]);
    const result = await runReconcile(EMPTY_CATALOG, {
      claude: false,
      codex: false,
      antigravity: false,
      opencode: opencodeOptionFromArgs(args),
    });

    // Verbatim from the Issue's `source-warning:` line, so a change to the
    // wording has to be a decision rather than an accident: check-report.ts
    // matches warnings by prefix and .github/workflows/catalog-drift.yml acts
    // on the verdict that produces.
    expect(result.warnings).toContain(
      'opencode provider skipped: no loopback port given ' +
        '(pass { port } — the TUI built-ins are not in GET /command, see the module docblock)'
    );
    expect(result.diff.added).toEqual([]);
  });
});
