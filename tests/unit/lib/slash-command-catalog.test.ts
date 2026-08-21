/**
 * Tests for slash-command-catalog module (Issue #1476)
 *
 * Covers user extension loading/validation, the standard-layer composition
 * (bundled < user-catalog, standard < worktree), and CLI staleness detection.
 *
 * @vitest-environment node
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mocks (must be declared before importing the module under test) --------

let mockConfigDir = '';

vi.mock('@/cli/utils/install-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/cli/utils/install-context')>();
  return { ...actual, getConfigDir: () => mockConfigDir };
});

// Deterministic execFile: resolve a version string per command, or an error.
// Issue #1913: every call is also recorded, so the probe guards can assert what
// was executed, with which arguments and in which environment.
type ExecTable = Record<string, { stdout?: string; error?: boolean }>;
let execTable: ExecTable = {};

interface ExecCall {
  command: string;
  args: string[];
  opts: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv };
}
let execCalls: ExecCall[] = [];

vi.mock('child_process', () => ({
  execFile: (
    command: string,
    args: string[],
    opts: ExecCall['opts'],
    cb: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    execCalls.push({ command, args, opts });
    const entry = execTable[command];
    if (!entry || entry.error) {
      cb(new Error('ENOENT'), '', '');
      return;
    }
    cb(null, entry.stdout ?? '', '');
  },
}));

import {
  loadUserCatalogCommands,
  composeStandardLayer,
  getCatalogStaleness,
  parseCliVersion,
  compareCliVersions,
  clearCatalogCache,
} from '@/lib/slash-command-catalog';
import { SENSITIVE_ENV_KEYS } from '@/lib/security/env-sanitizer';
import { getStandardCommandGroups } from '@/lib/standard-commands';
import { mergeCommandGroups } from '@/lib/command-merger';
import type { SlashCommand, SlashCommandGroup } from '@/types/slash-commands';
import { removeTempDir } from '@tests/helpers/temp-dir';

// --- Helpers ----------------------------------------------------------------

let tmpRoot: string;

function catalogDir(): string {
  return path.join(tmpRoot, 'slash-commands');
}

function writeCatalogFile(name: string, contents: string): void {
  fs.mkdirSync(catalogDir(), { recursive: true });
  fs.writeFileSync(path.join(catalogDir(), name), contents, 'utf8');
}

function flatten(groups: SlashCommandGroup[]): SlashCommand[] {
  return groups.flatMap((g) => g.commands);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-usercatalog-'));
  mockConfigDir = tmpRoot;
  execTable = {};
  execCalls = [];
  clearCatalogCache();
});

afterEach(() => {
  clearCatalogCache();
  removeTempDir(tmpRoot);
});

// --- User extension loading -------------------------------------------------

describe('loadUserCatalogCommands', () => {
  it('returns [] when the extension directory does not exist (bundled-only)', () => {
    expect(loadUserCatalogCommands()).toEqual([]);
  });

  it('loads valid user entries with source=user-catalog and literal description', () => {
    writeCatalogFile(
      'extra.json',
      JSON.stringify({
        commands: [
          { name: 'loop', description: 'Run on a recurring interval', category: 'standard-util', cliTools: ['claude'] },
        ],
      })
    );

    const commands = loadUserCatalogCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: 'loop',
      description: 'Run on a recurring interval',
      category: 'standard-util',
      cliTools: ['claude'],
      source: 'user-catalog',
      isStandard: false,
      filePath: '',
    });
    // descriptionKey is ignored for user entries.
    expect(commands[0].descriptionKey).toBeUndefined();
  });

  it('falls back to the standard-util category when category is omitted/invalid', () => {
    writeCatalogFile(
      'c.json',
      JSON.stringify({
        commands: [
          { name: 'a', description: 'no category', cliTools: ['claude'] },
          { name: 'b', description: 'bad category', category: 'nonsense', cliTools: ['claude'] },
        ],
      })
    );

    const commands = loadUserCatalogCommands();
    expect(commands.map((c) => c.category)).toEqual(['standard-util', 'standard-util']);
  });

  it('treats a user entry without cliTools as Claude-only (undefined scope)', () => {
    writeCatalogFile('c.json', JSON.stringify({ commands: [{ name: 'solo', description: 'x' }] }));
    const commands = loadUserCatalogCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0].cliTools).toBeUndefined();
  });

  it('skips a single broken JSON file without throwing', () => {
    writeCatalogFile('broken.json', '{ this is not valid json');
    expect(loadUserCatalogCommands()).toEqual([]);
  });

  it('keeps valid files when another file in the directory is broken', () => {
    writeCatalogFile('broken.json', 'nope');
    writeCatalogFile('ok.json', JSON.stringify({ commands: [{ name: 'ok', description: 'd', cliTools: ['claude'] }] }));
    const commands = loadUserCatalogCommands();
    expect(commands.map((c) => c.name)).toEqual(['ok']);
  });

  it('skips files larger than 64KB', () => {
    const bigDescription = 'x'.repeat(70_000);
    writeCatalogFile('big.json', JSON.stringify({ commands: [{ name: 'big', description: bigDescription, cliTools: ['claude'] }] }));
    expect(loadUserCatalogCommands()).toEqual([]);
  });

  it('caps entries per file at 200', () => {
    const commands = Array.from({ length: 250 }, (_, i) => ({ name: `cmd${i}`, description: 'd', cliTools: ['claude'] }));
    writeCatalogFile('many.json', JSON.stringify({ commands }));
    expect(loadUserCatalogCommands()).toHaveLength(200);
  });

  it('skips entries with a non-array or invalid cliTools value', () => {
    writeCatalogFile(
      'c.json',
      JSON.stringify({
        commands: [
          { name: 'stringtools', description: 'd', cliTools: 'claude' },
          { name: 'invalidtool', description: 'd', cliTools: ['not-a-tool'] },
          { name: 'good', description: 'd', cliTools: ['claude'] },
        ],
      })
    );
    const commands = loadUserCatalogCommands();
    expect(commands.map((c) => c.name)).toEqual(['good']);
  });

  it('skips entries missing a usable name', () => {
    writeCatalogFile(
      'c.json',
      JSON.stringify({ commands: [{ description: 'no name' }, { name: '   ', description: 'blank' }, { name: 'real', description: 'd' }] })
    );
    expect(loadUserCatalogCommands().map((c) => c.name)).toEqual(['real']);
  });

  it('truncates over-long name and description to the reused skill limits', () => {
    writeCatalogFile(
      'c.json',
      JSON.stringify({ commands: [{ name: 'n'.repeat(200), description: 'd'.repeat(1000), cliTools: ['claude'] }] })
    );
    const [cmd] = loadUserCatalogCommands();
    expect(cmd.name.length).toBeLessThanOrEqual(100);
    expect(cmd.description!.length).toBeLessThanOrEqual(500);
  });

  it('ignores non-.json files and returns [] on an empty commands array', () => {
    writeCatalogFile('notes.txt', 'ignored');
    writeCatalogFile('empty.json', JSON.stringify({ commands: [] }));
    expect(loadUserCatalogCommands()).toEqual([]);
  });

  it('caches results until clearCatalogCache() is called', () => {
    writeCatalogFile('c.json', JSON.stringify({ commands: [{ name: 'one', description: 'd', cliTools: ['claude'] }] }));
    expect(loadUserCatalogCommands()).toHaveLength(1);

    // A second file added after the first load is not seen (cache).
    writeCatalogFile('d.json', JSON.stringify({ commands: [{ name: 'two', description: 'd', cliTools: ['claude'] }] }));
    expect(loadUserCatalogCommands()).toHaveLength(1);

    clearCatalogCache();
    expect(loadUserCatalogCommands()).toHaveLength(2);
  });
});

// --- Standard-layer composition (merge order) -------------------------------

describe('composeStandardLayer', () => {
  const userFocus: SlashCommand = {
    name: 'focus',
    description: 'user override of focus',
    category: 'standard-session',
    cliTools: ['claude'],
    source: 'user-catalog',
    isStandard: false,
    filePath: '',
  };

  it('returns the bundled groups unchanged when there are no user commands', () => {
    const bundled = getStandardCommandGroups();
    expect(composeStandardLayer(bundled, [])).toBe(bundled);
  });

  it('lets a user entry override a bundled entry with the same name + scope', () => {
    const bundled = getStandardCommandGroups();
    const layer = composeStandardLayer(bundled, [userFocus]);
    const focus = flatten(layer).find((c) => c.name === 'focus');
    expect(focus).toBeDefined();
    expect(focus?.source).toBe('user-catalog');
    expect(focus?.description).toBe('user override of focus');
  });

  it('adds a brand-new user command (not in the bundled catalog)', () => {
    // Issue #1488: /loop is now a bundled built-in, so use a clearly-synthetic
    // name to keep exercising the add (not override) path.
    const bundled = getStandardCommandGroups();
    const custom: SlashCommand = {
      name: 'my-user-macro',
      description: 'Run on a recurring interval',
      category: 'standard-util',
      cliTools: ['claude'],
      source: 'user-catalog',
      isStandard: false,
      filePath: '',
    };
    const names = flatten(composeStandardLayer(bundled, [custom])).map((c) => c.name);
    expect(names).toContain('my-user-macro');
  });

  it('keeps SF-1: a worktree command still overrides a user-catalog entry', () => {
    const bundled = getStandardCommandGroups();
    const standardLayer = composeStandardLayer(bundled, [userFocus]);

    const worktreeGroups: SlashCommandGroup[] = [
      {
        category: 'standard-session',
        label: 'Standard (Session)',
        commands: [
          { name: 'focus', description: 'worktree focus', category: 'standard-session', cliTools: ['claude'], source: 'worktree', filePath: '' },
        ],
      },
    ];

    const merged = mergeCommandGroups(standardLayer, worktreeGroups);
    const focus = flatten(merged).find((c) => c.name === 'focus');
    expect(focus?.source).toBe('worktree');
    expect(focus?.description).toBe('worktree focus');
  });
});

// --- Version parsing/comparison ---------------------------------------------

describe('parseCliVersion', () => {
  it('extracts the version from real --version output formats', () => {
    expect(parseCliVersion('2.1.218 (Claude Code)')).toBe('2.1.218');
    expect(parseCliVersion('codex-cli 0.144.6')).toBe('0.144.6');
    expect(parseCliVersion('1.1.3')).toBe('1.1.3');
  });

  it('returns null when no version is present', () => {
    expect(parseCliVersion('no version here')).toBeNull();
    expect(parseCliVersion('')).toBeNull();
  });
});

describe('compareCliVersions', () => {
  it('orders by major.minor.patch numerically', () => {
    expect(compareCliVersions('2.2.0', '2.1.218')).toBe(1);
    expect(compareCliVersions('2.1.218', '2.1.218')).toBe(0);
    expect(compareCliVersions('2.1.0', '2.1.218')).toBe(-1);
    expect(compareCliVersions('0.144.6', '0.144.5')).toBe(1);
  });
});

// --- Staleness detection ----------------------------------------------------

describe('getCatalogStaleness', () => {
  it('marks a tool stale when the installed CLI is newer than verifiedAgainst', async () => {
    execTable = {
      claude: { stdout: '2.5.0 (Claude Code)' },
      codex: { stdout: 'codex-cli 0.144.6' }, // equal
      agy: { error: true }, // missing
    };
    const staleness = await getCatalogStaleness();
    expect(staleness.claude).toEqual({ current: '2.5.0', verifiedAgainst: '2.1.218', stale: true });
    expect(staleness.codex).toEqual({ current: '0.144.6', verifiedAgainst: '0.148.0', stale: false });
    // Missing binary → not reported at all.
    expect(staleness.antigravity).toBeUndefined();
  });

  // Issue #1913: opencode and copilot joined the probe table, so drift in their
  // catalog entries becomes visible instead of silent.
  it('reports opencode and copilot against their catalog verifiedAgainst', async () => {
    execTable = {
      claude: { error: true },
      codex: { error: true },
      agy: { error: true },
      opencode: { stdout: '1.18.30' },
      gh: { stdout: 'GitHub Copilot CLI 1.0.80.' }, // equal
    };
    const staleness = await getCatalogStaleness();
    expect(staleness.opencode).toEqual({
      current: '1.18.30',
      verifiedAgainst: '1.18.21',
      stale: true,
    });
    expect(staleness.copilot).toEqual({
      current: '1.0.80',
      verifiedAgainst: '1.0.80',
      stale: false,
    });
  });

  // DR4-010 (1): probe the executable the session actually launches. Copilot is
  // started as `gh copilot` (COPILOT_LAUNCH_COMMAND), so probing a bare
  // `copilot` off PATH would report the version of a different binary — and on
  // a machine that has the standalone `copilot` but not the gh extension, it
  // would report a version for a tool CommandMate cannot start.
  it('probes copilot through `gh copilot -- --version`, never a bare copilot', async () => {
    execTable = { gh: { stdout: 'GitHub Copilot CLI 1.0.80.' } };
    await getCatalogStaleness();

    const gh = execCalls.find((call) => call.command === 'gh');
    expect(gh, 'no gh probe was issued').toBeDefined();
    expect(gh?.args).toEqual(['copilot', '--', '--version']);
    expect(execCalls.some((call) => call.command === 'copilot')).toBe(false);
  });

  // DR4-010 (3)(4): a probe hands a third-party CLI a sanitized environment and
  // caps how much of its answer is buffered. DR4-010 (2) — absolute-path
  // resolution — is not asserted here; §13.2 S17 places that receipt on
  // DETECTOR_VERSION_PROBES in Phase 3 (see the note on probeCliVersion).
  it('runs every probe with a sanitized env and an explicit byte cap', async () => {
    process.env.CM_AUTH_TOKEN_HASH = 'must-not-reach-the-child';
    try {
      execTable = { claude: { stdout: '2.1.218' } };
      await getCatalogStaleness();

      expect(execCalls.map((call) => call.command).sort()).toEqual([
        'agy',
        'claude',
        'codex',
        'gh',
        'opencode',
      ]);
      for (const call of execCalls) {
        expect(call.opts.timeout).toBe(5000);
        expect(call.opts.maxBuffer).toBe(64 * 1024);
        expect(call.opts.env, `${call.command} inherited process.env verbatim`).toBeDefined();
        for (const key of SENSITIVE_ENV_KEYS) {
          expect(call.opts.env?.[key], `${key} leaked into the probe env`).toBeUndefined();
        }
      }
    } finally {
      delete process.env.CM_AUTH_TOKEN_HASH;
    }
  });

  it('reports stale=false for an older or equal CLI', async () => {
    execTable = {
      claude: { stdout: '2.1.0 (Claude Code)' }, // older
      codex: { stdout: 'codex-cli 0.144.6' }, // equal
      agy: { stdout: '1.1.3' }, // equal
    };
    const staleness = await getCatalogStaleness();
    expect(staleness.claude.stale).toBe(false);
    expect(staleness.codex.stale).toBe(false);
    expect(staleness.antigravity.stale).toBe(false);
  });

  it('omits tools whose version output is unparseable', async () => {
    execTable = {
      claude: { stdout: 'unknown build' },
      codex: { error: true },
      agy: { error: true },
      opencode: { error: true },
      gh: { error: true },
    };
    const staleness = await getCatalogStaleness();
    expect(staleness).toEqual({});
  });

  it('caches the result across calls within a process', async () => {
    execTable = { claude: { stdout: '2.9.0' } };
    const first = await getCatalogStaleness();
    // Change the table; a cached call must not re-probe.
    execTable = { claude: { stdout: '2.1.0' } };
    const second = await getCatalogStaleness();
    expect(second).toEqual(first);
    expect(second.claude.stale).toBe(true);
  });
});
