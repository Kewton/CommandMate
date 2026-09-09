/**
 * CI guard: nothing this repository asks anybody to run may reach the ambient
 * tmux server.
 *
 * ## The incidents this exists to prevent
 *
 * On 2026-08-02 a live tmux test isolated itself with `TMUX_TMPDIR` and tore
 * down with a bare `tmux kill-server`. `TMUX_TMPDIR` is only consulted when
 * `$TMUX` is UNSET — and every CommandMate agent runs inside a tmux pane, so
 * `$TMUX` is always set and always points at the user's real server. The
 * isolation was therefore inert: `createSession` ran against the live server,
 * all assertions passed against it, and `kill-server` then destroyed every
 * `mcbd-*` session on the machine, killing the running agents mid-task.
 *
 * Nothing caught it. The suite was green, and CI (no tmux installed) skipped the
 * file entirely, so the landmine only detonates on a developer machine. That
 * asymmetry is why this guard is a test rather than a review checklist.
 *
 * On 2026-09-08 it happened again — 42 sessions this time — and *not* from a
 * test. It came from an ad-hoc Bash block written while following a UAT plan:
 * `TMUX_TMPDIR` was set, then `tmux kill-server` ran with no socket. The guard
 * was watching `tests/**` only, so the recipes agents actually read — the
 * markdown under `docs/`, the skills and commands under `.claude/`, the helper
 * scripts under `scripts/` — were never examined. Issue #2442 widens the scan to
 * all of them (see {@link SCAN_ROOTS}) and replaces the proximity window with a
 * per-invocation judgement (see {@link segmentStart}).
 *
 * ## The rules
 *
 * 1. `kill-server` must be pinned to a private socket with `-L` / `-S`. Those
 *    flags outrank `$TMUX` (measured on tmux 3.5a: with `TMUX` pointing at
 *    server A, `tmux -L B ls` lists B). `kill-session -t '=name:'` is exempt —
 *    it is exact-match and destroys only what it names, which is why it is the
 *    teardown idiom the design docs recommend. Note that Claude's generated
 *    `permissions.deny` (Issue #2442, `PERMISSION_DENY_RULES`) refuses even that
 *    spelling when it carries no socket, so an *agent-facing* recipe has to pin
 *    it anyway.
 * 2. `bind-key` / `unbind-key` / `set-option -g` mutate SERVER-GLOBAL state that
 *    outlives the run and is shared with every session on that server, so they
 *    carry the same pinning requirement.
 * 3. `TMUX_TMPDIR` must not be used at all. It reads as isolation and is not.
 *    Redirect production code — which takes no socket argument — by pointing
 *    `process.env.TMUX` at the private server instead, and assert that the
 *    redirect held.
 *
 * ## What this guard does not claim
 *
 * It reads the repository's own tracked, reproducible material. A Bash block an
 * agent composes in the moment, `dev-reports/` (gitignored), `/tmp`, and
 * anything reached through a symlink are outside it. `env-clean` (#1740) is the
 * after-the-fact detector for what this cannot see in advance.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** This file names the forbidden tokens in order to search for them. */
const SELF = path.relative(REPO_ROOT, __filename);

// =============================================================================
// What gets scanned
// =============================================================================

/** Source files whose text *is* the command that runs. */
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
/** Shell scripts. Extensionless files are picked up by their shebang instead. */
const SHELL_EXTENSIONS = ['.sh', '.bash', '.zsh'];

/**
 * Directories and files that carry runnable material, and which kinds of file to
 * read in each.
 *
 * Pinned by a test below, because the 2026-09-08 wipe was not a coverage failure
 * of the *rules* — it was a recipe living one directory outside the scan. The
 * three roots that did not exist in the `tests/`-only version are the ones an
 * agent reads before acting: `docs/` (UAT plans, design records),
 * `.claude/` + `.agents/` (skills and slash commands), and `scripts/`.
 *
 * `src/` is deliberately absent. Production tmux calls build their argv from
 * config (`src/lib/tmux/tmux.ts` takes the socket from the session record), so a
 * literal `-L` next to the subcommand is not the shape they have, and requiring
 * one would only teach people to add a comment to satisfy a grep.
 */
export const SCAN_ROOTS: ReadonlyArray<{
  readonly root: string;
  readonly extensions: readonly string[];
}> = [
  // The original scope. Kept exactly as it was so the #1624 guard cannot regress.
  { root: 'tests', extensions: ['.ts', '.tsx'] },
  { root: 'scripts', extensions: [...CODE_EXTENSIONS, ...SHELL_EXTENSIONS, '.md'] },
  { root: 'docs', extensions: ['.md'] },
  { root: '.claude/skills', extensions: [...CODE_EXTENSIONS, ...SHELL_EXTENSIONS, '.md'] },
  { root: '.claude/commands', extensions: [...CODE_EXTENSIONS, ...SHELL_EXTENSIONS, '.md'] },
  // Other agents' copies of the same recipes (Codex reads `.agents/`; `.codex/`
  // does not exist today and is listed so that adding it is covered on arrival).
  { root: '.agents/skills', extensions: [...CODE_EXTENSIONS, ...SHELL_EXTENSIONS, '.md'] },
  { root: '.codex', extensions: [...CODE_EXTENSIONS, ...SHELL_EXTENSIONS, '.md'] },
  // Repository-level agent instructions.
  { root: 'AGENTS.md', extensions: ['.md'] },
  { root: 'CLAUDE.md', extensions: ['.md'] },
];

/** Directory names never descended into. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'coverage']);

/**
 * Markdown fence languages treated as "somebody will paste this into a shell".
 *
 * The empty string is in the list on purpose: an untagged fence is this
 * repository's most common way of writing a command, and leaving it out would
 * make the scan trivially avoidable by deleting a language tag.
 */
export const SHELL_FENCE_LANGS: readonly string[] = ['', 'sh', 'bash', 'zsh', 'shell', 'console'];

/** Markdown fence languages read with the source-code rules. */
export const CODE_FENCE_LANGS: readonly string[] = [
  'ts',
  'tsx',
  'typescript',
  'js',
  'jsx',
  'javascript',
  'mjs',
  'cjs',
];

/**
 * Everything else — `json`, `jsonc`, `yaml`, `text`, `log`, `diff`, `mermaid` — is
 * data, not a command. That distinction is load-bearing: the deny rules of Issue
 * #2442 are literally the strings this guard hunts for, and
 * `docs/design/agent-hooks-permission-deny-verification.md` has to be able to
 * quote them, and quote the debug log that echoes them back, without being read
 * as an instruction to run them.
 */
function fenceKind(lang: string): 'shell' | 'code' | null {
  const normalized = lang.trim().toLowerCase();
  if (SHELL_FENCE_LANGS.includes(normalized)) return 'shell';
  if (CODE_FENCE_LANGS.includes(normalized)) return 'code';
  return null;
}

// =============================================================================
// Tokens
// =============================================================================

/**
 * Spellings that destroy or globally mutate whichever server they reach.
 *
 * Matched at a token boundary, so `bind-key` does not also fire inside
 * `unbind-key` — the two are listed separately and each is counted once.
 */
export const KILL_SERVER_TOKENS: readonly string[] = ['kill-server'];
export const SERVER_GLOBAL_TOKENS: readonly string[] = [
  'bind-key',
  'unbind-key',
  'set-option -g',
  // The argv spellings, in both quote styles: `['set-option', '-g', …]`.
  "'set-option', '-g'",
  '"set-option", "-g"',
];
/** Reads as isolation, is inert whenever `$TMUX` is set (which is always, here). */
export const FAKE_ISOLATION_TOKEN = 'TMUX_TMPDIR';

/**
 * `-L` / `-S` as a standalone argv token carrying a value.
 *
 * The value requirement is what stops `-L` at the very end of a segment (a
 * truncated edit, or the flag named in passing) from counting as a pin. In argv
 * form the value arrives after a comma, hence the second alternative.
 */
const PINNED = /(^|[^A-Za-z0-9-])-[LS](\s+\S|\s*,\s*\S|=\S|['"]?\s*,)/;

/** `tmux` as a whole word — not `tmuxctl`, not `TMUX_TMPDIR`. */
const TMUX_WORD = /(^|[^A-Za-z0-9_$])tmux(?![A-Za-z0-9_$])/g;

// =============================================================================
// Narrow, reasoned exemptions
// =============================================================================

/**
 * Files whose *job* is to name these words, with the exact number of occurrences
 * that job needs.
 *
 * Counted rather than merely listed. A blanket per-file exemption would mean a
 * real violation added to `tmux-private.ts` — the one file in the repository that
 * exists to make `kill-server` unreachable — would be the one violation nobody
 * ever sees. With a count, an eleventh occurrence fails and has to be argued for.
 *
 * Neither entry is a directory exclusion and neither switches a rule off; both
 * name a file, a token and a reason.
 */
export const EXEMPTIONS: ReadonlyArray<{
  readonly file: string;
  /** A single token, or `'*'` together with `occurrences: 'all'`. */
  readonly token: string;
  /**
   * The exact number of occurrences that file's job needs, or `'all'` for a file
   * that only ever names these words as *data*.
   *
   * `'all'` is not a promise, it is a claim that gets checked: the test below
   * refuses it for any file that can reach a shell at all (`child_process`,
   * `execFile`, `spawn`, `exec(`). A table-driven negative-example suite passes
   * that check by construction, which is what makes "these strings cannot run"
   * true rather than merely asserted — and it is why a count would be the wrong
   * tool there: every new table row would fail the guard.
   */
  readonly occurrences: number | 'all';
  readonly reason: string;
}> = [
  {
    file: 'tests/unit/hooks/hook-settings-generator-tmux-deny-2442.test.ts',
    token: '*',
    occurrences: 'all',
    reason:
      'the negative-example table for the deny rules: every spelling is a string handed to a ' +
      'string matcher, and the file reaches no shell (asserted below)',
  },
  {
    file: 'scripts/canary/tmux-private.ts',
    token: 'kill-server',
    occurrences: 2,
    reason:
      'the wrapper that makes kill-server unreachable without -L: one exported constant it ' +
      'compares against, one operator-facing error message',
  },
  {
    file: 'scripts/canary/tmux-private.ts',
    token: 'bind-key',
    occurrences: 1,
    reason: 'FORBIDDEN_TMUX_COMMANDS — the reject list this wrapper enforces',
  },
  {
    file: 'scripts/canary/tmux-private.ts',
    token: 'unbind-key',
    occurrences: 1,
    reason: 'FORBIDDEN_TMUX_COMMANDS — the reject list this wrapper enforces',
  },
  {
    file: 'scripts/canary/isolated-home.ts',
    token: FAKE_ISOLATION_TOKEN,
    occurrences: 1,
    reason:
      'STRIPPED_ENV_VARS deletes it from the child environment; naming it here is the opposite ' +
      'of relying on it',
  },
];

// =============================================================================
// Comment stripping
// =============================================================================

/**
 * Characters after which a `/` starts a regular expression rather than a division.
 *
 * Needed because `escapeHtml` in `.claude/skills/demo-video/scripts/terminal-scene.ts`
 * contains `.replace(/\"/g, …)`. Reading that `\"` as the start of a string left the
 * stripper inside an unterminated quote for the next 330 lines, so every comment
 * below it was scanned as code — which is how a JSDoc line reading "never
 * `kill-server`" was reported as a violation. A stripper that mis-tracks state is
 * worse than none: it produces both false positives and, on the other side of
 * the same bug, false negatives.
 */
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~',
  '^', '\n',
]);

/** Keywords a regular expression may directly follow. */
const REGEX_KEYWORDS = /(?:^|[^A-Za-z0-9_$])(return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await)$/;

function startsRegex(source: string, slash: number): boolean {
  let k = slash - 1;
  while (k >= 0 && /[ \t]/.test(source[k])) k -= 1;
  if (k < 0) return true;
  if (REGEX_PRECEDERS.has(source[k])) return true;
  return REGEX_KEYWORDS.test(source.slice(0, k + 1));
}

/**
 * Strips `//` and block comments while respecting string, template and regular
 * expression literals, so a `//` inside a URL cannot swallow the rest of a line.
 * Replaces stripped text with spaces to keep offsets stable for line reporting.
 *
 * Regex literals are kept verbatim rather than blanked — they are consumed as one
 * unit only so their contents cannot toggle quote state. Blanking them would make
 * `/kill-server/` a place to hide one.
 */
export function stripCodeComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  let quote: string | undefined;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out.push(ch);
      if (ch === '\\') {
        out.push(next ?? '');
        i += 2;
        continue;
      }
      if (ch === quote) quote = undefined;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out.push(source[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      out.push('  ');
      i += 2;
      continue;
    }
    if (ch === '/' && startsRegex(source, i)) {
      out.push(ch);
      i += 1;
      let charClass = false;
      while (i < source.length && source[i] !== '\n') {
        const c = source[i];
        out.push(c);
        i += 1;
        if (c === '\\') {
          out.push(source[i] ?? '');
          i += 1;
          continue;
        }
        if (c === '[') charClass = true;
        else if (c === ']') charClass = false;
        else if (c === '/' && !charClass) break;
      }
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/**
 * Strips shell `#` comments outside single/double quotes.
 *
 * `#` mid-word (`'=name:'`, `#{session_name}`, a URL fragment) is not a comment,
 * so a comment only starts at the beginning of a line or after whitespace.
 */
export function stripShellComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  let quote: string | undefined;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      out.push(ch);
      if (ch === '\\' && quote === '"') {
        out.push(source[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === quote) quote = undefined;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out.push(ch);
      i += 1;
      continue;
    }
    const atWordStart = i === 0 || /\s/.test(source[i - 1]);
    if (ch === '#' && atWordStart) {
      while (i < source.length && source[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

// =============================================================================
// Per-invocation pinning
// =============================================================================

/**
 * Where the invocation containing `index` begins.
 *
 * This replaces the ±120-character proximity window the `tests/`-only guard used.
 * A window cannot tell `tmux -L probe ls && tmux kill-server` (two commands, the
 * second unpinned) from `tmux -L probe kill-server` (one, pinned) — and the first
 * is precisely the shape a recipe drifts into. Boundaries:
 *
 *  - shell operators `;` `&&` `||` `|` `&` and command substitution `$( )` / backticks,
 *  - a newline, but only at bracket depth 0 and only when it is not a `\`
 *    continuation — so a formatter that splits `execFile('tmux', ['-L', sock,
 *    'kill-server'])` across lines does not turn one call into three.
 */
export function segmentStart(source: string, index: number): number {
  let start = 0;
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    const ch = source[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
      if (ch === ')') start = i + 1;
    } else if (ch === ';' || ch === '&' || ch === '|' || ch === '`') {
      start = i + 1;
    } else if (ch === '\n') {
      if (depth === 0 && source[i - 1] !== '\\') start = i + 1;
    }
  }
  return start;
}

interface Violation {
  file: string;
  line: number;
  token: string;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** A stretch of text that will be executed, and where it sits in its file. */
export interface ScanUnit {
  file: string;
  /** 1-based line in the file of this unit's first line. */
  startLine: number;
  /** Comment-stripped text. */
  source: string;
}

/** Executable fences in a markdown document, comment-stripped per language. */
export function markdownUnits(file: string, raw: string): ScanUnit[] {
  const lines = raw.split('\n');
  const units: ScanUnit[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)/.exec(lines[i]);
    if (!open) {
      i += 1;
      continue;
    }
    const marker = open[1];
    const closer = new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closer.test(lines[j])) {
      body.push(lines[j]);
      j += 1;
    }
    const kind = fenceKind(open[2] ?? '');
    if (kind) {
      const text = body.join('\n');
      units.push({
        file,
        startLine: i + 2,
        source: kind === 'shell' ? stripShellComments(text) : stripCodeComments(text),
      });
    }
    i = j + 1;
  }
  return units;
}

function unitsForFile(root: string, rel: string): ScanUnit[] {
  const raw = fs.readFileSync(path.join(root, rel), 'utf-8');
  if (rel.endsWith('.md')) return markdownUnits(rel, raw);
  const shell = SHELL_EXTENSIONS.some((ext) => rel.endsWith(ext)) || /^#!.*\b(sh|bash|zsh)\b/.test(raw);
  return [
    { file: rel, startLine: 1, source: shell ? stripShellComments(raw) : stripCodeComments(raw) },
  ];
}

/**
 * Collect every executable unit under `root`.
 *
 * Symlinks are never followed: a link out of the tree would make the scan depend
 * on what happens to be mounted, and the guard is about reproducible repository
 * material.
 */
export function collectUnits(root: string, targets = SCAN_ROOTS): ScanUnit[] {
  const units: ScanUnit[] = [];
  for (const target of targets) {
    const absolute = path.join(root, target.root);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) continue;

    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          visit(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = path.relative(root, full);
        if (rel === SELF) continue;
        const matches =
          target.extensions.some((ext) => entry.name.endsWith(ext)) ||
          (!entry.name.includes('.') && target.extensions.includes('.sh'));
        if (matches) units.push(...unitsForFile(root, rel));
      }
    };

    if (stat.isDirectory()) visit(absolute);
    else units.push(...unitsForFile(root, path.relative(root, absolute)));
  }
  return units;
}

/**
 * The part of `segment` in which a pin would belong to *this* tmux call.
 *
 * When the segment names `tmux` as a word, only what follows the last such word
 * counts: `ssh -L 8080:localhost:80 host tmux kill-server` carries a `-L`, and it
 * is the tunnel's, not the tmux server's. When there is no `tmux` word the call
 * goes through a wrapper (`run(['-L', socket, 'kill-server'])`) and the whole
 * segment is the argv.
 */
function pinScope(segment: string): string {
  TMUX_WORD.lastIndex = 0;
  let last = -1;
  for (let match = TMUX_WORD.exec(segment); match; match = TMUX_WORD.exec(segment)) {
    last = match.index + match[0].length;
  }
  return last === -1 ? segment : segment.slice(last);
}

/** Occurrences of `token` whose own invocation names no socket. */
export function unpinnedIn(unit: ScanUnit, token: string): number[] {
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const idx = unit.source.indexOf(token, from);
    if (idx === -1) break;
    from = idx + token.length;
    // Token boundary: `bind-key` must not fire inside `unbind-key`.
    if (idx > 0 && /[A-Za-z0-9_-]/.test(unit.source[idx - 1])) continue;
    const segment = unit.source.slice(segmentStart(unit.source, idx), idx);
    if (!PINNED.test(pinScope(segment))) hits.push(idx);
  }
  return hits;
}

/** Violations of `tokens`, with the exemption table applied. */
export function scanUnits(units: readonly ScanUnit[], tokens: readonly string[]): Violation[] {
  const counted = new Map<string, number>();
  const raw: Violation[] = [];
  for (const unit of units) {
    for (const token of tokens) {
      for (const idx of unpinnedIn(unit, token)) {
        raw.push({
          file: unit.file,
          line: unit.startLine - 1 + lineOf(unit.source, idx),
          token,
        });
        const key = `${unit.file} ${token}`;
        counted.set(key, (counted.get(key) ?? 0) + 1);
      }
    }
  }

  const unlimited = new Set(
    EXEMPTIONS.filter((entry) => entry.occurrences === 'all').map((entry) =>
      entry.token === '*' ? entry.file : `${entry.file} ${entry.token}`
    )
  );
  const budget = new Map<string, number>();
  for (const entry of EXEMPTIONS) {
    if (typeof entry.occurrences === 'number') {
      budget.set(`${entry.file} ${entry.token}`, entry.occurrences);
    }
  }
  return raw.filter((violation) => {
    if (unlimited.has(violation.file)) return false;
    const key = `${violation.file} ${violation.token}`;
    if (unlimited.has(key)) return false;
    const left = budget.get(key);
    if (left === undefined || left <= 0) return true;
    budget.set(key, left - 1);
    return false;
  });
}

const repoUnits = collectUnits(REPO_ROOT);

function scan(tokens: readonly string[]): Violation[] {
  return scanUnits(repoUnits, tokens);
}

// =============================================================================
// Fixture helper for the scanner's own tests
// =============================================================================

/** Writes `files` into a throwaway tree and returns its units. */
function fixtureUnits(
  files: Record<string, string>,
  targets: typeof SCAN_ROOTS = SCAN_ROOTS
): ScanUnit[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-safety-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return collectUnits(root, targets);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Every negative example below is a STRING handed to the scanner. None of it is
 * ever passed to a shell, and none of it names a real socket — which is the
 * safety condition Issue #2442 sets for testing this rule at all.
 */
const UNPINNED_KILL = 'tmux kill-server\n';

// =============================================================================
// The repository must be clean
// =============================================================================

describe('nothing in this repository reaches the ambient tmux server', () => {
  it('pins every kill-server to a private socket', () => {
    // The one command that cannot be undone: it takes down every session on the
    // server it reaches, including the agents running the test.
    expect(scan(KILL_SERVER_TOKENS)).toEqual([]);
  });

  it('pins every server-global tmux mutation to a private socket', () => {
    // These outlive the run. `bind-key` in particular writes the shared prefix
    // key table (Issue #1623 needs it), which every other session then inherits.
    expect(scan(SERVER_GLOBAL_TOKENS)).toEqual([]);
  });

  it('does not use TMUX_TMPDIR as an isolation mechanism', () => {
    // Inert whenever $TMUX is set, which is always true under CommandMate. The
    // working alternative is `-L` for the recipe's own calls plus a redirected
    // `process.env.TMUX` for production code that takes no socket argument.
    expect(scan([FAKE_ISOLATION_TOKEN])).toEqual([]);
  });

  it('actually read the directories it claims to cover', () => {
    // A scan that silently collected nothing would pass all three tests above.
    // Positive control: EVERY root that exists on disk contributed at least one
    // unit of its own. Matched by full root path rather than by first path
    // segment, so `.claude/skills` cannot vouch for `.claude/commands`.
    const present = SCAN_ROOTS.map((target) => target.root).filter((root) =>
      fs.existsSync(path.join(REPO_ROOT, root))
    );

    expect(present.length).toBeGreaterThanOrEqual(8);
    for (const root of present) {
      const prefix = root.split('/').join(path.sep);
      const contributed = repoUnits.some(
        (unit) => unit.file === prefix || unit.file.startsWith(prefix + path.sep)
      );
      expect(contributed, `${root} contributed no units`).toBe(true);
    }
    expect(repoUnits.length).toBeGreaterThan(1000);
  });

  it('keeps every counted exemption earning its place', () => {
    // An exemption whose occurrences have since been deleted is a licence nobody
    // is using; it has to go, or the count stops meaning anything.
    for (const entry of EXEMPTIONS) {
      if (typeof entry.occurrences !== 'number') continue;
      const units = repoUnits.filter((unit) => unit.file === entry.file);
      expect(units.length, `${entry.file} is no longer scanned`).toBeGreaterThan(0);
      const hits = units.reduce((sum, unit) => sum + unpinnedIn(unit, entry.token).length, 0);
      expect(hits, `${entry.file} / ${entry.token}: ${entry.reason}`).toBe(entry.occurrences);
    }
  });

  it('grants an uncounted exemption only to a file that cannot reach a shell', () => {
    // The check that turns `occurrences: 'all'` from a licence into a claim. A file
    // that can reach a shell could run the strings it names, and has to be counted
    // like every other file instead. `child_process` is the load-bearing entry —
    // every other route to a shell in this repository imports it — and the API
    // names are listed alongside it so a re-exporting helper is still caught by
    // name. It reads the file's own text, so the exemption remains one reviewed
    // line in a table rather than something a file can grant itself.
    const SHELL_REACH = [
      'child_process',
      'execFile(',
      'execFileSync',
      'execSync',
      'spawn(',
      'spawnSync',
      'Bun.$',
    ];
    const uncounted = EXEMPTIONS.filter((entry) => entry.occurrences === 'all');

    expect(uncounted.length).toBeGreaterThan(0);
    for (const entry of uncounted) {
      const source = fs.readFileSync(path.join(REPO_ROOT, entry.file), 'utf-8');
      for (const api of SHELL_REACH) {
        expect(source.includes(api), `${entry.file} names ${api}; count it instead`).toBe(false);
      }
      // Non-vacuous: the file really does carry the words it is excused for.
      expect(
        [...KILL_SERVER_TOKENS, ...SERVER_GLOBAL_TOKENS].some((token) => source.includes(token)),
        `${entry.file} no longer needs its exemption`
      ).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});

// =============================================================================
// The scanner's own behaviour
// =============================================================================

describe('the scanner catches each kind of target', () => {
  it('reports a shell script violation with file and line', () => {
    const units = fixtureUnits({
      'scripts/teardown.sh': ['#!/usr/bin/env bash', 'set -euo pipefail', UNPINNED_KILL].join('\n'),
    });

    expect(scanUnits(units, KILL_SERVER_TOKENS)).toEqual([
      { file: path.join('scripts', 'teardown.sh'), line: 3, token: 'kill-server' },
    ]);
  });

  it('reports an extensionless shebang script', () => {
    const units = fixtureUnits({
      'scripts/teardown': `#!/bin/sh\n${UNPINNED_KILL}`,
    });

    expect(scanUnits(units, KILL_SERVER_TOKENS)).toEqual([
      { file: path.join('scripts', 'teardown'), line: 2, token: 'kill-server' },
    ]);
  });

  it('reports a TS/JS violation', () => {
    const units = fixtureUnits({
      'scripts/probe.ts': `await execFileAsync('tmux', ['kill-server']);\n`,
    });

    expect(scanUnits(units, KILL_SERVER_TOKENS)).toEqual([
      { file: path.join('scripts', 'probe.ts'), line: 1, token: 'kill-server' },
    ]);
  });

  it('reports a markdown shell fence, at the line inside the document', () => {
    const units = fixtureUnits({
      'docs/uat.md': ['# Plan', '', 'Tear the probe down:', '', '```bash', UNPINNED_KILL, '```'].join(
        '\n'
      ),
    });

    expect(scanUnits(units, KILL_SERVER_TOKENS)).toEqual([
      { file: path.join('docs', 'uat.md'), line: 6, token: 'kill-server' },
    ]);
  });

  it('reports an untagged markdown fence', () => {
    // Deleting the language tag must not be a way out of the scan.
    const units = fixtureUnits({
      'docs/uat.md': ['```', UNPINNED_KILL, '```'].join('\n'),
    });

    expect(scanUnits(units, KILL_SERVER_TOKENS)).toHaveLength(1);
  });

  it.each([
    ['.claude/commands/orchestrate.md'],
    ['.claude/skills/probe/SKILL.md'],
    ['.agents/skills/probe/SKILL.md'],
    ['.codex/recipes.md'],
    ['AGENTS.md'],
    ['CLAUDE.md'],
  ])('reports a violation in %s', (rel) => {
    const units = fixtureUnits({ [rel]: ['```sh', UNPINNED_KILL, '```'].join('\n') });

    expect(scanUnits(units, KILL_SERVER_TOKENS)).toHaveLength(1);
  });

  it('reports the server-global mutations in every spelling', () => {
    const units = fixtureUnits({
      'scripts/opts.sh': 'tmux set-option -g history-limit 200000\ntmux bind-key -T root q detach\n',
      'scripts/opts.ts':
        "await run(['set-option', '-g', 'status', 'off']);\nawait run(['unbind-key', '-a']);\n",
    });

    expect(scanUnits(units, SERVER_GLOBAL_TOKENS).map((v) => v.token).sort()).toEqual([
      "'set-option', '-g'",
      'bind-key',
      'set-option -g',
      'unbind-key',
    ]);
    // `bind-key` fired once, not twice: `unbind-key` on the next line is its own
    // token, and the boundary check keeps the two from being counted together.
    expect(scanUnits(units, ['bind-key'])).toHaveLength(1);
  });

  it('reports TMUX_TMPDIR in a recipe', () => {
    const units = fixtureUnits({
      'docs/probe.md': ['```bash', 'export TMUX_TMPDIR=/tmp/probe', 'tmux new-session -d', '```'].join(
        '\n'
      ),
    });

    expect(scanUnits(units, [FAKE_ISOLATION_TOKEN])).toEqual([
      { file: path.join('docs', 'probe.md'), line: 2, token: FAKE_ISOLATION_TOKEN },
    ]);
  });
});

describe('the scanner accepts what is actually safe', () => {
  it('passes a socket-pinned call in every form', () => {
    const units = fixtureUnits({
      'scripts/safe.sh': [
        'tmux -L cmate-probe kill-server',
        'tmux -S "$SOCK" kill-server',
        'tmux -L cmate-probe \\',
        '  set-option -g history-limit 200000',
      ].join('\n'),
      'scripts/safe.ts': [
        "await execFileAsync('tmux', ['-L', socket, 'kill-server']);",
        'await execFileAsync(\'tmux\', [',
        "  '-L',",
        '  socket,',
        "  'set-option', '-g', 'status', 'off',",
        ']);',
      ].join('\n'),
    });

    expect(scanUnits(units, [...KILL_SERVER_TOKENS, ...SERVER_GLOBAL_TOKENS])).toEqual([]);
  });

  it('passes the exact-match kill-session teardown idiom', () => {
    // Rule 1's exemption: `-t '=name:'` destroys only the session it names, which
    // is why the design docs recommend it over kill-server. It is not in the
    // token list at all — this test states that on purpose, so nobody "tightens"
    // the guard by adding it and breaks every teardown recipe in `docs/`.
    const units = fixtureUnits({
      'docs/teardown.md': ["```bash", "tmux kill-session -t '=cmate-probe:'", '```'].join('\n'),
    });

    expect(
      scanUnits(units, [...KILL_SERVER_TOKENS, ...SERVER_GLOBAL_TOKENS, FAKE_ISOLATION_TOKEN])
    ).toEqual([]);
  });

  it('passes a session-scoped set-option', () => {
    // `-t` touches one session, not the server. Only `-g` outlives the run.
    const units = fixtureUnits({
      'scripts/scoped.ts': "await run(['set-option', '-t', target, 'history-limit', '200000']);\n",
    });

    expect(scanUnits(units, SERVER_GLOBAL_TOKENS)).toEqual([]);
  });

  it('does not read prose, inline code, or data fences as commands', () => {
    // The deny rules of #2442 are the very strings this guard hunts for, so the
    // document that records them has to be able to quote them and quote the debug
    // log that echoes them back.
    const units = fixtureUnits({
      'docs/deny.md': [
        'A bare `tmux kill-server` destroyed 42 sessions; never write one.',
        '',
        'Setting TMUX_TMPDIR first reads as isolation and is not.',
        '',
        '```jsonc',
        '"deny": ["Bash(tmux kill-server:*)", "Bash(tmux unbind-key:*)"]',
        '```',
        '',
        '```text',
        '[DEBUG] Adding 8 deny rule(s): ["Bash(tmux set-option -g:*)"]',
        '```',
        '',
        '```yaml',
        'teardown: tmux kill-server',
        '```',
      ].join('\n'),
    });

    expect(
      scanUnits(units, [...KILL_SERVER_TOKENS, ...SERVER_GLOBAL_TOKENS, FAKE_ISOLATION_TOKEN])
    ).toEqual([]);
  });

  it('does not read a comment as a command', () => {
    const units = fixtureUnits({
      'scripts/notes.sh': "# never run a bare tmux kill-server; use kill-session -t '=x:'\n",
      'scripts/notes.ts': [
        '/** Exact-match kill, never `kill-server`: TMUX_TMPDIR would not isolate this. */',
        '// bind-key writes the shared table; set-option -g outlives the run.',
        'export const NOTE = 1;',
      ].join('\n'),
    });

    expect(
      scanUnits(units, [...KILL_SERVER_TOKENS, ...SERVER_GLOBAL_TOKENS, FAKE_ISOLATION_TOKEN])
    ).toEqual([]);
  });

  it('still sees a violation whose line also carries a comment', () => {
    // Comment stripping must not become a hiding place: the code half of the line
    // is still code. This is the mutation control for the test above.
    const units = fixtureUnits({
      'scripts/notes.sh': 'tmux kill-server  # tearing down the probe\n',
    });

    expect(scanUnits(units, KILL_SERVER_TOKENS)).toHaveLength(1);
  });
});

describe('a nearby -L never launders an unpinned call', () => {
  it.each([
    [
      'a pinned command earlier on the same line',
      'scripts/near.sh',
      'tmux -L cmate-probe list-sessions && tmux kill-server\n',
    ],
    [
      'a pinned command on the line above',
      'scripts/near.sh',
      'tmux -L cmate-probe new-session -d -s probe\ntmux kill-server\n',
    ],
    ['a pinned command after a semicolon', 'scripts/near.sh', 'tmux kill-server; tmux -L p ls\n'],
    ['a pinned command in a pipeline', 'scripts/near.sh', 'tmux kill-server | tee -L /dev/null\n'],
    [
      'a pinned sibling call in the same statement list',
      'scripts/near.ts',
      "await run(['-L', socket, 'ls']);\nawait run(['kill-server']);\n",
    ],
    [
      'a -L belonging to a different program',
      'scripts/near.sh',
      'ssh -L 8080:localhost:80 host tmux kill-server\n',
    ],
    [
      'a -L with no value at the end of the segment',
      'scripts/near.sh',
      'tmux -L\ntmux kill-server\n',
    ],
    [
      'the flag named only in a markdown sentence above the fence',
      'docs/near.md',
      ['Pin it with `-L cmate-probe` first.', '', '```bash', UNPINNED_KILL, '```'].join('\n'),
    ],
  ])('fails despite %s', (_label, file, content) => {
    const units = fixtureUnits({ [file]: content });

    expect(scanUnits(units, KILL_SERVER_TOKENS)).toHaveLength(1);
  });
});

describe('the exemption table cannot be widened by accident', () => {
  it('spends the exemption on the file it names and nowhere else', () => {
    const units = fixtureUnits({
      // Same token, a different file: no budget, so it fails.
      'scripts/canary/other.ts': "export const TEARDOWN = 'kill-server';\n",
    });

    expect(scanUnits(units, KILL_SERVER_TOKENS)).toEqual([
      { file: path.join('scripts', 'canary', 'other.ts'), line: 1, token: 'kill-server' },
    ]);
  });

  it('reports the occurrence beyond an exemption budget', () => {
    const exempted = EXEMPTIONS.find(
      (entry) => entry.file === 'scripts/canary/tmux-private.ts' && entry.token === 'kill-server'
    );
    const budget = typeof exempted?.occurrences === 'number' ? exempted.occurrences : 0;
    expect(budget).toBeGreaterThan(0);
    const units = fixtureUnits({
      'scripts/canary/tmux-private.ts': Array.from(
        { length: budget + 1 },
        (_, index) => `export const T${index} = 'kill-server';`
      ).join('\n'),
    });

    // Exactly one over budget, reported at the line that overflowed it.
    expect(scanUnits(units, KILL_SERVER_TOKENS)).toEqual([
      {
        file: path.join('scripts', 'canary', 'tmux-private.ts'),
        line: budget + 1,
        token: 'kill-server',
      },
    ]);
  });
});

describe('the scan targets are a fixed, reviewable list', () => {
  it('names every root the 2026-09-08 wipe came from', () => {
    // The recipe that wiped 42 sessions lived in a UAT plan under `docs/`. Pinned
    // so widening the guard is a deliberate edit and narrowing it is a failing
    // test.
    expect(SCAN_ROOTS.map((target) => target.root)).toEqual([
      'tests',
      'scripts',
      'docs',
      '.claude/skills',
      '.claude/commands',
      '.agents/skills',
      '.codex',
      'AGENTS.md',
      'CLAUDE.md',
    ]);
  });

  it('keeps the original tests/ scope exactly as it was', () => {
    expect(SCAN_ROOTS.find((target) => target.root === 'tests')?.extensions).toEqual([
      '.ts',
      '.tsx',
    ]);
  });

  it('treats untagged and shell fences as executable and data fences as data', () => {
    expect(SHELL_FENCE_LANGS).toContain('');
    for (const lang of ['sh', 'bash', 'zsh', 'shell', 'console']) {
      expect(fenceKind(lang)).toBe('shell');
    }
    for (const lang of ['ts', 'js', 'typescript']) {
      expect(fenceKind(lang)).toBe('code');
    }
    for (const lang of ['json', 'jsonc', 'yaml', 'yml', 'text', 'log', 'diff', 'mermaid', 'md']) {
      expect(fenceKind(lang)).toBeNull();
    }
  });

  it('never follows a symlink out of the tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-safety-link-'));
    try {
      const outside = path.join(root, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'evil.sh'), UNPINNED_KILL);
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.symlinkSync(outside, path.join(root, 'scripts', 'linked'));

      expect(scanUnits(collectUnits(root), KILL_SERVER_TOKENS)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
