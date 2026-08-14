/**
 * Unit tests for the execution-contract loader (Issue #1545, Phase 2-1).
 *
 * Canonical spec: docs/design/task-contract.md
 *
 * Every invalid case asserts the *specific* issue string, not just that the
 * loader threw: a parser that rejected everything for one generic reason would
 * pass a test that only counted throws.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  loadTaskContract,
  parseTaskContract,
  TaskContractError,
  MAX_GATE_DEFINITIONS,
  MAX_PATTERN_LENGTH,
  MAX_TITLE_LENGTH,
  PROMPT_TYPES,
} from '@/lib/tasks/contract-parser';
import { DEFAULT_TIMEOUT_SEC, RESERVED_GATE_IDS } from '@/lib/verification/verify-config';
import { removeTempDir } from '@tests/helpers/temp-dir';

let repoPath: string;

const MINIMAL = `version: 1
title: "contract parser"
goal: |
  Implement the loader.
scope:
  allow:
    - "src/lib/tasks/**"
`;

function writeContract(yaml: string, name = 'task.yaml'): string {
  mkdirSync(join(repoPath, '.commandmate', 'tasks'), { recursive: true });
  writeFileSync(join(repoPath, '.commandmate', 'tasks', name), yaml, 'utf8');
  return join('.commandmate', 'tasks', name);
}

/** Parse a contract expected to be invalid and return its collected issues. */
function issuesOf(yaml: string): string[] {
  try {
    parseTaskContract(yaml, 'task.yaml');
  } catch (error) {
    if (error instanceof TaskContractError) return error.issues;
    throw error;
  }
  throw new Error('expected parseTaskContract to throw TaskContractError, but it returned');
}

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'task-contract-'));
});

afterEach(() => {
  removeTempDir(repoPath);
});

describe('parseTaskContract — valid documents', () => {
  it('accepts a minimal contract and applies every default', () => {
    const contract = parseTaskContract(MINIMAL, 'task.yaml');

    expect(contract).toEqual({
      version: 1,
      title: 'contract parser',
      goal: 'Implement the loader.',
      scope: { allow: ['src/lib/tasks/**'], deny: [] },
      verify: { gates: null, gateDefinitions: [] },
      autoYes: { mode: null, allowPromptTypes: [], denyPatterns: [] },
      success: {
        requireWorkEvidence: true,
        requireScopeClean: true,
        requireCommit: false,
        autoVerifyOnStop: false,
      },
    });
  });

  it('keeps every declared field', () => {
    const contract = parseTaskContract(
      `version: 1
title: full
goal: do the thing
scope:
  allow: ["src/**", "tests/**"]
  deny: ["src/generated/**"]
verify:
  gates: [lint, unit]
autoYes:
  mode: allow-listed
  allowPromptTypes: [yes_no, approval]
  denyPatterns: ["force.?push", "rm -rf"]
success:
  requireWorkEvidence: true
  requireScopeClean: false
  requireCommit: true
  autoVerifyOnStop: true
`,
      'task.yaml'
    );

    expect(contract.scope).toEqual({ allow: ['src/**', 'tests/**'], deny: ['src/generated/**'] });
    expect(contract.verify.gates).toEqual(['lint', 'unit']);
    expect(contract.autoYes).toEqual({
      mode: 'allow-listed',
      allowPromptTypes: ['yes_no', 'approval'],
      denyPatterns: ['force.?push', 'rm -rf'],
    });
    expect(contract.success).toEqual({
      // requireWorkEvidence stays true because requireCommit is judged by that
      // gate; the pair is rejected outright (see the requireCommit tests below).
      requireWorkEvidence: true,
      requireScopeClean: false,
      requireCommit: true,
      autoVerifyOnStop: true,
    });
  });

  it('treats childless sub-maps as "all defaults"', () => {
    const contract = parseTaskContract(
      `version: 1
title: t
goal: g
scope:
  allow: ["src/**"]
verify:
autoYes:
success:
`,
      'task.yaml'
    );

    expect(contract.verify.gates).toBeNull();
    expect(contract.autoYes.mode).toBeNull();
    expect(contract.success).toEqual({
      requireWorkEvidence: true,
      requireScopeClean: true,
      requireCommit: false,
      autoVerifyOnStop: false,
    });
  });

  it('defaults autoVerifyOnStop to false while its siblings default to true', () => {
    // The asymmetry is deliberate (#1549): this is the one success flag that
    // makes the server start a verification run rather than judge one, so a
    // contract written before the field existed must stay inert.
    const contract = parseTaskContract(MINIMAL, 'task.yaml');

    expect(contract.success.autoVerifyOnStop).toBe(false);
    expect(contract.success.requireWorkEvidence).toBe(true);
  });

  it('accepts autoVerifyOnStop as a boolean and as a quoted boolean', () => {
    for (const literal of ['true', '"true"']) {
      const contract = parseTaskContract(
        `${MINIMAL}success:\n  autoVerifyOnStop: ${literal}\n`,
        'task.yaml'
      );
      expect(contract.success.autoVerifyOnStop, `for ${literal}`).toBe(true);
    }
    expect(
      parseTaskContract(`${MINIMAL}success:\n  autoVerifyOnStop: false\n`, 'task.yaml').success
        .autoVerifyOnStop
    ).toBe(false);
  });

  // Issue #1642: the flag that makes the contract's own "必ず commit" sentence
  // enforceable per delegation. It defaults off for the same reason
  // autoVerifyOnStop does — every contract written before it existed keeps its
  // verdict.
  describe('success.requireCommit (Issue #1642)', () => {
    it('defaults to false so existing contracts keep their verdict', () => {
      expect(parseTaskContract(MINIMAL, 'task.yaml').success.requireCommit).toBe(false);
      // ...unlike the two judging flags next to it, which default to true.
      expect(parseTaskContract(MINIMAL, 'task.yaml').success.requireWorkEvidence).toBe(true);
      expect(parseTaskContract(MINIMAL, 'task.yaml').success.requireScopeClean).toBe(true);
    });

    it('accepts it as a boolean and as a quoted boolean', () => {
      for (const literal of ['true', '"true"']) {
        expect(
          parseTaskContract(`${MINIMAL}success:\n  requireCommit: ${literal}\n`, 'task.yaml')
            .success.requireCommit,
          `for ${literal}`
        ).toBe(true);
      }
      expect(
        parseTaskContract(`${MINIMAL}success:\n  requireCommit: false\n`, 'task.yaml').success
          .requireCommit
      ).toBe(false);
    });

    it('rejects a non-boolean instead of coercing it', () => {
      expect(() =>
        parseTaskContract(`${MINIMAL}success:\n  requireCommit: always\n`, 'task.yaml')
      ).toThrow(/requireCommit: must be true or false/);
    });

    it('rejects requireCommit: true alongside requireWorkEvidence: false', () => {
      // The commit requirement is judged by the work-evidence gate, which
      // requireWorkEvidence: false keeps out of the contract's gate selection.
      // Accepting the pair would put "必ず commit" in the preamble with nothing
      // behind it — the D-4 defect this field exists to close.
      expect(() =>
        parseTaskContract(
          `${MINIMAL}success:\n  requireCommit: true\n  requireWorkEvidence: false\n`,
          'task.yaml'
        )
      ).toThrow(/requireCommit: requires success\.requireWorkEvidence to be true/);
    });

    it('still allows requireWorkEvidence: false on its own', () => {
      // Pairs with the case above: the rejection must be about the combination,
      // not about requireWorkEvidence: false having become invalid.
      expect(
        parseTaskContract(`${MINIMAL}success:\n  requireWorkEvidence: false\n`, 'task.yaml')
          .success.requireWorkEvidence
      ).toBe(false);
    });
  });

  it('rejects a non-boolean autoVerifyOnStop instead of coercing it', () => {
    // "yes it should verify" quietly becoming false would be a contract that
    // reads as configured and is not.
    expect(() =>
      parseTaskContract(`${MINIMAL}success:\n  autoVerifyOnStop: sometimes\n`, 'task.yaml')
    ).toThrow(/autoVerifyOnStop: must be true or false/);
  });

  it('allows an empty scope only when requireScopeClean is false', () => {
    const contract = parseTaskContract(
      `version: 1
title: t
goal: g
success:
  requireScopeClean: false
`,
      'task.yaml'
    );

    expect(contract.scope.allow).toEqual([]);
  });

  it('distinguishes an omitted autoYes.mode from an explicit off', () => {
    expect(parseTaskContract(MINIMAL, 'task.yaml').autoYes.mode).toBeNull();
    expect(
      parseTaskContract(`${MINIMAL}autoYes:\n  mode: off\n`, 'task.yaml').autoYes.mode
    ).toBe('off');
  });

  it('accepts every known prompt type', () => {
    const contract = parseTaskContract(
      `${MINIMAL}autoYes:\n  mode: allow-listed\n  allowPromptTypes: [${PROMPT_TYPES.join(', ')}]\n`,
      'task.yaml'
    );
    expect(contract.autoYes.allowPromptTypes).toEqual(PROMPT_TYPES);
  });
});

describe('parseTaskContract — document-level failures', () => {
  it('reports a YAML syntax error', () => {
    expect(issuesOf('version: 1\n  bad indent: [')[0]).toContain('YAML parse error');
  });

  it('rejects a document that is not a mapping', () => {
    expect(issuesOf('- 1\n- 2')[0]).toContain('expected a YAML mapping at the top level');
  });

  it('rejects an unknown top-level key', () => {
    expect(issuesOf(`${MINIMAL}scopes:\n  allow: []\n`)).toContain(
      'top level: unknown key "scopes" (v1 is a closed set)'
    );
  });

  it('rejects an unknown key inside autoYes so a typo cannot silently disable a policy', () => {
    expect(issuesOf(`${MINIMAL}autoYes:\n  mode: safe\n  allowPromtTypes: [yes_no]\n`)).toContain(
      'autoYes: unknown key "allowPromtTypes" (v1 is a closed set)'
    );
  });

  it('requires version 1', () => {
    expect(issuesOf('title: t\ngoal: g\nscope:\n  allow: ["a"]\n')).toContain(
      'version: required, v1 contracts must declare "version: 1"'
    );
    expect(issuesOf(`version: 2\n${MINIMAL.split('\n').slice(1).join('\n')}`)).toContain(
      'version: must be 1 (got 2)'
    );
  });

  it('collects every violation in one error rather than stopping at the first', () => {
    const issues = issuesOf(`version: 9
title: ""
goal: 42
scope:
  allow: ["/etc/passwd"]
verify:
  gates: []
autoYes:
  mode: nope
  denyPatterns: ["("]
`);

    expect(issues).toEqual(
      expect.arrayContaining([
        'version: must be 1 (got 9)',
        'title: required, must be a non-empty string (got "")',
        'goal: required, must be a non-empty string (got 42)',
        'verify.gates: must name at least one gate (omit the key to run every gate)',
        'autoYes.mode: must be one of off, safe, allow-listed (got "nope")',
      ])
    );
    expect(issues.some((issue) => issue.includes('scope.allow[0]'))).toBe(true);
    expect(issues.some((issue) => issue.includes('autoYes.denyPatterns[0]'))).toBe(true);
  });
});

describe('parseTaskContract — scope', () => {
  it('requires at least one allow pattern while requireScopeClean is true', () => {
    expect(issuesOf('version: 1\ntitle: t\ngoal: g\n')).toContain(
      'scope.allow: at least one pattern is required while success.requireScopeClean is true'
    );
  });

  it('rejects an absolute pattern', () => {
    expect(issuesOf('version: 1\ntitle: t\ngoal: g\nscope:\n  allow: ["/etc/**"]\n')).toContain(
      'scope.allow[0]: must be relative to the worktree root (got the absolute path "/etc/**")'
    );
  });

  it('rejects a pattern that escapes the worktree', () => {
    expect(
      issuesOf('version: 1\ntitle: t\ngoal: g\nscope:\n  allow: ["../other/**"]\n')
    ).toContain('scope.allow[0]: must not escape the worktree root with ".." (got "../other/**")');
  });

  it('rejects a deny pattern containing a NUL byte', () => {
    expect(
      issuesOf(`version: 1\ntitle: t\ngoal: g\nscope:\n  allow: ["src/**"]\n  deny: ["a\\0b"]\n`)
    ).toContain('scope.deny[0]: must not contain a NUL byte');
  });

  it('rejects a non-list scope.allow', () => {
    expect(issuesOf('version: 1\ntitle: t\ngoal: g\nscope:\n  allow: "src/**"\n')).toContain(
      'scope.allow: must be a list (got "src/**")'
    );
  });
});

describe('parseTaskContract — verify.gates', () => {
  it('rejects an empty list, because "run everything" is spelled by omission', () => {
    expect(issuesOf(`${MINIMAL}verify:\n  gates: []\n`)).toContain(
      'verify.gates: must name at least one gate (omit the key to run every gate)'
    );
  });

  it('rejects a gate id that could never exist in verify.yaml', () => {
    expect(issuesOf(`${MINIMAL}verify:\n  gates: ["Lint Gate"]\n`)[0]).toContain(
      'verify.gates[0]: "Lint Gate" must match'
    );
  });

  it('rejects a duplicate gate id', () => {
    expect(issuesOf(`${MINIMAL}verify:\n  gates: [lint, lint]\n`)).toContain(
      'verify.gates[1]: duplicate gate id "lint"'
    );
  });
});

describe('parseTaskContract — verify.gateDefinitions (Issue #1791)', () => {
  const DEFINITION = `verify:
  gates: [lint, issue-1791-repro]
  gateDefinitions:
    - id: issue-1791-repro
      command: "node scripts/repro-1791.mjs"
      timeoutSec: 300
`;

  it('accepts a gate the contract defines for itself', () => {
    const contract = parseTaskContract(`${MINIMAL}${DEFINITION}`, 'task.yaml');

    expect(contract.verify.gateDefinitions).toEqual([
      { id: 'issue-1791-repro', command: 'node scripts/repro-1791.mjs', timeoutSec: 300 },
    ]);
    expect(contract.verify.gates).toEqual(['lint', 'issue-1791-repro']);
  });

  it('applies the verify.yaml default timeout when the definition omits one', () => {
    const contract = parseTaskContract(
      `${MINIMAL}verify:\n  gates: [repro]\n  gateDefinitions:\n    - id: repro\n      command: "sh repro.sh"\n`,
      'task.yaml'
    );

    // Same constant verify.yaml gates get, because the same validator ran.
    expect(contract.verify.gateDefinitions[0].timeoutSec).toBe(DEFAULT_TIMEOUT_SEC);
  });

  it('runs every defined gate when gates is omitted', () => {
    const contract = parseTaskContract(
      `${MINIMAL}verify:\n  gateDefinitions:\n    - id: repro\n      command: "sh repro.sh"\n`,
      'task.yaml'
    );

    // null = "every declared gate", which now includes the contract's own.
    expect(contract.verify.gates).toBeNull();
    expect(contract.verify.gateDefinitions).toHaveLength(1);
  });

  it('treats an empty list as no definitions at all', () => {
    // Unlike `gates: []`, this has one possible meaning, so an orchestrator
    // emitting YAML programmatically is not forced to special-case it.
    const contract = parseTaskContract(`${MINIMAL}verify:\n  gateDefinitions: []\n`, 'task.yaml');
    expect(contract.verify.gateDefinitions).toEqual([]);
  });

  for (const reserved of RESERVED_GATE_IDS) {
    it(`refuses to define the reserved id "${reserved}"`, () => {
      // Shadowing a built-in would let a contract replace the gate that judges
      // it — work-evidence redefined as `true` is a contract that proves nothing.
      expect(
        issuesOf(
          `${MINIMAL}verify:\n  gates: [${reserved}]\n  gateDefinitions:\n    - id: ${reserved}\n      command: "true"\n`
        )
      ).toContain(`verify.gateDefinitions[0].id: "${reserved}" is reserved for a built-in gate`);
    });
  }

  it('rejects a duplicate definition id', () => {
    expect(
      issuesOf(
        `${MINIMAL}verify:\n  gates: [repro]\n  gateDefinitions:\n    - id: repro\n      command: "a"\n    - id: repro\n      command: "b"\n`
      )
    ).toContain('verify.gateDefinitions[1].id: duplicate gate id "repro"');
  });

  it('rejects an id verify.yaml could never spell either', () => {
    expect(
      issuesOf(
        `${MINIMAL}verify:\n  gates: [repro]\n  gateDefinitions:\n    - id: "Repro Gate"\n      command: "a"\n`
      )[0]
    ).toContain('verify.gateDefinitions[0].id: "Repro Gate" must match');
  });

  it('rejects a definition with no command', () => {
    expect(
      issuesOf(
        `${MINIMAL}verify:\n  gates: [repro]\n  gateDefinitions:\n    - id: repro\n      command: "   "\n`
      )[0]
    ).toContain('verify.gateDefinitions[0].command: required');
  });

  it('rejects a non-integer timeout', () => {
    expect(
      issuesOf(
        `${MINIMAL}verify:\n  gates: [repro]\n  gateDefinitions:\n    - id: repro\n      command: "a"\n      timeoutSec: 1.5\n`
      )[0]
    ).toContain('verify.gateDefinitions[0].timeoutSec: must be an integer');
  });

  it('rejects a timeout outside the verify.yaml bounds', () => {
    expect(
      issuesOf(
        `${MINIMAL}verify:\n  gates: [repro]\n  gateDefinitions:\n    - id: repro\n      command: "a"\n      timeoutSec: 100000\n`
      )[0]
    ).toContain('verify.gateDefinitions[0].timeoutSec: must be 1..7200');
  });

  it('rejects an unknown key inside a definition', () => {
    expect(
      issuesOf(
        `${MINIMAL}verify:\n  gates: [repro]\n  gateDefinitions:\n    - id: repro\n      command: "a"\n      retries: 3\n`
      )
    ).toContain('verify.gateDefinitions[0]: unknown key "retries" (v1 is a closed set)');
  });

  it('rejects more definitions than the cap allows', () => {
    const many = Array.from(
      { length: MAX_GATE_DEFINITIONS + 1 },
      (_, i) => `    - id: g${i}\n      command: "true"\n`
    ).join('');
    expect(issuesOf(`${MINIMAL}verify:\n  gateDefinitions:\n${many}`)).toContain(
      `verify.gateDefinitions: at most ${MAX_GATE_DEFINITIONS} entries (got ${MAX_GATE_DEFINITIONS + 1})`
    );
  });

  it('rejects a definition that verify.gates leaves unselected', () => {
    // The contract is the only place this gate exists, so a selection that
    // omits it means nothing will ever run it — a check that reads as added
    // and is not.
    expect(
      issuesOf(
        `${MINIMAL}verify:\n  gates: [lint]\n  gateDefinitions:\n    - id: repro\n      command: "a"\n`
      )[0]
    ).toContain('verify.gateDefinitions: repro defined but not named in verify.gates');
  });
});

describe('parseTaskContract — autoYes', () => {
  it('rejects a denyPattern that is not a valid regular expression', () => {
    const issues = issuesOf(`${MINIMAL}autoYes:\n  denyPatterns: ["a(b"]\n`);
    expect(issues[0]).toContain('autoYes.denyPatterns[0]: not a valid regular expression');
  });

  it(`caps a denyPattern at ${MAX_PATTERN_LENGTH} characters (ReDoS bound)`, () => {
    const long = 'a'.repeat(MAX_PATTERN_LENGTH + 1);
    expect(issuesOf(`${MINIMAL}autoYes:\n  denyPatterns: ["${long}"]\n`)).toContain(
      `autoYes.denyPatterns[0]: at most ${MAX_PATTERN_LENGTH} characters (got ${MAX_PATTERN_LENGTH + 1})`
    );
  });

  it(`accepts a denyPattern of exactly ${MAX_PATTERN_LENGTH} characters`, () => {
    const exact = 'a'.repeat(MAX_PATTERN_LENGTH);
    const contract = parseTaskContract(
      `${MINIMAL}autoYes:\n  denyPatterns: ["${exact}"]\n`,
      'task.yaml'
    );
    expect(contract.autoYes.denyPatterns).toEqual([exact]);
  });

  it('rejects an unknown prompt type', () => {
    expect(
      issuesOf(`${MINIMAL}autoYes:\n  mode: allow-listed\n  allowPromptTypes: [yes_maybe]\n`)[0]
    ).toContain('autoYes.allowPromptTypes[0]: unknown prompt type "yes_maybe"');
  });
});

describe('parseTaskContract — title and goal bounds', () => {
  it(`rejects a title longer than ${MAX_TITLE_LENGTH} characters`, () => {
    const long = 'x'.repeat(MAX_TITLE_LENGTH + 1);
    expect(issuesOf(`version: 1\ntitle: "${long}"\ngoal: g\nscope:\n  allow: ["a"]\n`)).toContain(
      `title: at most ${MAX_TITLE_LENGTH} characters (got ${MAX_TITLE_LENGTH + 1})`
    );
  });

  it('trims surrounding whitespace from title and goal', () => {
    const contract = parseTaskContract(
      'version: 1\ntitle: "  spaced  "\ngoal: "  do it  "\nscope:\n  allow: ["a"]\n',
      'task.yaml'
    );
    expect(contract.title).toBe('spaced');
    expect(contract.goal).toBe('do it');
  });
});

describe('loadTaskContract', () => {
  it('loads a contract from the worktree', () => {
    const relative = writeContract(MINIMAL);
    expect(loadTaskContract(repoPath, relative).title).toBe('contract parser');
  });

  it('reports a missing file as a contract issue, not a crash', () => {
    try {
      loadTaskContract(repoPath, '.commandmate/tasks/absent.yaml');
      throw new Error('expected loadTaskContract to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskContractError);
      expect((error as TaskContractError).issues[0]).toContain('contract file not found');
    }
  });

  it('refuses a path that escapes the worktree', () => {
    writeFileSync(join(repoPath, 'outside.yaml'), MINIMAL);
    try {
      loadTaskContract(join(repoPath, 'inner'), '../outside.yaml');
      throw new Error('expected loadTaskContract to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskContractError);
      expect((error as TaskContractError).issues[0]).toContain(
        'contract path must be inside the worktree'
      );
    }
  });

  it('prefixes document issues with the relative path it was asked for', () => {
    const relative = writeContract('version: 2\ntitle: t\ngoal: g\nscope:\n  allow: ["a"]\n');
    try {
      loadTaskContract(repoPath, relative);
      throw new Error('expected loadTaskContract to throw');
    } catch (error) {
      expect((error as TaskContractError).issues).toContain('version: must be 1 (got 2)');
    }
  });
});
