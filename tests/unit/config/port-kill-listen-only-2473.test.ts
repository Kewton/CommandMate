/**
 * CI guard (Issue #2473): nothing this repository asks anybody to run may kill
 * what a port lookup returned unless that lookup was restricted to LISTEN.
 *
 * ## The incident
 *
 * On 2026-09-11 `/rebuild` ran `./scripts/stop.sh`, which printed
 * `Stopping process(es) on port 3000: 51331 61813`. 61813 was the server. The
 * other one could not be identified afterwards (the script logged a number
 * and nothing else), but Chrome relaunched its network service
 * (`--utility-sub-type=network.mojom.NetworkService`) right after the stop,
 * and the same lookup run after the restart returned Chrome's network service
 * next to the new server: it held six ESTABLISHED connections to :3000, the
 * CommandMate tab.
 *
 * `lsof -i:<port>` matches every socket whose local OR remote port is <port>.
 * Without `-sTCP:LISTEN` it returns each process connected TO the server: the
 * browser (and with it every other tab's traffic), another session's
 * `commandmate wait`, a hook relay's curl. stop.sh followed its SIGTERM with a
 * SIGKILL two seconds later. The lookup had been copied into five more
 * scripts, a skill, a slash command and six manuals.
 *
 * ## The rules
 *
 * 1. A runnable unit that looks a port up with lsof and kills must restrict
 *    that lookup to `-sTCP:LISTEN`. A unit is a shell script, one shell fence
 *    of a markdown file (untagged fences included), or one line of markdown
 *    prose: the /rebuild skill gave its instruction in prose.
 * 2. Under `scripts/`, every lsof port lookup is LISTEN-only, kill or not.
 *    status.sh and health-check.sh report what they find as the server, and
 *    start.sh / build-and-start.sh refuse to start over it.
 * 3. The six scripts that find the server by port do it through one helper,
 *    `scripts/lib/port-pids.sh`, instead of each carrying a copy (stop.sh and
 *    stop-server.sh had the same function twice), and the two that kill name
 *    each target before signalling it.
 *
 * `fuser <port>/tcp` is not read: it names the LOCAL port only, so a client
 * connected to the port is not in its answer to begin with.
 *
 * ## What this guard does not claim
 *
 * Like tmux-live-test-safety.test.ts, it reads the repository's own tracked
 * material. TS/JS reach lsof through argv (`['-nP', '-iTCP', '-sTCP:LISTEN']`
 * in src/lib/verification/env-snapshot.ts), which is not the shape read here,
 * and markdown code and data fences are not read. A lookup and a kill split
 * across two units (a fence that prints PIDs, then prose saying "kill them")
 * are not joined up. To QUOTE the bad lookup in a document, put it in a
 * `text` fence.
 *
 * That the helper really returns the listener and not its client is tested
 * with real processes in tests/unit/scripts/port-pids-listen-only-2473.test.ts.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

// =============================================================================
// What gets scanned
// =============================================================================

const SHELL_EXTENSIONS = ['.sh', '.bash', '.zsh'];

/**
 * The four roots Issue #2473 names come first. The rest are other homes of the
 * same recipes: worktree-cleanup's process helpers, Codex's copy of the
 * skills, and the repository-level agent instructions.
 */
const SCAN_ROOTS: ReadonlyArray<{ readonly root: string; readonly extensions: readonly string[] }> = [
  { root: 'scripts', extensions: [...SHELL_EXTENSIONS, '.md'] },
  { root: 'docs', extensions: ['.md'] },
  { root: '.claude/skills', extensions: [...SHELL_EXTENSIONS, '.md'] },
  { root: '.claude/commands', extensions: [...SHELL_EXTENSIONS, '.md'] },
  { root: '.claude/lib', extensions: SHELL_EXTENSIONS },
  { root: '.agents/skills', extensions: [...SHELL_EXTENSIONS, '.md'] },
  { root: 'AGENTS.md', extensions: ['.md'] },
  { root: 'CLAUDE.md', extensions: ['.md'] },
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'coverage']);

/**
 * Markdown fences read as commands. Untagged is in the list on purpose:
 * deleting a language tag must not be a way out of the scan.
 */
const SHELL_FENCE_LANGS: readonly string[] = ['', 'sh', 'bash', 'zsh', 'shell', 'console'];

/** The shared helper, and the scripts that must go through it. */
const HELPER = 'scripts/lib/port-pids.sh';
const SERVER_BY_PORT_SCRIPTS: readonly string[] = [
  'scripts/stop.sh',
  'scripts/stop-server.sh',
  'scripts/build-and-start.sh',
  'scripts/start.sh',
  'scripts/status.sh',
  'scripts/health-check.sh',
];
const KILLING_SCRIPTS: readonly string[] = ['scripts/stop.sh', 'scripts/stop-server.sh'];

/** Every document that told its reader to kill `lsof -ti:<port>` before #2473. */
const REWRITTEN_KILL_RECIPES: readonly string[] = [
  'docs/DEPLOYMENT.md',
  'docs/en/DEPLOYMENT.md',
  'docs/user-guide/cli-setup-guide.md',
  'docs/en/user-guide/cli-setup-guide.md',
  'docs/internal/TESTING_GUIDE.md',
  'docs/en/internal/TESTING_GUIDE.md',
  '.claude/commands/uat.md',
  '.claude/skills/rebuild/SKILL.md',
];

// =============================================================================
// Units
// =============================================================================

type UnitKind = 'script' | 'fence' | 'prose';

interface ScanUnit {
  /** Repo-relative, `/`-separated. */
  file: string;
  kind: UnitKind;
  /** 1-based line in the file of this unit's first line. */
  startLine: number;
  /** Comment-stripped for scripts and fences, raw for prose. */
  source: string;
}

interface Violation {
  file: string;
  line: number;
  lookup: string;
}

/**
 * Strips shell `#` comments outside quotes, so a script may explain the bad
 * lookup without being read as running it. `#` starts a comment only at the
 * beginning of a line or after whitespace (`${#x}` is not one). Offsets are
 * kept, so line numbers still point into the file.
 *
 * The same rules as tmux-live-test-safety.test.ts. Copied rather than
 * imported, because importing a test file registers its suites a second time.
 */
function stripShellComments(source: string): string {
  const out: string[] = [];
  let quote: string | undefined;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      out.push(ch);
      if (ch === '\\' && quote === '"' && i + 1 < source.length) {
        out.push(source[i + 1]);
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out.push(ch);
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(source[i - 1]))) {
      while (i < source.length && source[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      if (i < source.length) out.push('\n');
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

/**
 * Shell fences, each one unit, and prose lines, each one unit. Prose lines
 * that do not mention lsof cannot violate anything and are not kept.
 */
function markdownUnits(file: string, raw: string): ScanUnit[] {
  const lines = raw.split('\n');
  const units: ScanUnit[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)/.exec(lines[i]);
    if (!open) {
      if (lines[i].includes('lsof')) {
        units.push({ file, kind: 'prose', startLine: i + 1, source: lines[i] });
      }
      i += 1;
      continue;
    }
    const marker = open[1];
    const closer = new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !closer.test(lines[j])) j += 1;
    if (SHELL_FENCE_LANGS.includes(open[2].toLowerCase())) {
      units.push({
        file,
        kind: 'fence',
        startLine: i + 2,
        source: stripShellComments(lines.slice(i + 1, j).join('\n')),
      });
    }
    i = j + 1;
  }
  return units;
}

interface Scanned {
  files: string[];
  units: ScanUnit[];
}

/** Symlinks are never followed; the guard is about reproducible repository material. */
function collect(root: string): Scanned {
  const scanned: Scanned = { files: [], units: [] };
  const take = (full: string, requireShebang: boolean): void => {
    const raw = fs.readFileSync(full, 'utf-8');
    if (requireShebang && !/^#!.*\b(sh|bash|zsh)\b/.test(raw)) return;
    const file = path.relative(root, full).split(path.sep).join('/');
    scanned.files.push(file);
    if (file.endsWith('.md')) {
      scanned.units.push(...markdownUnits(file, raw));
    } else {
      scanned.units.push({ file, kind: 'script', startLine: 1, source: stripShellComments(raw) });
    }
  };

  for (const target of SCAN_ROOTS) {
    const absolute = path.join(root, target.root);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      take(absolute, false);
      continue;
    }
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) visit(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (target.extensions.some((ext) => entry.name.endsWith(ext))) {
          take(full, false);
        } else if (!entry.name.includes('.') && target.extensions.includes('.sh')) {
          take(full, true);
        }
      }
    };
    visit(absolute);
  }
  return scanned;
}

// =============================================================================
// Lookups
// =============================================================================

interface Lookup {
  /** Offset of `lsof` in the unit's source. */
  index: number;
  /** The invocation: `lsof` up to the end of its shell segment. */
  text: string;
  listenOnly: boolean;
}

/** `lsof` as a command word: `/usr/sbin/lsof` counts, `check_lsof_available` does not. */
const LSOF_WORD = /(^|[^A-Za-z0-9_-])lsof(?![A-Za-z0-9_-])/g;

/**
 * Where an lsof invocation ends: a pipe or list operator, the `)` or backtick
 * that closes a command substitution (or an inline code span), or an
 * unescaped newline.
 */
const SEGMENT_END = new Set(['|', ';', '&', ')', '`']);

/**
 * `-sTCP:LISTEN` with LISTEN as the whole state list. `-sTCP:LISTEN,ESTABLISHED`
 * admits the very connections this Issue is about, and `-sTCP:^LISTEN`
 * excludes the listener, so neither counts.
 */
const LISTEN_ONLY = /(^|\s)['"]?-s\s*['"]?TCP:LISTEN(?![A-Za-z0-9,^])/i;

/** `kill`, `pkill`, `killall` as words; not `kill-session`, `skill`, `killed`. */
const KILL_WORD = /(^|[^A-Za-z0-9_-])(kill|pkill|killall)(?![A-Za-z0-9_-])/i;

const unquote = (token: string): string => token.replace(/^['"]+|['"]+$/g, '');

/**
 * Whether lsof's `-i` names a port: `-i:3000`, `-ti:3000`, `-iTCP:"$port"`,
 * `-i :{UAT_PORT}`, `-i tcp:3000`.
 *
 * `-i` is the one lsof option that takes an attached value and still combines
 * with other letters (`-ti:3000`), so its value is whatever follows the `i` in
 * the same token, or else the next token unless that is another option. A port
 * is named iff the value carries `:` (lsof's `[46][protocol][@host][:port]`);
 * a bare `-i` or `-iTCP` is a census of every socket, not a lookup of one port.
 */
function selectsPort(args: readonly string[]): boolean {
  return args.some((arg, k) => {
    const option = /^-[A-Za-z]*?i(.*)$/.exec(arg);
    if (!option) return false;
    const next = args[k + 1];
    const value = option[1] !== '' ? option[1] : next !== undefined && !next.startsWith('-') ? next : '';
    return value.includes(':');
  });
}

function lsofLookups(source: string): Lookup[] {
  const lookups: Lookup[] = [];
  const word = new RegExp(LSOF_WORD.source, 'g');
  for (let match = word.exec(source); match; match = word.exec(source)) {
    const start = match.index + match[1].length;
    let end = start + 'lsof'.length;
    while (end < source.length) {
      const ch = source[end];
      if (ch === '\n' ? source[end - 1] !== '\\' : SEGMENT_END.has(ch)) break;
      end += 1;
    }
    const text = source.slice(start, end).replace(/\\\n/g, ' ').trim();
    const args = text.split(/\s+/).slice(1).map(unquote);
    if (!selectsPort(args)) continue;
    lookups.push({ index: start, text, listenOnly: LISTEN_ONLY.test(text) });
  }
  return lookups;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function violationsIn(unit: ScanUnit): Violation[] {
  const loose = lsofLookups(unit.source).filter((lookup) => !lookup.listenOnly);
  if (loose.length === 0) return [];
  // Rule 2: a script under scripts/ may not look a port up loosely at all.
  const everyLookup = unit.kind === 'script' && unit.file.startsWith('scripts/');
  if (!everyLookup && !KILL_WORD.test(unit.source)) return [];
  return loose.map((lookup) => ({
    file: unit.file,
    line: unit.startLine - 1 + lineOf(unit.source, lookup.index),
    lookup: lookup.text,
  }));
}

function scan(units: readonly ScanUnit[]): Violation[] {
  return units.flatMap(violationsIn);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

const repo = collect(REPO_ROOT);

// =============================================================================
// Fixture helpers for the scanner's own tests
// =============================================================================

/** Writes `files` into a throwaway tree and scans it. Nothing is ever executed. */
function scanFixture(files: Record<string, string>): Violation[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'port-kill-guard-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return scan(collect(root).units);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const fence = (body: string, lang = 'bash'): string => ['```' + lang, body, '```', ''].join('\n');

// =============================================================================
// The repository must be clean
// =============================================================================

describe('Issue #2473: nothing in this repository kills a port lookup that is not LISTEN-only', () => {
  it('has no runnable unit that kills what a loose port lookup returned', () => {
    expect(scan(repo.units)).toEqual([]);
  });

  it('read every root it claims to cover', () => {
    // A scan that silently collected nothing would pass the test above.
    const present = SCAN_ROOTS.map((target) => target.root).filter((root) =>
      fs.existsSync(path.join(REPO_ROOT, root))
    );
    expect(present.length).toBeGreaterThanOrEqual(6);
    for (const root of present) {
      const contributed = repo.files.some((file) => file === root || file.startsWith(`${root}/`));
      expect(contributed, `${root} contributed no files`).toBe(true);
    }
    expect(repo.files).toEqual(
      expect.arrayContaining([...REWRITTEN_KILL_RECIPES, ...SERVER_BY_PORT_SCRIPTS, HELPER])
    );
  });

  it.each(REWRITTEN_KILL_RECIPES)('%s still gives its kill recipe, now LISTEN-only', (rel) => {
    // Positive control: the recipes were fixed, not deleted, and the scanner
    // recognises the replacement spelling as a port lookup at all.
    const fixed = repo.units.filter(
      (unit) =>
        unit.file === rel &&
        KILL_WORD.test(unit.source) &&
        lsofLookups(unit.source).some((lookup) => lookup.listenOnly)
    );
    expect(fixed.length, `${rel} has no LISTEN-only kill recipe`).toBeGreaterThan(0);
  });

  it('names every root Issue #2473 lists', () => {
    const roots = SCAN_ROOTS.map((target) => target.root);
    expect(roots).toEqual(
      expect.arrayContaining(['scripts', 'docs', '.claude/skills', '.claude/commands'])
    );
  });
});

describe('Issue #2473: the scripts find the server through one LISTEN-only helper', () => {
  it(`${HELPER} makes exactly one lsof lookup, and it is LISTEN-only`, () => {
    const lookups = lsofLookups(stripShellComments(read(HELPER)));
    expect(lookups).toHaveLength(1);
    expect(lookups[0].text).toMatch(/^lsof -nP -iTCP:"\$port" -sTCP:LISTEN -t\b/);
    expect(lookups[0].listenOnly).toBe(true);
  });

  it.each(SERVER_BY_PORT_SCRIPTS)('%s sources the helper and has no lookup of its own', (rel) => {
    const code = stripShellComments(read(rel));
    expect(code).toContain('source "$SCRIPT_DIR/lib/port-pids.sh"');
    expect(code).toMatch(/\$\(find_listen_pids_by_port "\$PORT"\)/);
    expect(code).not.toMatch(LSOF_WORD);
    // The private copy stop.sh and stop-server.sh each carried is gone.
    expect(code).not.toContain('find_pids_by_port');
  });

  it.each(KILLING_SCRIPTS)('%s names each target right before signalling it', (rel) => {
    // The Issue could not say what PID 51331 had been: once a process is gone,
    // its number identifies nothing. So every kill of a looked-up PID list is
    // preceded by the line that prints "<verb> <pid> (<command line>)".
    const lines = stripShellComments(read(rel)).split('\n');
    const kills = lines.flatMap((line, index) => {
      const match = /^\s*echo "\$(\w+)" \| xargs kill\b/.exec(line);
      return match ? [{ index, variable: match[1] }] : [];
    });
    // SIGTERM, then the SIGKILL fallback, at least.
    expect(kills.length).toBeGreaterThanOrEqual(2);
    for (const { index, variable } of kills) {
      let previous = index - 1;
      while (previous >= 0 && lines[previous].trim() === '') previous -= 1;
      expect(lines[previous], `${rel}:${index + 1}`).toMatch(
        new RegExp(`^\\s*print_port_targets "[^"]+" \\$${variable}\\s*$`)
      );
    }
  });
});

// =============================================================================
// The scanner's own behaviour
// =============================================================================

describe('the scanner reports each shape of the incident', () => {
  it('reports the file and the line of the lookup', () => {
    const violations = scanFixture({
      'docs/deploy.md': ['# Deploy', '', '```bash', '# free the port', 'lsof -ti:3000 | xargs kill -9', '```'].join(
        '\n'
      ),
    });
    expect(violations).toEqual([{ file: 'docs/deploy.md', line: 5, lookup: 'lsof -ti:3000' }]);
  });

  it.each([
    ['a pipe into xargs kill', 'docs/a.md', fence('lsof -ti:3000 | xargs kill -9')],
    ['a command substitution', 'docs/a.md', fence('kill -9 $(lsof -ti:3000)')],
    ['backticks', 'docs/a.md', fence('kill -9 `lsof -t -i:3000`')],
    ['-i and -t as separate flags', 'docs/a.md', fence('lsof -i :$port -t | xargs kill')],
    [
      'the /uat placeholder spelling',
      '.claude/commands/uat.md',
      fence('lsof -i :{UAT_PORT} -t 2>/dev/null | xargs kill -9 2>/dev/null'),
    ],
    ['a protocol-qualified port', 'docs/a.md', fence('kill $(lsof -t -i tcp:3000)')],
    ['an absolute lsof path', 'docs/a.md', fence('/usr/sbin/lsof -ti:3000 | xargs kill')],
    ['the lookup and the kill on separate lines', 'docs/a.md', fence('PIDS=$(lsof -ti:3000)\nkill $PIDS')],
    ['an untagged fence', 'docs/a.md', fence('lsof -ti:3000 | xargs kill -9', '')],
    [
      'the /rebuild prose instruction before #2473',
      '.claude/skills/rebuild/SKILL.md',
      '**注意**: ポート競合が発生した場合は `lsof -i :{port} -t` でプロセスを特定し、killしてから再試行する。\n',
    ],
    ['an English prose instruction', 'docs/a.md', 'Kill whatever `lsof -ti:3000` prints.\n'],
    [
      'a state list that admits more than LISTEN',
      'docs/a.md',
      fence('lsof -iTCP:3000 -sTCP:LISTEN,ESTABLISHED -t | xargs kill'),
    ],
    ['a state filter that excludes LISTEN', 'docs/a.md', fence('lsof -iTCP:3000 -sTCP:^LISTEN -t | xargs kill')],
    [
      'stop.sh before #2473: the lookup in a function, the kill elsewhere',
      'scripts/stop.sh',
      [
        '#!/bin/bash',
        'find_pids_by_port() {',
        '  lsof -ti:"$1" 2>/dev/null | grep -E \'^[0-9]+$\' | sort -u || true',
        '}',
        'PIDS=$(find_pids_by_port $PORT)',
        'echo "$PIDS" | xargs kill 2>/dev/null',
        '',
      ].join('\n'),
    ],
    [
      'status.sh before #2473: under scripts/, reporting a loose lookup is enough',
      'scripts/status.sh',
      '#!/bin/bash\nPID=$(lsof -ti:$PORT)\necho "PID: $PID"\n',
    ],
    ['an extensionless shebang script under scripts/', 'scripts/probe', '#!/bin/sh\nlsof -ti:"$1"\n'],
  ])('reports %s', (_label, rel, content) => {
    expect(scanFixture({ [rel]: content })).toHaveLength(1);
  });
});

describe('the scanner accepts what is actually safe', () => {
  it.each([
    ['the LISTEN-only lookup piped into kill', 'docs/a.md', fence('lsof -nP -iTCP:3000 -sTCP:LISTEN -t | xargs kill -9')],
    [
      'the LISTEN-only lookup in a command substitution',
      'docs/a.md',
      fence('kill -9 $(lsof -nP -iTCP:3000 -sTCP:LISTEN -t)'),
    ],
    [
      'the .claude/lib/process-utils.sh spelling',
      '.claude/lib/p.sh',
      'pid=$(lsof -i ":$port" -t -sTCP:LISTEN 2>/dev/null | head -1)\nkill "$pid"\n',
    ],
    ['-s as a separate argument, before -i', 'docs/a.md', fence('lsof -s TCP:LISTEN -i :3000 -t | xargs kill')],
    ['a loose lookup that only displays (outside scripts/)', 'docs/a.md', fence('lsof -ti:3000')],
    ['a loose lookup mentioned in prose without a kill', 'docs/a.md', 'Check `lsof -ti:3000` before starting.\n'],
    ['the bad lookup quoted in a text fence', 'docs/a.md', fence('lsof -ti:3000 | xargs kill -9', 'text')],
    ['the bad lookup named in a shell comment', 'scripts/a.sh', '# never: lsof -ti:3000 | xargs kill -9\nexit 0\n'],
    [
      'prose that explains the flag and names no lookup',
      'docs/a.md',
      '`-sTCP:LISTEN` を外すと、接続しているだけのブラウザまで kill される。\n',
    ],
    [
      'an lsof that selects by PID, not by port',
      'docs/a.md',
      fence('p=$(lsof -nP -iTCP:3917 -sTCP:LISTEN -t | head -1)\nlsof -p "$p" | grep -q db.sqlite && kill "$p"'),
    ],
    ['a listener census that names no port', 'docs/a.md', fence('lsof -nP -iTCP -sTCP:LISTEN\nkill -9 12345')],
    ['fuser, which names the local port only', 'docs/a.md', fence('fuser 3000/tcp | xargs kill')],
    [
      'a display-only lookup next to an exact-match session teardown',
      'docs/a.md',
      fence("lsof -ti:3000\ntmux -L probe kill-session -t '=probe:'"),
    ],
  ])('accepts %s', (_label, rel, content) => {
    expect(scanFixture({ [rel]: content })).toEqual([]);
  });

  it('still sees a violation whose line also carries a comment', () => {
    // Comment stripping must not become a hiding place. Mutation control for
    // the shell-comment case above.
    expect(scanFixture({ 'scripts/a.sh': 'lsof -ti:3000 | xargs kill -9  # free the port\n' })).toHaveLength(1);
  });
});
