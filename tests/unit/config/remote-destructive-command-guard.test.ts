/**
 * CI guard: `src/lib/remote/**` must never invoke a Provider-wide reset
 * (Issue #1937, design §6.3-3).
 *
 * ## What this prevents
 *
 * `tailscale serve reset` clears **every** Serve handler tailscaled holds, not
 * just the one CommandMate added. Serve config is persistent and the user may
 * already be publishing their own services through it. There is no undo and no
 * backup — one call and their configuration is gone.
 *
 * `cloudflared tunnel cleanup` is the same shape for tunnel connections.
 *
 * The supported teardown is `RemoteProvider.stop(handle)`, which reverts only
 * what is in `handle.owned` and not in `handle.preexisting`. These commands are
 * the exact opposite: they operate on "everything currently configured", which
 * is why the type deliberately cannot express them and why this test exists to
 * catch someone shelling out to them anyway.
 *
 * ## Why a test and not an ESLint rule
 *
 * §6.3-3 allows either. This repo is on ESLint 8 with `.eslintrc.json`; a
 * no-restricted-syntax selector there would only see the shapes it was written
 * for, while the string can arrive as a template literal, a joined argv array,
 * or a `spawn` argument list. Scanning the text catches all of those, and the
 * positive control below proves it does.
 *
 * ## Why the positive control is mandatory
 *
 * A scanner that finds nothing and a scanner that is broken produce the same
 * green. This repo has misread "grep returned 0" as "it is not there" more than
 * once. So every rule here is fired at synthesised source that *does* contain
 * the forbidden text, and the test fails if the scanner shrugs. The synthetic
 * input never touches a real file.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const REMOTE_DIR = path.join(REPO_ROOT, 'src/lib/remote');

/**
 * Commands that act on the Provider's entire configuration.
 *
 * Matched on the tokens with any run of separators between them, so a template
 * literal (`` `tailscale serve reset` ``), a spawn argv (`['serve', 'reset']`)
 * and a wrapped line all read as the same call.
 */
const FORBIDDEN: readonly { label: string; pattern: RegExp }[] = [
  {
    label: 'tailscale serve reset',
    pattern: /\bserve\b[^A-Za-z0-9]{1,40}\breset\b/i,
  },
  {
    label: 'tailscale funnel reset',
    pattern: /\bfunnel\b[^A-Za-z0-9]{1,40}\breset\b/i,
  },
  {
    label: 'cloudflared tunnel cleanup',
    pattern: /\btunnel\b[^A-Za-z0-9]{1,40}\bcleanup\b/i,
  },
  {
    label: 'cloudflared tunnel delete',
    pattern: /\btunnel\b[^A-Za-z0-9]{1,40}\bdelete\b/i,
  },
];

interface Violation {
  file: string;
  line: number;
  label: string;
  text: string;
}

/**
 * The checker under test.
 *
 * Exported shape rather than an inline loop so the positive control can feed it
 * a string that never reaches disk.
 */
export function findForbiddenCommands(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  for (const { label, pattern } of FORBIDDEN) {
    // Scanned over the whole file, not line by line: a formatter that splits
    // `['serve', 'reset']` across four lines must not become a way through.
    // The separator class excludes alphanumerics, so any real word between the
    // two tokens (`serve config is ... reset`) correctly does not match.
    const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    for (const match of source.matchAll(global)) {
      const index = match.index ?? 0;
      violations.push({
        file,
        line: source.slice(0, index).split('\n').length,
        label,
        text: match[0].replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return violations;
}

function remoteSources(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push({
          file: path.relative(REPO_ROOT, full),
          source: fs.readFileSync(full, 'utf-8'),
        });
      }
    }
  };
  walk(REMOTE_DIR);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

describe('src/lib/remote must not invoke a Provider-wide reset', () => {
  it('has files to scan', () => {
    // Guards the guard: a rename or a moved directory would otherwise leave
    // this suite passing over an empty list forever.
    const files = remoteSources().map((f) => f.file);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('src/lib/remote/tailscale.ts');
    expect(files).toContain('src/lib/remote/cloudflare.ts');
  });

  it('finds no forbidden command in any remote source', () => {
    const violations = remoteSources().flatMap(({ file, source }) =>
      findForbiddenCommands(file, source),
    );
    expect(violations).toEqual([]);
  });

  describe('positive control: the scanner actually detects each command', () => {
    // Every rule is fired at source it must reject. Without this, the green
    // above is equally consistent with a regex that matches nothing.
    const cases: readonly { label: string; source: string }[] = [
      {
        label: 'tailscale serve reset',
        source: "await run('tailscale', ['serve', 'reset']);",
      },
      {
        label: 'tailscale funnel reset',
        source: 'const argv = `tailscale funnel reset`;',
      },
      {
        label: 'cloudflared tunnel cleanup',
        source: "spawnSync('cloudflared', ['tunnel', 'cleanup']);",
      },
      {
        label: 'cloudflared tunnel delete',
        source: 'exec(`cloudflared tunnel delete ${name}`);',
      },
    ];

    it.each(cases)('rejects $label', ({ label, source }) => {
      const violations = findForbiddenCommands('synthetic.ts', source);
      expect(violations.map((v) => v.label)).toContain(label);
    });

    it('reports the file and line of the offending call', () => {
      const violations = findForbiddenCommands(
        'src/lib/remote/tailscale.ts',
        ['// header', 'const ok = true;', "run('tailscale serve reset');"].join('\n'),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'src/lib/remote/tailscale.ts',
        line: 3,
        label: 'tailscale serve reset',
      });
    });

    it('catches the command split across lines by a formatter', () => {
      const source = ["await run('tailscale', [", "  'serve',", "  'reset',", ']);'].join('\n');
      const violations = findForbiddenCommands('synthetic.ts', source);
      expect(violations.map((v) => v.label)).toEqual(['tailscale serve reset']);
      // Reported at the line the run starts on, so the message points somewhere.
      expect(violations[0].line).toBe(2);
    });

    it('does not match two tokens that merely appear in the same sentence', () => {
      // The separator class stops at the first alphanumeric, so prose about the
      // rule does not trip the rule. Without this the guard would be unusable
      // in exactly the files that most need to explain themselves.
      expect(
        findForbiddenCommands(
          'synthetic.ts',
          '// Serve config is persistent, so we never reset it wholesale.',
        ),
      ).toEqual([]);
    });

    it('does not fire on the supported teardown', () => {
      // `stop(handle)` and a per-handler `serve --off` are the sanctioned
      // shapes. A guard that flagged them would be turned off within a week.
      const source = [
        'await provider.stop(handle);',
        "await run('tailscale', ['serve', '--https=443', '/', 'off']);",
        "await run('cloudflared', ['tunnel', '--url', 'http://127.0.0.1:3000']);",
      ].join('\n');
      expect(findForbiddenCommands('synthetic.ts', source)).toEqual([]);
    });
  });
});
