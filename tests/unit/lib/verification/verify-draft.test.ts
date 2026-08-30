/**
 * Tests for the verify.yaml drafter (Issue #2061)
 * @vitest-environment node
 *
 * Two questions decide whether this feature is worth having, and both are
 * answered against real inputs rather than fixtures shaped to pass:
 *
 *  1. Does drafting *this repository* from *its own CI* produce the gates the
 *     Issue names — lint / typecheck / unit / build — with the commands CI
 *     actually runs? A fixture workflow would prove only that the scanner reads
 *     the fixture.
 *  2. Is the result a config `commandmate verify` accepts? The product loader
 *     (`loadVerifyConfig`) is run over the rendered bytes, and a sandbox
 *     repository is drafted, written and executed end to end through the
 *     Skill's standalone runner — the other reader of the same file.
 *
 * The third question the acceptance criteria name — never overwrite — is pinned
 * from both directions: the refusal, and the bytes of the existing file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  draftVerifyGates,
  planVerifyConfigDraft,
  renderVerifyYaml,
  writeVerifyConfigDraft,
  refuse,
  deriveGateId,
  quoteFor,
} from '@/lib/verification/verify-draft';
import { loadVerifyConfig } from '@/lib/verification/verify-config';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = resolve(__dirname, '../../../..');
const RUNNER = join(REPO_ROOT, '.claude/skills/cmate-verify/scripts/verify-run.sh');

const tempDirs: string[] = [];

function mkTemp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

afterAll(() => {
  for (const dir of tempDirs) removeTempDir(dir);
});

describe('draftVerifyGates against this repository (Issue #2061)', () => {
  const draft = draftVerifyGates(REPO_ROOT);
  const byId = new Map(draft.gates.map((gate) => [gate.id, gate]));

  it('reads the repository CI definitions and package.json', () => {
    expect(draft.scanned).toContain('.github/workflows/ci-pr.yml');
    expect(draft.scanned).toContain('package.json');
  });

  it('drafts lint / typecheck / unit / build with the commands CI runs', () => {
    // The Issue's acceptance criterion, spelled as the four ids it names.
    expect([...byId.keys()]).toEqual(expect.arrayContaining(['lint', 'typecheck', 'unit', 'build']));
    expect(byId.get('lint')?.command).toBe('npm run lint');
    expect(byId.get('typecheck')?.command).toBe('npx tsc --noEmit');
    expect(byId.get('unit')?.command).toBe('npm run test:unit');
    expect(byId.get('build')?.command).toBe('npm run build');
  });

  it('names the CI job and step each gate came from', () => {
    const lint = byId.get('lint');
    expect(lint?.source.kind).toBe('workflow');
    expect(lint?.source.file).toBe('.github/workflows/ci-pr.yml');
    expect(lint?.source.job).toBe('lint');
    expect(lint?.source.step).toBe('Run ESLint');
  });

  it('puts the fast checks before the slow ones', () => {
    const order = draft.gates.map((gate) => gate.id);
    // Not the exact list — CI changes — but the property that makes a failure
    // readable: a 0.3s guard must not sit behind a 30-minute suite.
    expect(order.indexOf('lint')).toBeLessThan(order.indexOf('unit'));
    expect(order.indexOf('typecheck')).toBeLessThan(order.indexOf('unit'));
    expect(order.indexOf('token-discipline')).toBeLessThan(order.indexOf('lint'));
  });

  it('refuses install, audit, publish and e2e steps, and says why', () => {
    const reasons = new Map(draft.excluded.map((item) => [item.command, item.reason]));
    expect(reasons.get('npm ci')).toBe('setup');
    expect(reasons.get('npm audit --audit-level=critical')).toBe('network');
    expect(reasons.get('npm publish --provenance --access public')).toBe('release');
    expect(reasons.get('npm run test:e2e')).toBe('long-running');
    // Nothing refused may also be drafted: the two lists partition the scan.
    for (const item of draft.excluded) {
      expect(draft.gates.some((gate) => gate.command === item.command)).toBe(false);
    }
  });

  it('never drafts `npm test`, which is a watcher in this repository', () => {
    expect(byId.has('test')).toBe(false);
    const test = draft.excluded.find((item) => item.command === 'npm run test');
    expect(test?.reason).toBe('redundant');
  });

  it('renders a config the product loader accepts', () => {
    const dir = mkTemp('verify-draft-render-');
    mkdirSync(join(dir, '.commandmate'), { recursive: true });
    writeFileSync(join(dir, '.commandmate', 'verify.yaml'), renderVerifyYaml(draft));

    const config = loadVerifyConfig(dir);
    expect(config).not.toBeNull();
    expect(config!.gates.map((gate) => gate.id)).toEqual(draft.gates.map((gate) => gate.id));
    expect(config!.gates.map((gate) => gate.command)).toEqual(
      draft.gates.map((gate) => gate.command)
    );
  });

  it('renders inside the YAML subset the standalone runner parses', () => {
    for (const line of renderVerifyYaml(draft).split('\n')) {
      expect(line).not.toMatch(/\t/);
      // An inline comment would be read as part of the value by the awk parser.
      if (!line.trimStart().startsWith('#') && line.includes(' #')) {
        expect(line).toBe('<no inline comments>');
      }
    }
  });
});

describe('command classification (Issue #2061)', () => {
  it.each([
    ['npm run lint', 'lint'],
    ['npx tsc --noEmit', 'typecheck'],
    ['npm run test:unit', 'unit'],
    ['npm run test:integration', 'integration'],
    ['npm run build:cli', 'build-cli'],
    ['node scripts/check-route-exports.mjs', 'route-exports'],
    ['npx eslint src', 'lint'],
  ])('%s -> gate id %s', (command, id) => {
    expect(deriveGateId(command)).toBe(id);
  });

  it.each([
    ['npm ci', 'setup'],
    ['npm audit --audit-level=critical', 'network'],
    ['npm publish', 'release'],
    ['docker build .', 'container'],
    ['npm run lint:fix', 'mutating'],
    ['npx playwright test', 'long-running'],
    ['npm run build\nnpm run lint', 'multi-line'],
    ['node -v && npm -v', 'multi-command'],
    ['echo "::warning ::x"', 'runner-specific'],
    ['echo done', 'not-a-check'],
    ['make ${{ matrix.target }}', 'runner-specific'],
  ])('%s is refused as %s', (command, reason) => {
    expect(refuse(command)).toBe(reason);
  });

  it('lets a quoted composite through: the operators are inside an argument', () => {
    // `sh -c 'CI=true npm test'` is the one spelling that lets a gate carry an
    // environment variable, so the composition guard has to be quote-aware.
    expect(refuse("sh -c 'CI=true npm run test:unit'")).toBeNull();
  });

  it('picks a quote character the command does not contain', () => {
    expect(quoteFor('npm run lint')).toBe('"');
    expect(quoteFor('node -e "process.exit(0)"')).toBe("'");
    expect(quoteFor(`mixed " and '`)).toBeNull();
  });
});

describe('writeVerifyConfigDraft never overwrites (Issue #2061)', () => {
  it('refuses an existing config and leaves its bytes untouched', () => {
    const dir = mkTemp('verify-draft-exists-');
    mkdirSync(join(dir, '.commandmate'), { recursive: true });
    const existing = '# hand written\nversion: 1\ngates:\n  - id: mine\n    command: "true"\n';
    const configPath = join(dir, '.commandmate', 'verify.yaml');
    writeFileSync(configPath, existing);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'true' } }));

    const result = writeVerifyConfigDraft(dir);

    expect(result.created).toBe(false);
    expect(result.refusedBecause).toBe('exists');
    // The refusal is not the point; the bytes are.
    expect(readFileSync(configPath, 'utf8')).toBe(existing);
  });

  it('refuses a repository with nothing draftable, rather than writing an empty config', () => {
    const dir = mkTemp('verify-draft-empty-');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev' } }));

    const result = writeVerifyConfigDraft(dir);

    expect(result.created).toBe(false);
    expect(result.refusedBecause).toBe('no-gates');
    // A gate-less verify.yaml is a config error every later run would report.
    expect(() => readFileSync(join(dir, '.commandmate', 'verify.yaml'))).toThrow();
  });

  it('plan reports the same refusal without touching the disk', () => {
    const dir = mkTemp('verify-draft-plan-');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { lint: 'true', build: 'true' } })
    );

    const planned = planVerifyConfigDraft(dir);

    expect(planned.created).toBe(false);
    expect(planned.refusedBecause).toBeUndefined();
    expect(planned.yaml).toContain('- id: lint');
    expect(() => readFileSync(join(dir, '.commandmate', 'verify.yaml'))).toThrow();
  });
});

describe('a drafted config actually runs (Issue #2061)', () => {
  let worktree: string;

  beforeAll(() => {
    const repo = mkTemp('verify-draft-run-');
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(repo, 'package.json'),
      `${JSON.stringify(
        {
          name: 'draft-sandbox',
          scripts: {
            lint: 'node -e "process.exit(0)"',
            'test:unit': 'node -e "process.exit(0)"',
            build: 'node -e "process.exit(0)"',
          },
        },
        null,
        2
      )}\n`
    );
    writeFileSync(
      join(repo, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'jobs:',
        '  check:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Install',
        '        run: npm ci',
        '      - name: Lint',
        '        run: npm run lint',
        '      - name: Unit',
        '        run: npm run test:unit',
        '      - name: Build',
        '        run: npm run build',
        '',
      ].join('\n')
    );

    git(['init', '-b', 'main'], repo);
    git(['config', 'user.email', 'draft@example.test'], repo);
    git(['config', 'user.name', 'Draft'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    git(['add', '-A'], repo);
    git(['commit', '-m', 'base'], repo);

    // A LINKED worktree, not the repository itself: `skipInPrimaryCheckout` is
    // true in every draft, so running the gates in the primary checkout would
    // report `RESULT skipped` and prove nothing about the commands.
    worktree = join(mkTemp('verify-draft-wt-'), 'work');
    git(['worktree', 'add', '-b', 'work', worktree], repo);
    writeFileSync(join(worktree, 'work.txt'), 'agent output\n');
  });

  it('drafts, writes, and passes through the standalone runner', () => {
    const result = writeVerifyConfigDraft(worktree);
    expect(result.created).toBe(true);
    expect(result.draft.gates.map((gate) => gate.id)).toEqual(['lint', 'build', 'unit']);

    const stdout = execFileSync(RUNNER, ['--cwd', worktree, '--base-ref', 'main'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(stdout).toContain('GATE lint PASS');
    expect(stdout).toContain('GATE build PASS');
    expect(stdout).toContain('GATE unit PASS');
    expect(stdout.trim().split('\n').pop()).toBe('RESULT passed');
  });
});
