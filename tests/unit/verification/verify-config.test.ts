/**
 * Issue #1541: .commandmate/verify.yaml loader / validator
 *
 * The canonical spec is docs/design/verification-config.md. Where the Issue body
 * and the spec disagree (unknown keys), the spec wins -- see §2.1 and §8.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  loadVerifyConfig,
  VerifyConfigError,
  RESERVED_GATE_IDS,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_MAX_LOG_TAIL_BYTES,
  MAX_GATE_MUTEX_LENGTH,
  MAX_RETRY_ON_FAIL,
} from '@/lib/verification/verify-config';
import { removeTempDir } from '@tests/helpers/temp-dir';

let repoPath: string;

function writeConfig(yaml: string): void {
  mkdirSync(join(repoPath, '.commandmate'), { recursive: true });
  writeFileSync(join(repoPath, '.commandmate', 'verify.yaml'), yaml, 'utf8');
}

/** Load a config expected to be invalid and return its collected issues. */
function issuesOf(yaml: string): string[] {
  writeConfig(yaml);
  try {
    loadVerifyConfig(repoPath);
  } catch (error) {
    if (error instanceof VerifyConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected loadVerifyConfig to throw VerifyConfigError, but it returned');
}

const MINIMAL = `version: 1
gates:
  - id: lint
    command: "npm run lint"
`;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'verify-config-'));
});

afterEach(() => {
  removeTempDir(repoPath);
});

describe('loadVerifyConfig', () => {
  describe('missing file', () => {
    it('returns null when .commandmate/verify.yaml does not exist', () => {
      expect(loadVerifyConfig(repoPath)).toBeNull();
    });

    it('returns null when .commandmate exists but verify.yaml does not', () => {
      mkdirSync(join(repoPath, '.commandmate'), { recursive: true });
      expect(loadVerifyConfig(repoPath)).toBeNull();
    });
  });

  describe('valid configs', () => {
    it('parses every field of a fully specified config', () => {
      writeConfig(`version: 1
gates:
  - id: lint
    command: "npm run lint"
    timeoutSec: 900
  - id: typecheck
    command: "npx tsc --noEmit"
  - id: unit
    command: "npm run test:unit"
    timeoutSec: 3600
options:
  baseRef: origin/develop
  skipInPrimaryCheckout: false
  maxLogTailBytes: 32768
`);

      expect(loadVerifyConfig(repoPath)).toEqual({
        version: 1,
        gates: [
          { id: 'lint', command: 'npm run lint', timeoutSec: 900 },
          { id: 'typecheck', command: 'npx tsc --noEmit', timeoutSec: DEFAULT_TIMEOUT_SEC },
          { id: 'unit', command: 'npm run test:unit', timeoutSec: 3600 },
        ],
        options: {
          baseRef: 'origin/develop',
          skipInPrimaryCheckout: false,
          maxLogTailBytes: 32768,
          requireCommit: false,
          requireEnvClean: false,
        },
      });
    });

    it('applies documented defaults when optional fields are omitted', () => {
      writeConfig(MINIMAL);

      expect(loadVerifyConfig(repoPath)).toEqual({
        version: 1,
        gates: [{ id: 'lint', command: 'npm run lint', timeoutSec: 600 }],
        options: {
          baseRef: null,
          skipInPrimaryCheckout: true,
          maxLogTailBytes: 8192,
          requireCommit: false,
          requireEnvClean: false,
        },
      });
    });

    it('exposes the documented default constants', () => {
      expect(DEFAULT_TIMEOUT_SEC).toBe(600);
      expect(DEFAULT_MAX_LOG_TAIL_BYTES).toBe(8192);
      // Pinned so the it.each() below cannot silently degrade to zero cases.
      expect(RESERVED_GATE_IDS).toEqual(['work-evidence', 'scope', 'env-clean']);
    });

    it('applies option defaults individually when options is partially specified', () => {
      writeConfig(`${MINIMAL}options:
  baseRef: origin/main
`);

      const config = loadVerifyConfig(repoPath);
      expect(config?.options).toEqual({
        baseRef: 'origin/main',
        skipInPrimaryCheckout: true,
        maxLogTailBytes: DEFAULT_MAX_LOG_TAIL_BYTES,
        requireCommit: false,
        requireEnvClean: false,
      });
    });

    it('treats a childless "options:" key as all defaults', () => {
      writeConfig(`${MINIMAL}options:
`);

      expect(loadVerifyConfig(repoPath)?.options).toEqual({
        baseRef: null,
        skipInPrimaryCheckout: true,
        maxLogTailBytes: DEFAULT_MAX_LOG_TAIL_BYTES,
        requireCommit: false,
        requireEnvClean: false,
      });
    });

    it('accepts the inclusive boundaries of every numeric range', () => {
      writeConfig(`version: 1
gates:
  - id: a
    command: "true"
    timeoutSec: 1
  - id: b
    command: "true"
    timeoutSec: 7200
options:
  maxLogTailBytes: 0
`);

      const config = loadVerifyConfig(repoPath);
      expect(config?.gates.map((g) => g.timeoutSec)).toEqual([1, 7200]);
      expect(config?.options.maxLogTailBytes).toBe(0);

      writeConfig(`${MINIMAL}options:
  maxLogTailBytes: 1048576
`);
      expect(loadVerifyConfig(repoPath)?.options.maxLogTailBytes).toBe(1048576);
    });

    it('accepts gate ids at the boundaries of the id pattern', () => {
      const longest = `a${'b'.repeat(31)}`;
      writeConfig(`version: 1
gates:
  - id: "0"
    command: "true"
  - id: ${longest}
    command: "true"
`);

      expect(loadVerifyConfig(repoPath)?.gates.map((g) => g.id)).toEqual(['0', longest]);
      expect(longest).toHaveLength(32);
    });

    it('reads scalars quoted the way the bash subset writes them (spec §6)', () => {
      writeConfig(`version: "1"
gates:
  - id: "lint"
    command: 'npm run lint'
    timeoutSec: "900"
options:
  skipInPrimaryCheckout: "false"
  maxLogTailBytes: "4096"
`);

      expect(loadVerifyConfig(repoPath)).toEqual({
        version: 1,
        gates: [{ id: 'lint', command: 'npm run lint', timeoutSec: 900 }],
        options: {
          baseRef: null,
          skipInPrimaryCheckout: false,
          maxLogTailBytes: 4096,
          requireCommit: false,
          requireEnvClean: false,
        },
      });
    });
  });

  describe('YAML-level failures', () => {
    it('reports a syntax error as a VerifyConfigError with a non-empty issue list', () => {
      const issues = issuesOf(`version: 1
gates:
  - id: lint
   command: "npm run lint"
`);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/YAML/i);
    });

    it('rejects duplicate mapping keys instead of silently taking one', () => {
      expect(issuesOf(`version: 1
version: 2
gates:
  - id: lint
    command: "true"
`)).not.toHaveLength(0);
    });

    it('rejects an empty document', () => {
      expect(issuesOf('')).not.toHaveLength(0);
    });

    it('rejects a document whose root is not a mapping', () => {
      expect(issuesOf('- version: 1\n')).not.toHaveLength(0);
    });
  });

  describe('version', () => {
    it('rejects a missing version', () => {
      expect(issuesOf(`gates:
  - id: lint
    command: "true"
`)).toEqual([expect.stringContaining('version')]);
    });

    it.each([2, 0, -1])('rejects version %s (fail closed, no best-effort parse)', (version) => {
      const issues = issuesOf(`version: ${version}
gates:
  - id: lint
    command: "true"
`);
      expect(issues).toEqual([expect.stringContaining('version')]);
    });

    it('rejects a non-integer version', () => {
      expect(issuesOf(`version: one
gates:
  - id: lint
    command: "true"
`)).toEqual([expect.stringContaining('version')]);
    });
  });

  describe('gates', () => {
    it('rejects a config with no gates key', () => {
      expect(issuesOf('version: 1\n')).toEqual([expect.stringContaining('gates')]);
    });

    it('rejects an empty gates list', () => {
      expect(issuesOf('version: 1\ngates: []\n')).toEqual([expect.stringContaining('gates')]);
    });

    it('rejects gates that is not a list', () => {
      expect(issuesOf('version: 1\ngates:\n  id: lint\n')).toEqual([
        expect.stringContaining('gates'),
      ]);
    });

    it('rejects a duplicate gate id', () => {
      const issues = issuesOf(`version: 1
gates:
  - id: lint
    command: "a"
  - id: lint
    command: "b"
`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('gates[1]');
      expect(issues[0]).toMatch(/duplicate/i);
    });

    it.each(RESERVED_GATE_IDS)('rejects the reserved gate id "%s"', (reserved) => {
      const issues = issuesOf(`version: 1
gates:
  - id: ${reserved}
    command: "true"
`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/reserved/i);
    });

    it.each([
      ['Lint', 'uppercase'],
      ['-lint', 'leading hyphen'],
      ['lint_unit', 'underscore'],
      ['lint unit', 'space'],
      ['a'.repeat(33), 'longer than 32 characters'],
      ['', 'empty'],
    ])('rejects the gate id %j (%s)', (id) => {
      expect(issuesOf(`version: 1
gates:
  - id: "${id}"
    command: "true"
`)).toHaveLength(1);
    });

    it('rejects a missing id', () => {
      expect(issuesOf('version: 1\ngates:\n  - command: "true"\n')).toEqual([
        expect.stringContaining('id'),
      ]);
    });

    it.each([
      ['missing', 'version: 1\ngates:\n  - id: lint\n'],
      ['empty', 'version: 1\ngates:\n  - id: lint\n    command: ""\n'],
      ['blank', 'version: 1\ngates:\n  - id: lint\n    command: "   "\n'],
    ])('rejects a %s command', (_label, yaml) => {
      expect(issuesOf(yaml)).toEqual([expect.stringContaining('command')]);
    });

    it.each([0, 7201, -1])('rejects timeoutSec %s (outside 1..7200)', (timeoutSec) => {
      const issues = issuesOf(`version: 1
gates:
  - id: lint
    command: "true"
    timeoutSec: ${timeoutSec}
`);
      expect(issues).toEqual([expect.stringContaining('timeoutSec')]);
    });

    it.each(['abc', '1.5', ''])('rejects the non-integer timeoutSec %j', (timeoutSec) => {
      expect(issuesOf(`version: 1
gates:
  - id: lint
    command: "true"
    timeoutSec: ${timeoutSec}
`)).toEqual([expect.stringContaining('timeoutSec')]);
    });

    it('rejects a gate that is not a mapping', () => {
      expect(issuesOf('version: 1\ngates:\n  - lint\n')).toEqual([
        expect.stringContaining('gates[0]'),
      ]);
    });
  });

  describe('options', () => {
    it('rejects a non-string baseRef', () => {
      expect(issuesOf(`${MINIMAL}options:\n  baseRef: 3\n`)).toEqual([
        expect.stringContaining('baseRef'),
      ]);
    });

    it.each(['yes', 'enabled', '1'])(
      'rejects the non-boolean skipInPrimaryCheckout %j',
      (value) => {
        expect(issuesOf(`${MINIMAL}options:\n  skipInPrimaryCheckout: ${value}\n`)).toEqual([
          expect.stringContaining('skipInPrimaryCheckout'),
        ]);
      }
    );

    it.each([-1, 1048577])('rejects maxLogTailBytes %s (outside 0..1048576)', (value) => {
      expect(issuesOf(`${MINIMAL}options:\n  maxLogTailBytes: ${value}\n`)).toEqual([
        expect.stringContaining('maxLogTailBytes'),
      ]);
    });

    it('rejects options that is not a mapping', () => {
      expect(issuesOf(`${MINIMAL}options: origin/develop\n`)).toEqual([
        expect.stringContaining('options'),
      ]);
    });
  });

  // Issue #1771: a gate that owns a fixed port / database / emulator can only run
  // once per machine, and neither `command` nor `timeoutSec` can say so.
  describe('gates[].mutex (Issue #1771)', () => {
    it('accepts a declared mutex name', () => {
      writeConfig(`version: 1
gates:
  - id: e2e
    command: "npm run test:e2e"
    mutex: e2e-port
`);
      expect(loadVerifyConfig(repoPath)?.gates[0].mutex).toBe('e2e-port');
    });

    it('leaves the key absent when no mutex is declared', () => {
      writeConfig(MINIMAL);
      const gate = loadVerifyConfig(repoPath)?.gates[0];
      // Absent, not `undefined`-valued: a contract's gate list is stored as JSON
      // and replayed verbatim, and an explicit key would claim a declaration
      // nobody wrote.
      expect(gate && 'mutex' in gate).toBe(false);
    });

    it.each(['port.60303', 'db_local', 'e2e-1', 'A'])('accepts %s', (name) => {
      writeConfig(`version: 1
gates:
  - id: e2e
    command: "true"
    mutex: "${name}"
`);
      expect(loadVerifyConfig(repoPath)?.gates[0].mutex).toBe(name);
    });

    it.each([
      ['""', 'empty'],
      ['"e2e port"', 'whitespace'],
      ['"e2e/port"', 'a path separator'],
      ['"e2e:port"', 'a colon'],
      ['"../escape"', 'a traversal attempt'],
    ])('rejects %s (%s)', (value) => {
      const issues = issuesOf(`version: 1
gates:
  - id: e2e
    command: "true"
    mutex: ${value}
`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('mutex');
    });

    it('rejects a name longer than the filesystem-safe cap', () => {
      const issues = issuesOf(`version: 1
gates:
  - id: e2e
    command: "true"
    mutex: "${'a'.repeat(MAX_GATE_MUTEX_LENGTH + 1)}"
`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('mutex');
    });

    it('rejects a non-string mutex', () => {
      const issues = issuesOf(`version: 1
gates:
  - id: e2e
    command: "true"
    mutex:
      name: e2e
`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('mutex');
    });

    it('drops the gate when the mutex is invalid, so no gate runs unlocked', () => {
      // The runner is handed only the gates that validated. A rejected mutex
      // that still produced a gate object would be the one failure mode this
      // field must not have: the resource claim silently dropped while the
      // command runs anyway.
      writeConfig(`version: 1
gates:
  - id: e2e
    command: "true"
    mutex: "bad name"
`);
      expect(() => loadVerifyConfig(repoPath)).toThrow(VerifyConfigError);
    });
  });

  // Issue #1772: a gate that fails on the machine's luck (a random UUID that
  // happens to contain a forbidden substring) is indistinguishable from a gate
  // that fails on the work, and "re-run the one red gate first" was tribal
  // knowledge rather than a declaration the runner could act on.
  describe('gates[].retryOnFail / flakyIsPass (Issue #1772)', () => {
    it('accepts retryOnFail: 1 with flakyIsPass: true', () => {
      writeConfig(`version: 1
gates:
  - id: unit
    command: "npm run test:unit"
    retryOnFail: 1
    flakyIsPass: true
`);
      const gate = loadVerifyConfig(repoPath)?.gates[0];
      expect(gate?.retryOnFail).toBe(1);
      expect(gate?.flakyIsPass).toBe(true);
    });

    it('accepts retryOnFail: 1 on its own, defaulting to FLAKY counting as a failure', () => {
      writeConfig(`version: 1
gates:
  - id: unit
    command: "npm run test:unit"
    retryOnFail: 1
`);
      const gate = loadVerifyConfig(repoPath)?.gates[0];
      expect(gate?.retryOnFail).toBe(1);
      // Absent, not false: the default lives in the runner, and a key nobody
      // wrote must not appear in a contract's stored gate JSON.
      expect(gate && 'flakyIsPass' in gate).toBe(false);
    });

    it('leaves both keys absent when neither is declared', () => {
      writeConfig(MINIMAL);
      const gate = loadVerifyConfig(repoPath)?.gates[0];
      expect(gate && 'retryOnFail' in gate).toBe(false);
      expect(gate && 'flakyIsPass' in gate).toBe(false);
    });

    it('accepts an explicit retryOnFail: 0', () => {
      writeConfig(`version: 1
gates:
  - id: unit
    command: "true"
    retryOnFail: 0
`);
      expect(loadVerifyConfig(repoPath)?.gates[0].retryOnFail).toBe(0);
    });

    it.each(['2', '3', '-1', '10'])('rejects retryOnFail: %s (out of range)', (value) => {
      // The ceiling is the feature: enough re-runs turn any red green, and the
      // value of this field is precisely that it cannot.
      const issues = issuesOf(`version: 1
gates:
  - id: unit
    command: "true"
    retryOnFail: ${value}
`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('retryOnFail');
      expect(issues[0]).toContain(`must be 0 or ${MAX_RETRY_ON_FAIL}`);
    });

    it.each(['"one"', '1.5', 'true'])('rejects a non-integer retryOnFail: %s', (value) => {
      const issues = issuesOf(`version: 1
gates:
  - id: unit
    command: "true"
    retryOnFail: ${value}
`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('retryOnFail');
    });

    it.each(['"yes"', '1', '"maybe"'])('rejects a non-boolean flakyIsPass: %s', (value) => {
      const issues = issuesOf(`version: 1
gates:
  - id: unit
    command: "true"
    retryOnFail: 1
    flakyIsPass: ${value}
`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('flakyIsPass');
    });

    it('rejects flakyIsPass: true without retryOnFail: 1', () => {
      // A knob that can never fire is a config bug, not a preference: it reads
      // as "flakes are tolerated here" while changing nothing at all.
      const issues = issuesOf(`version: 1
gates:
  - id: unit
    command: "true"
    flakyIsPass: true
`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('flakyIsPass');
      expect(issues[0]).toContain('retryOnFail');
    });

    it('rejects flakyIsPass: true beside retryOnFail: 0', () => {
      const issues = issuesOf(`version: 1
gates:
  - id: unit
    command: "true"
    retryOnFail: 0
    flakyIsPass: true
`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('flakyIsPass');
    });

    it('accepts flakyIsPass: false without a retry (the default said out loud)', () => {
      writeConfig(`version: 1
gates:
  - id: unit
    command: "true"
    flakyIsPass: false
`);
      expect(loadVerifyConfig(repoPath)?.gates[0].flakyIsPass).toBe(false);
    });

    it('drops the gate when retryOnFail is invalid, so it never runs unretried', () => {
      writeConfig(`version: 1
gates:
  - id: unit
    command: "true"
    retryOnFail: 5
`);
      expect(() => loadVerifyConfig(repoPath)).toThrow(VerifyConfigError);
    });
  });

  // The Issue body says unknown keys are ignored for forward compatibility, but the
  // canonical spec (§2.1 "未知のトップレベルキーは設定エラー", §8 "v1 は閉じた集合")
  // and the Phase 0 reference implementation both reject them. The spec wins.
  describe('unknown keys are rejected (v1 is a closed set)', () => {
    it('rejects an unknown top-level key', () => {
      const issues = issuesOf(`${MINIMAL}extras:\n  foo: bar\n`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('extras');
    });

    it('rejects an unknown gate key', () => {
      const issues = issuesOf(`version: 1
gates:
  - id: lint
    command: "true"
    retries: 3
`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('retries');
    });

    it('rejects an unknown options key', () => {
      const issues = issuesOf(`${MINIMAL}options:\n  parallel: true\n`);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('parallel');
    });
  });

  describe('error aggregation', () => {
    // Guards against a loader that stops at the first violation: an agent should be
    // able to fix every problem from one run.
    it('collects every violation into a single VerifyConfigError', () => {
      const issues = issuesOf(`version: 2
gates:
  - id: Lint
    command: ""
    timeoutSec: 99999
  - id: scope
    command: "true"
options:
  maxLogTailBytes: -5
  parallel: true
`);

      expect(issues).toHaveLength(7);
      expect(issues.filter((i) => i.includes('version'))).toHaveLength(1);
      expect(issues.filter((i) => i.includes('gates[0].id'))).toHaveLength(1);
      expect(issues.filter((i) => i.includes('gates[0].command'))).toHaveLength(1);
      expect(issues.filter((i) => i.includes('gates[0].timeoutSec'))).toHaveLength(1);
      expect(issues.filter((i) => i.includes('gates[1].id'))).toHaveLength(1);
      expect(issues.filter((i) => i.includes('options.maxLogTailBytes'))).toHaveLength(1);
      expect(issues.filter((i) => i.includes('parallel'))).toHaveLength(1);
    });

    it('puts every issue in the Error message so an unhandled throw is still readable', () => {
      writeConfig('version: 3\ngates: []\n');

      expect(() => loadVerifyConfig(repoPath)).toThrow(VerifyConfigError);
      try {
        loadVerifyConfig(repoPath);
      } catch (error) {
        const err = error as VerifyConfigError;
        expect(err.name).toBe('VerifyConfigError');
        expect(err.issues).toHaveLength(2);
        for (const issue of err.issues) {
          expect(err.message).toContain(issue);
        }
      }
    });
  });
});

describe('the repository\'s own .commandmate/verify.yaml', () => {
  // Acceptance check: spec, loader, and the real file added by #1540 must agree.
  it('loads with the gates and options it declares', () => {
    const config = loadVerifyConfig(process.cwd());

    expect(config).not.toBeNull();
    expect(config?.version).toBe(1);
    // The static guards come first so a violation is reported in seconds rather
    // than after the ~13 minute unit suite (Issue #1882; `route-exports` joined
    // in #1946). Each runs the SAME script as its CI job — the check itself
    // lives in scripts/, never copied into this file or into ci-pr.yml; see
    // tests/unit/guards/static-guard-single-source.test.ts.
    expect(config?.gates.map((g) => g.id)).toEqual([
      'token-discipline',
      'control-chars',
      'claudemd-size',
      'route-exports',
      'lint',
      'typecheck',
      'unit',
    ]);
    expect(config?.gates.map((g) => g.command)).toEqual([
      'node scripts/check-token-discipline.mjs',
      'node scripts/check-control-chars.mjs',
      'node scripts/check-claudemd-size.mjs',
      'node scripts/check-route-exports.mjs',
      'npm run lint',
      'npx tsc --noEmit',
      'npm run test:unit',
    ]);
    expect(config?.options.baseRef).toBe('origin/develop');
    expect(config?.options.skipInPrimaryCheckout).toBe(true);
    // 32768 is an explicit in-range override, not the 8192 default.
    expect(config?.options.maxLogTailBytes).toBe(32768);
    expect(config?.options.maxLogTailBytes).not.toBe(DEFAULT_MAX_LOG_TAIL_BYTES);
  });
});
