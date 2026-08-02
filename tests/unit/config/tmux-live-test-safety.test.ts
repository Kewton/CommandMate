/**
 * CI guard: a test must never be able to reach the ambient tmux server.
 *
 * ## The incident this exists to prevent
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
 * ## The rules
 *
 * 1. `kill-server` must be pinned to a private socket with `-L` / `-S`. Those
 *    flags outrank `$TMUX` (measured on tmux 3.5a: with `TMUX` pointing at
 *    server A, `tmux -L B ls` lists B). `kill-session -t '=name:'` is exempt —
 *    it is exact-match and destroys only what it names.
 * 2. `bind-key` / `unbind-key` / `set-option -g` mutate SERVER-GLOBAL state that
 *    outlives the test and is shared with every session on that server, so they
 *    carry the same pinning requirement.
 * 3. `TMUX_TMPDIR` must not be used at all. It reads as isolation and is not.
 *    Redirect production code — which takes no socket argument — by pointing
 *    `process.env.TMUX` at the private server instead, and assert that the
 *    redirect held.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');

/** This file names the forbidden tokens in order to search for them. */
const SELF = path.relative(REPO_ROOT, __filename);

/**
 * How far from a match to look for the pinning flag. Wide enough to survive a
 * formatter splitting the call across lines, narrow enough that the flag has to
 * belong to the same call.
 */
const PIN_WINDOW = 120;

/** `-L` / `-S` as standalone argv tokens, not as a prefix of a longer word. */
const PINNED = /(^|[^A-Za-z0-9-])-[LS]([^A-Za-z0-9-]|$)/;

/**
 * Strips comments while respecting string and template literals, so a `//`
 * inside a URL cannot swallow the rest of a line. Replaces stripped text with
 * spaces to keep offsets stable for line reporting.
 */
function stripComments(source: string): string {
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
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const rel = path.relative(REPO_ROOT, full);
        if (rel !== SELF) found.push(rel);
      }
    }
  };
  walk(TESTS_DIR);
  return found.sort();
}

interface Violation {
  file: string;
  line: number;
  token: string;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** Occurrences of `token` that have no `-L` / `-S` anywhere nearby. */
function unpinned(source: string, token: string): number[] {
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const idx = source.indexOf(token, from);
    if (idx === -1) break;
    from = idx + token.length;
    const window = source.slice(Math.max(0, idx - PIN_WINDOW), idx + PIN_WINDOW);
    if (!PINNED.test(window)) hits.push(idx);
  }
  return hits;
}

const sources = new Map(
  testFiles().map((rel) => [rel, stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'))]),
);

function scan(tokens: string[]): Violation[] {
  const violations: Violation[] = [];
  for (const [file, source] of sources) {
    for (const token of tokens) {
      for (const idx of unpinned(source, token)) {
        violations.push({ file, line: lineOf(source, idx), token });
      }
    }
  }
  return violations;
}

describe('tests must not be able to reach the ambient tmux server', () => {
  it('pins every kill-server to a private socket', () => {
    // The one command that cannot be undone: it takes down every session on the
    // server it reaches, including the agents running the test.
    expect(scan(['kill-server'])).toEqual([]);
  });

  it('pins every server-global tmux mutation to a private socket', () => {
    // These outlive the test. `bind-key` in particular writes the shared prefix
    // key table (Issue #1623 needs it), which every other session then inherits.
    expect(scan(['bind-key', 'set-option -g', "'set-option', '-g'"])).toEqual([]);
  });

  it('does not use TMUX_TMPDIR as an isolation mechanism', () => {
    // Inert whenever $TMUX is set, which is always true under CommandMate. The
    // working alternative is `-L` for the test's own calls plus a redirected
    // `process.env.TMUX` for production code that takes no socket argument.
    const offenders = [...sources]
      .filter(([, source]) => source.includes('TMUX_TMPDIR'))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
