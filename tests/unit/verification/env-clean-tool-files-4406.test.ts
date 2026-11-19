/**
 * Issue #4406: files a tool places on its own must not read as the worker's work,
 * and the worker's real work must still be counted.
 *
 * Out of scope (docs: workspace same-kind findings, TOCTOU): a deliberate swap of
 * a file by the same user the worker runs as. That uid can write the worktree,
 * `~/.commandmate` and the env-clean baselines alike, so no check here can stop
 * it. What is pinned is that a tool's own state stops counting and that nothing
 * else does.
 *
 * `~/.commandmate/resource.yaml` (part 2): the user's resource config (#4370),
 * re-read by every call of the resource gate. Who placed it cannot be shown here,
 * so its appearance stays a violation (decision on #4406; the owner check that
 * would make it pass is #4497). What changes is the report: a separate `    · `
 * line under the violation gives the shape check and the sha256, so the
 * adjudicator can compare it with what the PM placed. The `+` line keeps its
 * owner as the last token, so wait-verify's item name is unchanged.
 *
 * `.commandcode/` (part 1): Command Code's state in a worktree is
 * `.commandcode/settings.local.json` (CommandMate writes it on every Command Code
 * start, merging into what is there) and `.commandcode/taste/` (Command Code's
 * own). The product gates already excuse exactly these untracked paths by the
 * #3126 roster (`src/lib/skills/agent-state-paths.ts`); the orchestrator's
 * dirty-tree check (scripts/orchestrate/dirty-tree.mjs, shared by wait-verify,
 * precheck, merge-pr, publish-pr and merge-train) did not, and failed
 * `wait-verify` with exit 3. dirty-tree now carries a copy of the same roster and
 * matches it itself, case-sensitively, on untracked entries only. Not through
 * `.gitignore`: git's `core.ignorecase` (the default on macOS) would also hide
 * `.COMMANDCODE/Settings.local.json`, which the roster does not excuse (PM's
 * decision on review P2-1).
 *
 * The git runs are isolated from the machine (no global or system config, no XDG
 * excludes file) but keep the repository's own `core.ignorecase` as `git init`
 * set it, so on macOS the case variants run under the setting that hid them.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  AGENT_STATE_DIR_PREFIXES,
  AGENT_STATE_FILES,
  isAgentStatePath,
} from '@/lib/skills/agent-state-paths';
import {
  AGENT_STATE_DIR_PREFIXES as MJS_AGENT_STATE_DIR_PREFIXES,
  AGENT_STATE_FILES as MJS_AGENT_STATE_FILES,
  IGNORED_DIRTY,
  dirtyPaths,
  isAgentStatePath as mjsIsAgentStatePath,
} from '../../../scripts/orchestrate/dirty-tree.mjs';
import { diffEnvSnapshots, formatEnvCleanReport } from '@/lib/verification/env-clean-gate';
import {
  ENV_SNAPSHOT_VERSION,
  RESOURCE_CONFIG_MAX_BYTES,
  RESOURCE_CONFIG_REASON_MAX_CHARS,
  RESOURCE_CONFIG_TOP_KEYS,
  probeCommandmateEntries,
  probeHomeEntries,
  readRegularFileNoFollow,
  type EnvEntry,
  type EnvProbeDeps,
  type EnvProbeId,
  type EnvProbeResult,
  type EnvSnapshot,
} from '@/lib/verification/env-snapshot';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { REAL_SHELL_SUBPROCESS_TIMEOUT_MS } from '@tests/helpers/real-shell-budget';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) removeTempDir(tempDirs.pop() as string);
});

/**
 * The environment git runs with: no user/system config and no XDG excludes file
 * (`~/.config/git/ignore` hides `.claude/settings.local.json` on developer
 * machines). An inherited `GIT_DIR` / `GIT_INDEX_FILE` / `GIT_WORK_TREE` (a test
 * run from a git hook) would aim `init` / `commit` at the real repository, so
 * they are dropped.
 */
function gitEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.no-xdg'),
  };
}

const GIT_ISOLATION = ['-c', 'core.excludesFile=/dev/null'];

function git(args: string[], cwd: string): string {
  return execFileSync('git', [...GIT_ISOLATION, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    env: gitEnv(cwd),
  });
}

/** The `run` dirty-tree.mjs is given by its callers (`spawnSync` → status / stdout / stderr), isolated. */
function realRun(home: string) {
  return (command: string, args: string[]) => {
    const result = spawnSync(command, [...GIT_ISOLATION, ...args], {
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
      env: gitEnv(home),
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
}

function write(repo: string, relativePath: string, contents = 'x\n'): void {
  const absolute = join(repo, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

/** A fresh repository with one committed file and no `.gitignore` of its own. */
function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tool-files-4406-')));
  tempDirs.push(dir);
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'a@example.test'], dir);
  git(['config', 'user.name', 'A'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  write(dir, 'src/greet.ts', 'export const greet = 1;\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'base'], dir);
  return dir;
}

/** What wait-verify / precheck / merge-pr / publish-pr see as uncommitted. */
function dirty(repo: string): string[] {
  return dirtyPaths(realRun(repo), repo);
}

describe('.commandcode/ tool state is not uncommitted work (#4406)', () => {
  it('R2: settings.local.json and taste/ written at a Command Code start leave the tree clean', () => {
    const repo = createRepo();
    write(repo, '.commandcode/settings.local.json', '{"hooks":{}}\n');
    write(repo, '.commandcode/taste/taste.md', 'prefers tabs\n');
    write(repo, '.commandcode/taste/nested/a.json', '{}\n');

    expect(dirty(repo)).toEqual([]);
  });

  it('R2: beside other work, only the tool state is dropped and the work is named file by file', () => {
    const repo = createRepo();
    write(repo, '.commandcode/settings.local.json');
    write(repo, '.commandcode/taste/taste.md');
    write(repo, '.commandcode/skills/x/SKILL.md');

    expect(dirty(repo)).toEqual(['.commandcode/skills/x/SKILL.md']);
  });

  it('S2: dirty-tree.mjs carries the same roster as src/lib/skills/agent-state-paths.ts', () => {
    expect([...MJS_AGENT_STATE_FILES]).toEqual([...AGENT_STATE_FILES]);
    expect([...MJS_AGENT_STATE_DIR_PREFIXES]).toEqual([...AGENT_STATE_DIR_PREFIXES]);
    for (const path of ['.commandcode/taste/../x.md', '.commandcode/settings.json', '.Commandcode/settings.local.json']) {
      expect(mjsIsAgentStatePath(path)).toBe(isAgentStatePath(path));
    }
  });

  it('S2: every path the #3126 roster excuses leaves a real tree clean', () => {
    const repo = createRepo();
    const samples = [
      ...AGENT_STATE_FILES,
      ...AGENT_STATE_DIR_PREFIXES.map((prefix) => `${prefix}sample.md`),
    ];
    for (const path of samples) {
      expect(isAgentStatePath(path)).toBe(true);
      write(repo, path);
    }

    expect(dirty(repo)).toEqual([]);
  });

  it('the exclusion is not in the repository .gitignore (git ignorecase would widen it)', () => {
    expect(readFileSync(join(process.cwd(), '.gitignore'), 'utf8')).not.toContain('.commandcode');
  });

  // One repository each: on a case-insensitive filesystem `.COMMANDCODE/` and
  // `.commandcode/` would be the same directory, and a sibling must not mask one.
  const work = [
    'src/new-feature.ts',
    '.commandcode/skills/x/SKILL.md',
    '.commandcode/commands/x.md',
    '.commandcode/other.ts',
    '.commandcode/settings.json',
    '.commandcode/settings.local.json.bak',
    // A directory named like the excused file.
    '.commandcode/settings.local.json/x',
    '.commandcode/settings.local.json/x/payload.ts',
    // Case variants: the roster is case-sensitive, whatever core.ignorecase says.
    '.COMMANDCODE/Settings.local.json',
    '.COMMANDCODE/settings.local.json',
    '.commandcode/Settings.local.json',
    '.commandcode/Taste/x.md',
    '.COMMANDCODE/taste/x.md',
    // The same names anywhere but the repository root.
    'src/.commandcode/settings.local.json',
    'src/.commandcode/taste/a.md',
    '.commandcodex/settings.local.json',
    '.commandcodex/taste/a.md',
  ];

  it.each(work)('N7: %s is still uncommitted work', (path) => {
    const repo = createRepo();
    write(repo, path);

    expect(dirty(repo).length).toBeGreaterThan(0);
  });

  it('N7: work and tool state together still report the work', () => {
    const repo = createRepo();
    write(repo, '.commandcode/settings.local.json');
    write(repo, '.commandcode/other.ts');
    write(repo, '.commandcode/settings.local.json.bak');

    expect(dirty(repo)).toEqual(['.commandcode/other.ts', '.commandcode/settings.local.json.bak']);
  });

  it('N7: a file (not a directory) named .commandcode is still uncommitted', () => {
    const repo = createRepo();
    write(repo, '.commandcode', 'not a directory\n');

    expect(dirty(repo)).toEqual(['.commandcode']);
  });

  it('N7: a tracked file under .commandcode/ that changes is still counted (untracked only)', () => {
    const repo = createRepo();
    write(repo, '.commandcode/settings.local.json', '{}\n');
    git(['add', '-f', '.commandcode/settings.local.json'], repo);
    git(['commit', '-q', '-m', 'force-added'], repo);
    write(repo, '.commandcode/settings.local.json', '{"permissions":{"allow":["*"]}}\n');

    expect(dirty(repo)).toEqual(['.commandcode/settings.local.json']);
  });

  it('callers see the same answer as before when no tool state is involved (one git call, same list)', () => {
    const calls: string[][] = [];
    const run = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return {
        status: 0,
        stdout: ' M src/a.ts\n?? .commandmate/tasks/issue-1.yaml\n?? dev-reports/x.md\n?? newdir/\nR  old.ts -> new.ts\n',
        stderr: '',
      };
    };

    expect(dirtyPaths(run, '/wt')).toEqual(['src/a.ts', 'newdir/', 'old.ts -> new.ts']);
    expect(calls).toEqual([['git', '-C', '/wt', 'status', '--porcelain']]);
    expect(IGNORED_DIRTY).toEqual(['.commandmate/tasks/', 'dev-reports/']);
  });

  it('a git failure still throws, including on the expansion of .commandcode/', () => {
    const failing = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' });
    expect(() => dirtyPaths(failing, '/wt')).toThrow('git status --porcelain failed in /wt');

    let n = 0;
    const second = () =>
      ++n === 1
        ? { status: 0, stdout: '?? .commandcode/\n', stderr: '' }
        : { status: 128, stdout: '', stderr: 'fatal: boom' };
    expect(() => dirtyPaths(second, '/wt')).toThrow('git status --porcelain -uall -- .commandcode/ failed in /wt');
  });
});

// =============================================================================
// Part 2: ~/.commandmate/resource.yaml
// =============================================================================

const WORKTREE_ID = 'commandmate-issue-4406';
const CONTEXT = { worktreeId: WORKTREE_ID, worktreePath: '/Users/dev/work/commandmate-issue-4406' };
const STARTED = 1_763_500_000_000;
const VERIFIED = STARTED + 60 * 60 * 1000;

/**
 * wait-verify.mjs `envCleanItems`' line rule, copied (a `.mjs` that runs git is
 * not imported here): a change line is `    <+|-> <name> [<owner>]`, read only
 * under a VIOLATED probe header.
 */
function envCleanItems(report: string): string[] {
  const items: string[] = [];
  let probe: string | null = null;
  for (const line of report.split('\n')) {
    const header = /^ {2}(\S+) (\S+) \(/.exec(line);
    if (header) probe = header[2] === 'VIOLATED' ? header[1] : null;
    const change = /^ {4}([+-]) (.+) \[([^\]]+)\]$/.exec(line);
    if (!probe || !change || change[3] === 'self' || change[3].startsWith('task session')) continue;
    items.push(`${probe}:${change[1]}${change[2]}`);
  }
  return items;
}

function makeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cm-env-clean-4406-')));
  tempDirs.push(home);
  mkdirSync(join(home, '.commandmate'));
  return home;
}

/** The real probes (and the real no-follow read), pointed at a private HOME. */
function deps(home: string): EnvProbeDeps {
  return {
    run: async () => ({ code: 0, stdout: '', stderr: '', failure: null }),
    readDir: (path: string) => readdirSync(path),
    homeDir: () => home,
  };
}

const EMPTY: EnvProbeResult = { status: 'ok', entries: [], reason: null };

function snapshotOf(
  commandmate: EnvProbeResult,
  capturedAt: number,
  home: EnvProbeResult = EMPTY
): EnvSnapshot {
  const probes: Record<EnvProbeId, EnvProbeResult> = {
    listeners: EMPTY,
    'tmux-sessions': EMPTY,
    'home-entries': home,
    'commandmate-entries': commandmate,
  };
  return { version: ENV_SNAPSHOT_VERSION, capturedAt, worktreeId: WORKTREE_ID, probes };
}

function snapshot(home: string, capturedAt: number): EnvSnapshot {
  return snapshotOf(probeCommandmateEntries(deps(home)), capturedAt, probeHomeEntries(deps(home)));
}

/** Snapshot, mutate, snapshot, compare, render. */
function judge(home: string, mutate: () => void) {
  const before = snapshot(home, STARTED);
  mutate();
  const diff = diffEnvSnapshots(before, snapshot(home, VERIFIED), CONTEXT, {
    resolvePidCwd: () => null,
    sessionKills: [],
  });
  const commandmate = diff.probes.find((p) => p.probeId === 'commandmate-entries')!;
  return { diff, commandmate, report: formatEnvCleanReport(diff) };
}

const VALID = 'version: 1\ncommandmate_share: 0.5\nweights: { cpu_heavy: 4 }\nci_vm: { cpus: 8 }\n';
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const configPath = (home: string, name = 'resource.yaml') => join(home, '.commandmate', name);

/** The report line right after `+ resource.yaml [unattributed]` (or `-`). */
function noteUnder(report: string, sign: '+' | '-'): string | undefined {
  const lines = report.split('\n');
  const at = lines.indexOf(`    ${sign} resource.yaml [unattributed]`);
  return at < 0 ? undefined : lines[at + 1];
}

describe('~/.commandmate/resource.yaml stays a violation, with the reading beside it (#4406)', () => {
  it('R1: a valid config placed during the task is VIOLATED, the shape and sha256 on a separate line', () => {
    const home = makeHome();
    const { diff, commandmate, report } = judge(home, () => writeFileSync(configPath(home), VALID));

    expect(diff.status).toBe('violated');
    expect(commandmate.status).toBe('violated');
    expect(commandmate.added.map((c) => [c.key, c.owner])).toEqual([['resource.yaml', 'unattributed']]);
    expect(noteUnder(report, '+')).toBe(
      `    · resource.yaml: the user's resource config (#4370), shape=ok sha256=${sha(VALID).slice(0, 12)} ` +
        `size=${Buffer.byteLength(VALID)}B — counted; adjudicate per docs/orchestrate/exit-codes.md 3-4 (owner check: #4497)`
    );
    // wait-verify's item name is unchanged by the note.
    expect(envCleanItems(report)).toEqual(['commandmate-entries:+resource.yaml']);
  });

  it('R1: keys under which a later PR runs commands are named on the note (still counted)', () => {
    const home = makeHome();
    const text = 'version: 1\nrunners: { total_max: 4 }\n';
    const { commandmate, report } = judge(home, () => writeFileSync(configPath(home), text));

    expect(commandmate.status).toBe('violated');
    expect(noteUnder(report, '+')).toContain('shape=ok (has runners) sha256=');
  });

  it('N1: an unknown file the work wrote under ~/.commandmate is VIOLATED, with no config note', () => {
    const home = makeHome();
    const { commandmate, report } = judge(home, () =>
      writeFileSync(join(home, '.commandmate', 'notes.txt'), 'x\n')
    );

    expect(commandmate.added.map((c) => c.key)).toEqual(['notes.txt']);
    expect(report).toContain('    + notes.txt [unattributed]');
    expect(report).not.toContain('resource config');
  });

  const invalid: Array<[string, (path: string, home: string) => void, string]> = [
    ['not YAML', (p) => writeFileSync(p, 'a: [1, 2\n'), 'shape=invalid (not YAML'],
    ['a list at the top', (p) => writeFileSync(p, '- 1\n- 2\n'), 'shape=invalid (the top level is not a mapping)'],
    ['another version', (p) => writeFileSync(p, 'version: 2\n'), 'shape=invalid (version 2 is not 1)'],
    ['an unknown key', (p) => writeFileSync(p, 'version: 1\nshare: 1\n'), 'shape=invalid (unknown key "share")'],
    ['not UTF-8', (p) => writeFileSync(p, Buffer.from([0x76, 0x3a, 0xff, 0xfe, 0x0a])), 'shape=invalid (not UTF-8)'],
    ['a directory', (p) => mkdirSync(p), 'shape=invalid (not a regular file)'],
    [
      'a symlink to a valid file',
      (p, home) => {
        writeFileSync(join(home, 'elsewhere.yaml'), VALID);
        symlinkSync(join(home, 'elsewhere.yaml'), p);
      },
      'shape=invalid (a symlink (not followed))',
    ],
    [
      'a hard link to a valid file',
      (p, home) => {
        writeFileSync(join(home, 'elsewhere.yaml'), VALID);
        linkSync(join(home, 'elsewhere.yaml'), p);
      },
      'shape=invalid (a hard link (nlink=2))',
    ],
    [
      'larger than 64 KiB',
      (p) => writeFileSync(p, `# ${'x'.repeat(RESOURCE_CONFIG_MAX_BYTES)}\nversion: 1\n`),
      `shape=invalid (larger than ${RESOURCE_CONFIG_MAX_BYTES} bytes`,
    ],
  ];

  it.each(invalid)('N2: %s stays VIOLATED and the note says why', (_name, place, expected) => {
    const home = makeHome();
    const { commandmate, report } = judge(home, () => place(configPath(home), home));

    expect(commandmate.status).toBe('violated');
    expect(commandmate.added.map((c) => c.key)).toContain('resource.yaml');
    expect(noteUnder(report, '+')).toContain(expected);
    expect(envCleanItems(report)).toContain('commandmate-entries:+resource.yaml');
  });

  it('N3: look-alike names stay VIOLATED and get no config note', () => {
    const home = makeHome();
    const { commandmate, report } = judge(home, () => {
      writeFileSync(configPath(home, 'resource.yml'), VALID);
      writeFileSync(configPath(home, 'resource.yaml.bak'), VALID);
    });

    expect(commandmate.added.map((c) => c.key)).toEqual(['resource.yaml.bak', 'resource.yml']);
    expect(report).not.toContain('resource config');
  });

  it('N3: a case variant is another name (judged on entries, not on the filesystem)', () => {
    const entry: EnvEntry = { key: 'Resource.yaml', detail: null, anchor: null };
    const diff = diffEnvSnapshots(
      snapshotOf(EMPTY, STARTED),
      snapshotOf({ status: 'ok', entries: [entry], reason: null }, VERIFIED),
      CONTEXT,
      { resolvePidCwd: () => null, sessionKills: [] }
    );

    expect(diff.status).toBe('violated');
    expect(formatEnvCleanReport(diff)).not.toContain('resource config');
  });

  it('N4: an entry with no reading (a snapshot from before #4406) stays VIOLATED, "not checked"', () => {
    const entry: EnvEntry = { key: 'resource.yaml', detail: null, anchor: null };
    const diff = diffEnvSnapshots(
      snapshotOf(EMPTY, STARTED),
      snapshotOf({ status: 'ok', entries: [entry], reason: null }, VERIFIED),
      CONTEXT,
      { resolvePidCwd: () => null, sessionKills: [] }
    );
    const report = formatEnvCleanReport(diff);

    expect(diff.status).toBe('violated');
    expect(noteUnder(report, '+')).toContain('shape not checked (snapshot predates #4406) — counted');
  });

  it('N5: a config that existed at task start and is gone is VIOLATED, with what it held', () => {
    const home = makeHome();
    writeFileSync(configPath(home), VALID);
    const { commandmate, report } = judge(home, () => rmSync(configPath(home)));

    expect(commandmate.removed.map((c) => c.key)).toEqual(['resource.yaml']);
    expect(noteUnder(report, '-')).toContain(`at task start shape=ok sha256=${sha(VALID).slice(0, 12)}`);
    expect(envCleanItems(report)).toEqual(['commandmate-entries:-resource.yaml']);
  });

  it('N6: resource.yaml directly under $HOME is VIOLATED and gets no config note', () => {
    const home = makeHome();
    const { diff, report } = judge(home, () => writeFileSync(join(home, 'resource.yaml'), VALID));
    const homeProbe = diff.probes.find((p) => p.probeId === 'home-entries')!;

    expect(homeProbe.status).toBe('violated');
    expect(homeProbe.added.map((c) => c.key)).toEqual(['resource.yaml']);
    expect(report).not.toContain('resource config');
  });

  it('S1: a config rewritten during the task stays clean (names only) but the change is shown', () => {
    const home = makeHome();
    writeFileSync(configPath(home), VALID);
    const rewritten = VALID.replace('0.5', '1');
    const { diff, commandmate, report } = judge(home, () => writeFileSync(configPath(home), rewritten));

    expect(diff.status).toBe('clean');
    expect(commandmate.status).toBe('clean');
    expect(report).toContain(
      `    · ~ resource.yaml changed during the task (sha256 ${sha(VALID).slice(0, 12)} → ${sha(rewritten).slice(0, 12)})`
    );
    expect(envCleanItems(report)).toEqual([]);
  });

  it('S1: an unchanged config, or a baseline with no hash, says nothing', () => {
    const home = makeHome();
    writeFileSync(configPath(home), VALID);
    expect(judge(home, () => undefined).report).not.toContain('resource.yaml');

    const unread: EnvEntry = { key: 'resource.yaml', detail: null, anchor: null };
    const diff = diffEnvSnapshots(
      snapshotOf({ status: 'ok', entries: [unread], reason: null }, STARTED),
      snapshotOf(probeCommandmateEntries(deps(home)), VERIFIED),
      CONTEXT,
      { resolvePidCwd: () => null, sessionKills: [] }
    );
    expect(diff.status).toBe('clean');
    expect(formatEnvCleanReport(diff)).not.toContain('resource.yaml');
  });

  it('P2-2: a newline in a key cannot forge a + line: wait-verify reads the same items', () => {
    const home = makeHome();
    const text = '"a\\n    + fake [unattributed]": 1\nversion: 1\n';
    const { commandmate, report } = judge(home, () => writeFileSync(configPath(home), text));

    expect(commandmate.added.map((c) => c.key)).toEqual(['resource.yaml']);
    expect(report.split('\n').some((line) => line.startsWith('    + fake'))).toBe(false);
    expect(noteUnder(report, '+')).toContain('shape=invalid (unknown key "a\\n    + fake [unattributed]")');
    expect(envCleanItems(report)).toEqual(['commandmate-entries:+resource.yaml']);
  });

  it('P2-2: a forged "clean" header in a key does not drop the items after it', () => {
    const home = makeHome();
    const text = '"a\\n  commandmate-entries clean (x)": 1\n';
    const { report } = judge(home, () => {
      writeFileSync(configPath(home), text);
      writeFileSync(join(home, '.commandmate', 'zzz-left-behind.txt'), 'x\n');
    });

    expect(report.split('\n').filter((line) => line.startsWith('  commandmate-entries '))).toHaveLength(1);
    expect(envCleanItems(report)).toEqual([
      'commandmate-entries:+resource.yaml',
      'commandmate-entries:+zzz-left-behind.txt',
    ]);
  });

  it('P2-2: many unknown keys are counted, not listed, and the note line is bounded', () => {
    const home = makeHome();
    const keys = Array.from({ length: 3000 }, (_, i) => `key_${i}: 1`).join('\n');
    const { report } = judge(home, () => writeFileSync(configPath(home), `${keys}\n`));
    const note = noteUnder(report, '+')!;

    expect(note).toContain('unknown key "key_0", "key_1", "key_2", "key_3", "key_4" (+2995 more)');
    expect(note.length).toBeLessThan(RESOURCE_CONFIG_REASON_MAX_CHARS + 300);
  });

  it('P3-1: a loaded baseline whose reading has the wrong types reports, never throws', () => {
    const home = makeHome();
    writeFileSync(configPath(home), VALID);
    const forged = {
      key: 'resource.yaml',
      detail: null,
      anchor: null,
      config: { shape: 'ok', reason: 'x\n    + fake [unattributed]', sha256: 12345 },
    } as unknown as EnvEntry;
    const malformed = { key: 'resource.yaml', detail: null, anchor: null, config: { shape: 1 } } as unknown as EnvEntry;
    const options = { resolvePidCwd: () => null, sessionKills: [] };

    // Present on both sides: the baseline hash is not a string, so no change is claimed.
    const both = diffEnvSnapshots(
      snapshotOf({ status: 'ok', entries: [forged], reason: null }, STARTED),
      snapshotOf(probeCommandmateEntries(deps(home)), VERIFIED),
      CONTEXT,
      options
    );
    expect(both.status).toBe('clean');
    expect(() => formatEnvCleanReport(both)).not.toThrow();
    expect(formatEnvCleanReport(both)).not.toContain('resource.yaml');

    // Removed: the forged reading is printed escaped, with no `undefined`.
    const removed = diffEnvSnapshots(
      snapshotOf({ status: 'ok', entries: [forged], reason: null }, STARTED),
      snapshotOf(EMPTY, VERIFIED),
      CONTEXT,
      options
    );
    const removedReport = formatEnvCleanReport(removed);
    expect(removed.status).toBe('violated');
    expect(noteUnder(removedReport, '-')).toContain('shape=ok (x\\u000a    + fake [unattributed]) — counted');
    expect(removedReport).not.toContain('undefined');
    expect(envCleanItems(removedReport)).toEqual(['commandmate-entries:-resource.yaml']);

    // A reading of the wrong shape is no reading.
    const added = diffEnvSnapshots(
      snapshotOf(EMPTY, STARTED),
      snapshotOf({ status: 'ok', entries: [malformed], reason: null }, VERIFIED),
      CONTEXT,
      options
    );
    expect(noteUnder(formatEnvCleanReport(added), '+')).toContain('shape not checked');
  });

  it('S3: the gate\'s copy of the reader\'s top-level keys matches resource-config.mjs', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/orchestrate/resource-config.mjs'), 'utf8');
    const match = /const TOP_KEYS = new Set\(\[([^\]]*)\]\)/.exec(source);
    expect(match).not.toBeNull();
    const keys = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...RESOURCE_CONFIG_TOP_KEYS].sort()).toEqual(keys.sort());
  });

  it('reads with O_NOFOLLOW and fstat on the same fd: a symlink is refused, a regular file is read', () => {
    const home = makeHome();
    const file = join(home, 'a.yaml');
    writeFileSync(file, VALID);
    symlinkSync(file, join(home, 'link.yaml'));

    expect(readRegularFileNoFollow(file, RESOURCE_CONFIG_MAX_BYTES).toString('utf8')).toBe(VALID);
    expect(() => readRegularFileNoFollow(join(home, 'link.yaml'), RESOURCE_CONFIG_MAX_BYTES)).toThrow(
      'a symlink (not followed)'
    );
    expect(() => readRegularFileNoFollow(join(home, 'missing.yaml'), RESOURCE_CONFIG_MAX_BYTES)).toThrow(
      'cannot open (ENOENT)'
    );
  });
});
