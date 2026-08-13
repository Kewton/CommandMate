/**
 * No test may point an environment variable at a path inside a virtual
 * filesystem (Issue #1759 follow-up; PR #1773 postmortem).
 *
 * ## What happened
 *
 * One line in `tests/unit/session/agent-session-lifecycle-1759.test.ts` set
 * `CM_AGENT_HOOKS_DIR` to a path under `/proc` in order to get "a directory
 * that cannot be written". The product code it reached calls
 * `mkdirSync(dir, { recursive: true })`.
 *
 * - **macOS**: `/proc` does not exist, the call throws at once, the fail-open
 *   path runs, the test is green. The bug is *unreproducible locally by
 *   construction*.
 * - **Linux**: `/proc` does exist, and procfs answers a mkdir for a child that
 *   cannot exist with **ENOENT rather than EPERM**. Node's recursive mkdir
 *   reads ENOENT as "the parent is missing", so it creates the parent and
 *   retries — forever, inside C++. Measured in a container: no return after
 *   25s, 100.4% CPU, memory flat at 12.66MiB.
 *
 * Because the spin is synchronous the event loop never turns, so **vitest's own
 * testTimeout cannot fire**. There is no OOM either. The job simply goes
 * silent: PR #1773's Unit Tests ran **5h31m** with the last log line being the
 * case before this one, byte-identical across both attempts.
 *
 * ## Why a guard rather than a fix and a comment
 *
 * Four workers (#1760 / #1761 / #1762 / #1763) are about to copy that file as
 * the template for their own tool. A comment in one file does not survive being
 * used as a template; a red test does.
 *
 * ## What is and is not flagged
 *
 * Only **assigning** such a path to an environment variable. Naming one of these
 * paths as data — comparing against it, listing it, passing it in an env map to
 * a subprocess — is fine and is what `tests/unit/config/system-directories.test.ts`,
 * `tests/unit/db-migration-path.test.ts` and `tests/unit/lib/skills/git-workflow.test.ts`
 * legitimately do. None of those touch the real filesystem.
 *
 * The way to write "a directory that cannot be written" is a path whose parent
 * is a regular file. A regular file cannot have children, so a recursive mkdir
 * fails with ENOTDIR immediately on every OS (measured: macOS/node 24 0ms,
 * Linux/node 18 1ms).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';

const TESTS_ROOT = join(process.cwd(), 'tests');

/** Extensions worth reading. Fixtures and snapshots cannot assign env vars. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Virtual filesystems whose mkdir semantics differ from a real one.
 *
 * `/proc` is the measured offender. `/sys` and `/dev` are here because they are
 * the same kind of thing — kernel-backed namespaces whose error codes are not
 * the ones `fs` callers assume — and because the next person reaching for "a
 * path that surely cannot be created" will reach for one of the three.
 */
const VIRTUAL_ROOTS = ['proc', 'sys', 'dev'];

/**
 * Terminal device nodes that are safe to name as an env value.
 *
 * `/dev/null` is a standard idiom (`GIT_CONFIG_GLOBAL=/dev/null` already appears
 * in this repo, in env maps handed to git). It is a character device, not a
 * directory, so a recursive mkdir under it fails with ENOTDIR at once — the
 * behaviour this guard is protecting, not the one it is banning. Anything
 * *below* one of these is still flagged.
 */
const ALLOWED_EXACT_PATHS = ['/dev/null', '/dev/zero', '/dev/stdin', '/dev/stdout', '/dev/stderr'];

/**
 * An env-var assignment whose value is a literal path under a virtual root.
 *
 * Matches `process.env.NAME`, `process.env['NAME']` and `vi.stubEnv('NAME', …)`.
 * `=(?!=)` keeps comparisons (`===`, `==`) out; `??=` and `||=` are assignments
 * and are included.
 */
const PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`process\.env(?:\.[A-Za-z_$][\w$]*|\[\s*['"\`][^'"\`]+['"\`]\s*\])` +
      String.raw`\s*(?:\?\?|\|\||&&)?=(?!=)\s*['"\`](/(?:${VIRTUAL_ROOTS.join('|')})(?:/[^'"\`]*)?)['"\`]`,
    'g'
  ),
  new RegExp(
    String.raw`stubEnv\(\s*['"\`][^'"\`]+['"\`]\s*,\s*['"\`](/(?:${VIRTUAL_ROOTS.join('|')})(?:/[^'"\`]*)?)['"\`]`,
    'g'
  ),
];

export interface ProcfsEnvViolation {
  /** Path relative to the scanned root. */
  file: string;
  /** 1-indexed. */
  line: number;
  /** The offending path literal. */
  value: string;
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Find env-var assignments pointing into a virtual filesystem.
 *
 * @param root - Directory to walk
 * @returns One entry per offending assignment; empty when the tree is clean
 */
export function findProcfsEnvFixtures(root: string): ProcfsEnvViolation[] {
  const violations: ProcfsEnvViolation[] = [];

  for (const file of collectSourceFiles(root)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const pattern of PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          const value = match[1];
          if (ALLOWED_EXACT_PATHS.includes(value)) continue;
          violations.push({ file: relative(root, file), line: index + 1, value });
        }
      }
    });
  }

  return violations;
}

describe('no test points an env var into /proc, /sys or /dev', () => {
  it('finds nothing under tests/', () => {
    // The message matters as much as the assertion: whoever trips this is
    // reaching for "a path that cannot be created", and needs the alternative
    // in front of them rather than a bare list of line numbers.
    const violations = findProcfsEnvFixtures(TESTS_ROOT);

    expect(
      violations,
      violations.length === 0
        ? ''
        : `Environment variables must not be pointed at a virtual filesystem:\n` +
          violations.map((v) => `  ${v.file}:${v.line} → ${v.value}`).join('\n') +
          `\n\nOn Linux a recursive mkdir under /proc spins forever inside C++ ` +
          `(procfs returns ENOENT, which Node reads as "create the parent and retry"). ` +
          `The event loop stops, so vitest's timeout cannot fire — PR #1773 hung for 5h31m. ` +
          `It is green on macOS, where the path does not exist.\n` +
          `For "a directory that cannot be written", use a path whose parent is a regular file:\n` +
          `  const blocker = join(mkdtempSync(join(tmpdir(), 'x-')), 'not-a-dir');\n` +
          `  writeFileSync(blocker, '');\n` +
          `  process.env.SOME_DIR = join(blocker, 'child');   // ENOTDIR, immediately, everywhere`
    ).toEqual([]);
  });
});

describe('the guard is not vacuous', () => {
  /**
   * A scratch tree with one offending file.
   *
   * The offending line is assembled at runtime rather than written out, so this
   * file does not contain the very pattern it is scanning for — a guard that
   * has to exempt itself is a guard with a hole in it.
   */
  function withFixture(
    body: (root: string) => void,
    lines: readonly string[]
  ): void {
    const root = mkdtempSync(join(tmpdir(), 'procfs-guard-'));
    try {
      mkdirSync(join(root, 'unit'), { recursive: true });
      writeFileSync(join(root, 'unit', 'offender.test.ts'), `${lines.join('\n')}\n`);
      body(root);
    } finally {
      removeTempDir(root);
    }
  }

  const ENV_ASSIGN = 'process.env.' + 'SOME_DIR';
  const PROC_PATH = "'" + '/proc' + "/definitely-not-writable/cmate'";

  it('catches the exact line that hung PR #1773', () => {
    withFixture(
      (root) => {
        expect(findProcfsEnvFixtures(root)).toEqual([
          {
            file: join('unit', 'offender.test.ts'),
            line: 2,
            value: '/proc/definitely-not-writable/cmate',
          },
        ]);
      },
      ['it("x", () => {', `  ${ENV_ASSIGN} = ${PROC_PATH};`, '});']
    );
  });

  it('catches the bracket and stubEnv spellings, and /sys and /dev too', () => {
    withFixture(
      (root) => {
        expect(findProcfsEnvFixtures(root).map((v) => v.value)).toEqual([
          '/sys/nope',
          '/dev/null/below',
          '/proc/self/mem',
        ]);
      },
      [
        `process.env['A'] = ` + "'" + '/sys' + "/nope';",
        'process.env.B ' + '= ' + "'" + '/dev' + "/null/below';",
        `vi.stubEnv('C', ` + "'" + '/proc' + "/self/mem');",
      ]
    );
  });

  it('leaves the legitimate uses alone', () => {
    // These are the shapes `system-directories.test.ts`, `db-migration-path.test.ts`
    // and `git-workflow.test.ts` actually use. None of them touch the real fs,
    // and a guard that reddened them would be turned off within a day.
    withFixture(
      (root) => {
        expect(findProcfsEnvFixtures(root)).toEqual([]);
      },
      [
        `const expectedDirs = ['/etc', '/usr', ` + "'" + '/dev' + "', '" + '/sys' + "', '" + '/proc' + "'];",
        `const targetPath = ` + "'" + '/proc' + "/commandmate/cm.db';",
        `expect(isSystemDirectory(` + "'" + '/proc' + "/self/status')).toBe(true);",
        `const env = { GIT_CONFIG_GLOBAL: ` + "'" + '/dev' + "/null' };",
        `if (process.env.X === ` + "'" + '/proc' + "/x') return;",
      ]
    );
  });

  it('allows the terminal device nodes by exact match', () => {
    withFixture(
      (root) => {
        expect(findProcfsEnvFixtures(root)).toEqual([]);
      },
      ['process.env.GIT_CONFIG_GLOBAL ' + '= ' + "'" + '/dev' + "/null';"]
    );
  });

  it('reports every offending line, not just the first', () => {
    withFixture(
      (root) => {
        expect(findProcfsEnvFixtures(root).map((v) => v.line)).toEqual([1, 3]);
      },
      [
        `process.env.A ` + '= ' + "'" + '/proc' + "/a';",
        'const ok = 1;',
        `process.env.B ` + '= ' + "'" + '/proc' + "/b';",
      ]
    );
  });
});
