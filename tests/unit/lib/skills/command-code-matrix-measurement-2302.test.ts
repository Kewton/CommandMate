/**
 * The Command Code row of the Skill compatibility matrix, pinned as a
 * measurement (Issue #2302)
 *
 * ## Why this file exists
 *
 * Issue #2103's mutation sweep found that adding a measured row without pinning
 * its values leaves the row unguarded: the only assertion that moves is
 * `unmeasuredAgents()` losing a name, and that stays true for *any* pair of
 * outcomes. `opencode-matrix-measurement-2037.test.ts` closed that gap for
 * opencode; this file does the same for the row Issue #2302 added.
 *
 * ## What was measured, on Command Code 1.49.0, 2026-09-05
 *
 * Isolated: a scratch `$HOME` carrying only `auth.json` / `config.json`, a fresh
 * git repository with no Skills, `--no-auto-update` so the binary could not
 * change mid-run. The harness is
 * `dev-reports/qa/issue-2302-command-code-skill-probe.sh`; the record is
 * `docs/reference/skill-agent-compatibility.md` §8.
 *
 *  - **discovery** — `cmd skills list -d` enumerates the roots it looks in:
 *    project `.commandcode/skills` and `.agents/skills`, the same pair under
 *    `$HOME`. `.claude/skills` is not among them. One probe Skill was planted
 *    per root at the same moment; `.commandcode/skills` (positive control) and
 *    `.agents/skills` came back listed, `.claude/skills` did not.
 *  - **invocation** — `cmd -p "/<name>"` emits
 *    `{"type":"skill_loaded","name":"<name>"}` before the run starts, and the
 *    model then answers that Skill's token. Re-running the same prompt with
 *    `--no-skills` emits no such event, which is what makes the event mean
 *    discovery rather than prompt text. In the TUI, typing `/probe` offers the
 *    installed Skills as `[skill]` rows — Command Code's *own* palette lists
 *    them, unlike codex and opencode.
 *  - **the trap** — `finalText` alone proves nothing. The `.claude/skills`
 *    negative control answered `PROBE_OK_probe-claude-root` anyway, by reading
 *    the file as an ordinary file ("Found it — that skill lives under
 *    `.claude/skills/`"), while its own reasoning said the name was absent from
 *    the `activate_skill` enum. `skill_loaded` is the discriminator.
 *
 * The assertions are by value and deliberately narrow: they say what 1.49.0 did
 * and nothing about what a later release should do. Re-measuring is supposed to
 * make this file red.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  AGENT_AXIS_OUTCOME_LABEL_KEYS,
  AGENT_EVIDENCE_KIND_LABEL_KEYS,
  AGENT_RELOAD_MESSAGE_KEYS,
  deriveMatrixAgentSupport,
  findSkillAgentMatrixEntry,
  isAgentMeasured,
} from '@/lib/skills/compatibility-matrix';
import { SkillAgentVerification, reconcileAgentSupport } from '@/lib/skills/compatibility';
import {
  SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';

/** The Command Code release Issue #2302 measured against. */
const COMMAND_CODE_TESTED_VERSION = '1.49.0';
/** The day it was measured. */
const COMMAND_CODE_MEASURED_DATE = '2026-09-05';

describe('the 2026-09-05 Command Code measurement is recorded as taken (Issue #2302)', () => {
  const commandCode = findSkillAgentMatrixEntry('command-code');

  it('is a measured row, not the unmeasured placeholder Issue #2250 left', () => {
    expect(commandCode).not.toBeNull();
    expect(isAgentMeasured(commandCode!)).toBe(true);
    expect(commandCode?.skipReasonKey).toBeNull();
  });

  it('records .agents/skills as read and .claude/skills as NOT read', () => {
    // The half of this row that decides where a user should look. Both roots
    // carried a byte-identical payload when the probe ran, so the split is the
    // Agent's and not the install's — naming the unread root here would render
    // as "installed and invisible".
    expect(commandCode?.discoveryRoots).toEqual([SKILL_INSTALL_ROOT_PREFIX]);
    expect(commandCode?.discoveryRoots).not.toContain(SKILL_CLAUDE_INSTALL_ROOT_PREFIX);
  });

  it('names the release and the day it was measured on', () => {
    expect(commandCode?.testedVersion).toBe(COMMAND_CODE_TESTED_VERSION);
    expect(commandCode?.testedDate).toBe(COMMAND_CODE_MEASURED_DATE);
  });

  it('records Command Code as machine-checked on BOTH axes', () => {
    // `discovery` is what `deriveMatrixAgentSupport` reads, so a silent flip
    // here is a silent flip of the badge the reference doc and the Skills UI
    // both render.
    expect(commandCode?.discovery).toMatchObject({
      outcome: 'verified',
      evidenceKind: 'mechanical',
    });
    expect(commandCode?.invocation).toMatchObject({
      outcome: 'verified',
      evidenceKind: 'mechanical',
    });
  });

  it('keeps the display keys agreeing with the outcomes they label', () => {
    // Pinned separately so that moving an outcome *and* its label together —
    // the shape that slips past the row-consistency invariant — is still red.
    expect(commandCode?.discovery.labelKey).toBe(AGENT_AXIS_OUTCOME_LABEL_KEYS.verified);
    expect(commandCode?.invocation.labelKey).toBe(AGENT_AXIS_OUTCOME_LABEL_KEYS.verified);
    expect(commandCode?.discovery.evidenceKindKey).toBe(
      AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical
    );
    expect(commandCode?.invocation.evidenceKindKey).toBe(
      AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical
    );
  });

  it('attaches no limitation to either axis, which is what separates it from codex and opencode', () => {
    // codex hangs `NO_SLASH_COMMAND` on invocation because its palette never
    // lists a Skill; opencode hangs the same key on the narrower fact that its
    // palette does not list one it can still run. Command Code's own composer
    // offers `[skill]` rows, so there is nothing to warn about — and asserting
    // that by value is what stops a copied-in limitation from telling users a
    // route is missing when it is not.
    expect(commandCode?.discovery.limitationKey).toBeNull();
    expect(commandCode?.invocation.limitationKey).toBeNull();
  });

  it('tells the operator a restart, not the no-slash-command variant', () => {
    // Measured: a Skill planted into a running session shows up in the
    // `/skills` picker, which rescans when opened, but not in the composer's
    // slash completion, which is built once at session start. A restart makes
    // both agree. `SESSION_RESTART_NO_SLASH` would be wrong advice here — the
    // slash route works.
    expect(commandCode?.reloadKey).toBe(AGENT_RELOAD_MESSAGE_KEYS.SESSION_RESTART);
    expect(commandCode?.reloadKey).not.toBe(AGENT_RELOAD_MESSAGE_KEYS.SESSION_RESTART_NO_SLASH);
  });

  it('derives native support, which is the badge the measurement earns', () => {
    expect(commandCode && deriveMatrixAgentSupport(commandCode)).toBe('native');
  });

  it('links the evidence, which is the half of the row a reader can check', () => {
    // A row that states a verdict with no reachable record of how it was
    // reached is the thing the matrix exists not to be.
    const source = commandCode?.evidenceSource ?? '';
    expect(source.startsWith('https://')).toBe(true);
    expect(source).toContain('skill-agent-compatibility.md');
  });
});

describe('reconcileAgentSupport now has a measurement to reconcile Command Code against', () => {
  // A day after the measurement, so the row is fresh and `ageDays` is exact.
  const NOW = new Date('2026-09-06T00:00:00Z');

  function view(support: Parameters<typeof reconcileAgentSupport>[0]['support']) {
    return reconcileAgentSupport(
      { agent: 'command-code', support, evidence: 'declared' },
      NOW
    );
  }

  it('stops answering UNVERIFIED, which is what it answered while the row was a placeholder', () => {
    const declared = view('native');
    expect(declared.verification).not.toBe(SkillAgentVerification.UNVERIFIED);
    expect(declared.measured).not.toBeNull();
    expect(declared.skipReasonKey).toBeNull();
  });

  it('confirms a native declaration and carries the measurement with it', () => {
    const declared = view('native');
    expect(declared.support).toBe('native');
    expect(declared.verification).toBe(SkillAgentVerification.CONFIRMED);
    expect(declared.measured?.testedVersion).toBe(COMMAND_CODE_TESTED_VERSION);
    expect(declared.measured?.discoveryRoots).toEqual([SKILL_INSTALL_ROOT_PREFIX]);
    expect(declared.measured?.ageDays).toBe(1);
    expect(declared.measured?.stale).toBe(false);
  });

  it('reports a modest declaration as fallen behind rather than raising it', () => {
    // Only the publisher widens their own claim. The measurement is attached so
    // the discrepancy is visible, but `support` stays what the manifest said.
    const modest = view('unknown');
    expect(modest.support).toBe('unknown');
    expect(modest.declaredSupport).toBe('unknown');
    expect(modest.verification).toBe(SkillAgentVerification.STALE_DECLARATION);
    expect(modest.measured?.discovery.outcome).toBe('verified');
  });

  it('surfaces both axes as verified, so no known limitation is rendered', () => {
    const declared = view('native');
    expect(declared.measured?.discovery.outcome).toBe('verified');
    expect(declared.measured?.invocation.outcome).toBe('verified');
    expect(declared.measured?.invocation.limitationKey).toBeNull();
  });

  it('hands the UI the restart instruction for this Agent', () => {
    expect(view('native').reloadKey).toBe(AGENT_RELOAD_MESSAGE_KEYS.SESSION_RESTART);
  });
});
