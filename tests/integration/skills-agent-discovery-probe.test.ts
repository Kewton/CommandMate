/**
 * Opt-in real-CLI discovery probe (Issue #1246)
 *
 * The matrix in `lib/skills/compatibility-matrix` records measurements taken by
 * hand on 2026-07-26. This probe answers a narrower question that *can* be
 * automated safely: is the CLI on this machine still the version the evidence
 * was taken against?
 *
 * What it deliberately does not do is drive an Agent's interactive TUI. Typing
 * into a real CLI to observe its palette has already caused an unrelated global
 * config change on a developer machine, and a test suite is the wrong place to
 * risk that. Version detection uses a single non-interactive `--version`.
 *
 * Two layers, on purpose:
 * - `classifyProbe` is pure and always runs. It is where the rule "a missing
 *   CLI is unknown with a reason, never a failure and never compatible" lives,
 *   so that rule is covered in CI where no Agent CLI is installed.
 * - The subprocess sweep runs only under `CM_SKILL_DISCOVERY_PROBE=1`, on a
 *   machine where someone has chosen to check their local CLIs.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import {
  getSkillAgentMatrix,
  isAgentMeasured,
  type SkillAgentMatrixEntry,
} from '@/lib/skills/compatibility-matrix';
import type { CLIToolType } from '@/lib/cli-tools/types';

const PROBE_ENABLED = process.env.CM_SKILL_DISCOVERY_PROBE === '1';

/** Executable name per Agent. Only the measured Agents need one. */
const PROBE_COMMAND: Partial<Record<CLIToolType, string>> = {
  claude: 'claude',
  codex: 'codex',
};

/** What the probe concluded. `failure` is not in the vocabulary on purpose. */
type ProbeOutcome = 'evidence_applies' | 'version_drifted' | 'unknown';

interface ProbeResult {
  agent: CLIToolType;
  outcome: ProbeOutcome;
  detectedVersion: string | null;
  recordedVersion: string | null;
  /** Why nothing could be concluded. Always set when the outcome is `unknown`. */
  skipReason: string | null;
}

/**
 * Turn a version detection attempt into a probe verdict.
 *
 * An absent CLI yields `unknown` with a reason. It never yields a failure —
 * "this machine does not have Codex installed" is not a defect in CommandMate —
 * and it never yields `evidence_applies`, which would claim a measurement that
 * was not repeated.
 */
export function classifyProbe(
  entry: SkillAgentMatrixEntry,
  detectedVersion: string | null
): ProbeResult {
  const base = {
    agent: entry.agent,
    detectedVersion,
    recordedVersion: entry.testedVersion,
  };

  if (!isAgentMeasured(entry)) {
    return { ...base, outcome: 'unknown', skipReason: 'no recorded measurement for this Agent' };
  }
  if (detectedVersion === null) {
    return { ...base, outcome: 'unknown', skipReason: 'CLI not installed on this machine' };
  }
  if (detectedVersion !== entry.testedVersion) {
    return { ...base, outcome: 'version_drifted', skipReason: null };
  }
  return { ...base, outcome: 'evidence_applies', skipReason: null };
}

/** First SemVer-looking token in `<cli> --version`, or null when it cannot run. */
function detectVersion(command: string): string | null {
  try {
    const output = execFileSync(command, ['--version'], {
      encoding: 'utf-8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
  } catch {
    return null;
  }
}

describe('classifyProbe never turns a missing CLI into a verdict', () => {
  const claude = getSkillAgentMatrix().find((entry) => entry.agent === 'claude')!;
  const gemini = getSkillAgentMatrix().find((entry) => entry.agent === 'gemini')!;

  it('records an uninstalled CLI as unknown with a reason', () => {
    const result = classifyProbe(claude, null);
    expect(result.outcome).toBe('unknown');
    expect(result.skipReason).toEqual(expect.any(String));
  });

  it('never reports a failure for an uninstalled CLI', () => {
    // 受入条件: CLI未導入は failure/compatible でなく unknown + skip 理由。
    for (const entry of getSkillAgentMatrix()) {
      const result = classifyProbe(entry, null);
      expect(result.outcome, entry.agent).toBe('unknown');
      expect(result.skipReason, entry.agent).toEqual(expect.any(String));
    }
  });

  it('records an unmeasured Agent as unknown even when its CLI is present', () => {
    const result = classifyProbe(gemini, '9.9.9');
    expect(result.outcome).toBe('unknown');
    expect(result.skipReason).toContain('no recorded measurement');
  });

  it('flags a version that has moved on from the recorded evidence', () => {
    const result = classifyProbe(claude, '2.9.0');
    expect(result.outcome).toBe('version_drifted');
    expect(result.recordedVersion).toBe('2.1.220');
  });

  it('confirms the evidence when the installed version is the tested one', () => {
    const result = classifyProbe(claude, claude.testedVersion);
    expect(result.outcome).toBe('evidence_applies');
    expect(result.skipReason).toBeNull();
  });
});

describe.runIf(PROBE_ENABLED)('real CLI sweep (CM_SKILL_DISCOVERY_PROBE=1)', () => {
  it('classifies every measured Agent against the CLI on this machine', () => {
    const results = getSkillAgentMatrix()
      .filter(isAgentMeasured)
      .map((entry) => {
        const command = PROBE_COMMAND[entry.agent];
        return classifyProbe(entry, command ? detectVersion(command) : null);
      });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      // Whatever this machine has, the probe must reach a stated outcome and
      // must not leave an `unknown` without a reason.
      expect(['evidence_applies', 'version_drifted', 'unknown']).toContain(result.outcome);
      if (result.outcome === 'unknown') {
        expect(result.skipReason, result.agent).toEqual(expect.any(String));
      }
    }

    // eslint-disable-next-line no-console -- the probe's output is its purpose.
    console.info('[skills discovery probe]', JSON.stringify(results, null, 2));
  });
});
