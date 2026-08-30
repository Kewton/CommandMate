/**
 * CI guard: `src/lib/remote/**` must never invoke a Provider-wide reset
 * (Issue #1937, design §6.3-3).
 *
 * ## What this prevents
 *
 * `tailscale serve` configuration is persistent state held by tailscaled, the
 * user may already be publishing their own services through it, and there is no
 * undo and no backup. One wholesale command and their configuration is gone.
 * `cloudflared tunnel cleanup` is the same shape for tunnel connections.
 *
 * The supported teardown is `RemoteProvider.stop(handle)`, which reverts only
 * what is in `handle.owned` and not in `handle.preexisting`. The commands below
 * are the exact opposite: they operate on "everything currently configured",
 * which is why the type deliberately cannot express them and why this test
 * exists to catch someone shelling out to them anyway.
 *
 * ## The list grew in R3, because measuring beat guessing
 *
 * R1 forbade one Tailscale command (`serve` + `reset`) because that was the one
 * §6.4 had heard of — written on a machine with no `tailscale` installed at all.
 * Measured on 2026-08-29 against Tailscale 1.102.3 (raw log:
 * `dev-reports/issue/1937/u2-tailscale-serve.md`), four more shapes are as
 * destructive or worse:
 *
 * | shape | `serve --help` says | measured |
 * |---|---|---|
 * | `serve clear <svc>` | "Remove all config for a service" | not run; help is unambiguous |
 * | `serve drain <svc>` | "Drain a service from the current node" | not run; help is unambiguous |
 * | `serve set-config <f> --all` | "all endpoint handlers for **all services** are overwritten" | not run; help is unambiguous |
 * | `serve --https=<port> off`, **no `--set-path`** | help does not mention `off` at all | **run: wiped every handler on the port; exit 0** |
 *
 * The last row is the dangerous one, and it is the reason this file changed
 * rather than merely grew. Two facts, both measured:
 *
 * 1. On a node serving `/` and `/u2-existing-user`, `serve --https=443 off`
 *    (and equally `serve --https=443 / off`, with the path passed positionally
 *    the way older Tailscale docs show) left `serve status --json` at `{}`.
 *    Both handlers gone, exit status 0, no warning. Only
 *    `serve --https=443 --set-path <path> off` removed one and kept the other.
 * 2. The untargeted form is *what the tool itself recommends*: the success
 *    banner of a `serve` command tells the user to disable the proxy by
 *    re-running with just the port flag and `off`.
 *
 * So R1's `it('does not fire on the supported teardown')` was blessing a
 * full-wipe command as sanctioned. It is corrected below to the shape that
 * actually measured safe.
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
 * Commands that act on more than the one handler CommandMate created.
 *
 * Most are matched on their tokens with any run of separators between them, so
 * a template literal (`` `tailscale serve reset` ``), a spawn argv
 * (`['serve', 'reset']`) and a wrapped line all read as the same call. The
 * separator class excludes alphanumerics, so a real word between the tokens
 * (prose like "serve config is never reset wholesale") correctly does not match
 * — and, for the two rules that need it, that same property is what makes
 * `--set-path` between the port flag and `off` read as a different command.
 */
const FORBIDDEN: readonly { label: string; pattern: RegExp }[] = [
  {
    label: 'tailscale serve reset',
    pattern: /\bserve\b[^A-Za-z0-9]{1,40}\breset\b/i,
  },
  {
    // "Remove all config for a service" — a service-scoped wipe.
    label: 'tailscale serve clear',
    pattern: /\bserve\b[^A-Za-z0-9]{1,40}\bclear\b/i,
  },
  {
    // Takes the node out of a service. Not a teardown of anything we own.
    label: 'tailscale serve drain',
    pattern: /\bserve\b[^A-Za-z0-9]{1,40}\bdrain\b/i,
  },
  {
    // `set-config` itself is allowed — it is the only restore path there is.
    // `--all` is not: help says it overwrites every handler of every service,
    // which is `reset` with extra steps.
    //
    // One intervening token is permitted between the two, because the real
    // shapes always have one: the config file path (`set-config cfg.json
    // --all`) or the variable holding it (`['set-config', file, '--all']`).
    label: 'tailscale serve set-config --all',
    pattern: /\bset-config\b[^A-Za-z0-9]{1,40}(?:[A-Za-z0-9_${}./\\-]{1,120}[^A-Za-z0-9]{1,40})?--all\b/i,
  },
  {
    // MEASURED, and the reason this rule is not obvious: a port flag followed
    // by `off` with no path removes EVERY handler on that port.
    //
    // The rule works by exclusion rather than by inspection: `--set-path` is
    // made of alphanumerics, so its presence between the port and `off` breaks
    // the separator run and the targeted form does not match. Nothing here has
    // to parse an argv.
    label: 'untargeted tailscale serve off (no --set-path)',
    pattern: /--[a-z-]*(?:https?|tcp)\b[^A-Za-z0-9]{0,8}\d{1,5}[^A-Za-z0-9]{1,40}\boff\b/i,
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

  it('covers every command measured to reach beyond one handler', () => {
    // Exact equality, so adding a rule without a positive control below, or
    // quietly dropping one, is a visible edit rather than a silent narrowing.
    expect(FORBIDDEN.map((rule) => rule.label)).toEqual([
      'tailscale serve reset',
      'tailscale serve clear',
      'tailscale serve drain',
      'tailscale serve set-config --all',
      'untargeted tailscale serve off (no --set-path)',
      'tailscale funnel reset',
      'cloudflared tunnel cleanup',
      'cloudflared tunnel delete',
    ]);
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
        label: 'tailscale serve clear',
        source: "await run('tailscale', ['serve', 'clear', service]);",
      },
      {
        label: 'tailscale serve drain',
        source: 'exec(`tailscale serve drain ${service}`);',
      },
      {
        label: 'tailscale serve set-config --all',
        source: "spawnSync('tailscale', ['serve', 'set-config', file, '--all']);",
      },
      {
        label: 'untargeted tailscale serve off (no --set-path)',
        source: "await run('tailscale', ['serve', '--https=443', 'off']);",
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

    it('fires at least one control per rule', () => {
      // Pairs the control list with the rule list, so a rule can never be added
      // without one. `0 hits` and `no rule` are otherwise the same green.
      expect(cases.map((c) => c.label)).toEqual(FORBIDDEN.map((rule) => rule.label));
    });

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

    it('catches the untargeted off in each shape it can be written in', () => {
      // MEASURED (1.102.3): every one of these leaves `serve status --json` at
      // `{}` on a node that had two handlers. The positional-path form is the
      // nastiest, because it *looks* targeted and is not — R1's negative
      // control blessed exactly that string.
      const shapes = [
        'exec(`tailscale serve --https=443 off`);',
        "await run('tailscale', ['serve', '--https=443', '/', 'off']);",
        "await run('tailscale', ['serve', '--http', '80', 'off']);",
        "await run('tailscale', ['serve', '--tcp=2222', 'off']);",
        "await run('tailscale', ['serve', '--tls-terminated-tcp=8443', 'off']);",
      ];
      for (const source of shapes) {
        expect(
          findForbiddenCommands('synthetic.ts', source).map((v) => v.label),
          source,
        ).toContain('untargeted tailscale serve off (no --set-path)');
      }
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
      expect(
        findForbiddenCommands(
          'synthetic.ts',
          '// The --all flag is what makes set-config dangerous; we never pass it.',
        ),
      ).toEqual([]);
    });

    it('does not fire on the supported teardown', () => {
      // `stop(handle)` and a `--set-path`-scoped `off` are the sanctioned
      // shapes. A guard that flagged them would be turned off within a week.
      //
      // CORRECTED IN R3: this case used to list
      // `['serve', '--https=443', '/', 'off']` as sanctioned. Measured, that
      // form ignores the positional path and wipes the port, so it moved to the
      // positive controls above. `--set-path` is what makes it targeted.
      const source = [
        'await provider.stop(handle);',
        "await run('tailscale', ['serve', '--https=443', '--set-path', '/', '--yes', 'off']);",
        "await run('cloudflared', ['tunnel', '--url', 'http://127.0.0.1:3000']);",
      ].join('\n');
      expect(findForbiddenCommands('synthetic.ts', source)).toEqual([]);
    });

    it('does not fire on the creation command or on a service-scoped set-config', () => {
      // `serve --bg ... --set-path` is how the Provider publishes, and
      // `set-config --service` is the sanctioned restore path. Neither reaches
      // beyond one handler / one named service.
      const source = [
        "await run('tailscale', ['serve', '--bg', '--yes', '--https=443', '--set-path', '/', 'http://127.0.0.1:3000']);",
        "await run('tailscale', ['serve', 'set-config', file, '--service=svc:mine']);",
      ].join('\n');
      expect(findForbiddenCommands('synthetic.ts', source)).toEqual([]);
    });
  });
});
