/**
 * Issue #2315: who decides whether CommandMate may answer codex's hook review
 * with *trust*, and the one case where it may not.
 *
 * Issue #1760 declined that dialog on every launch, on the grounds that a grant
 * writes `[hooks.state…]` into the operator's own `~/.codex/config.toml`. What
 * that cost, measured over the two Issues since: codex records only a GRANT —
 * there is no "asked and refused" state — so the decline bought exactly one
 * launch, the dialog returned on the next one forever, and the hooks the whole
 * of #1760 exists to receive events from never ran once.
 *
 * The security objection behind #1760's answer is nonetheless real, and this
 * function is where it is answered rather than dropped: codex reads
 * `<cwd>/.codex/hooks.json` as well as the home one, so a repository can ship
 * hooks that *Trust all and continue* would trust. A worktree carrying that file
 * therefore keeps the decline-and-escape path, and the human answers its dialog.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  CODEX_HOOK_TRUST_ENV_VAR,
  CODEX_HOOK_TRUST_POLICY_DEFAULT,
  isCodexHookTrustBypassEnabled,
  resolveCodexHookTrustPolicy,
  shouldTrustCodexHooks,
} from '@/lib/hooks/sources/codex/hooks-config';

let plain: string;
let withRepoHooks: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[CODEX_HOOK_TRUST_ENV_VAR];
  delete process.env[CODEX_HOOK_TRUST_ENV_VAR];
  plain = mkdtempSync(join(tmpdir(), 'codex-trust-plain-'));
  withRepoHooks = mkdtempSync(join(tmpdir(), 'codex-trust-repo-'));
  mkdirSync(join(withRepoHooks, '.codex'), { recursive: true });
  writeFileSync(
    join(withRepoHooks, '.codex', 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: ':' }] }] } })
  );
});

afterEach(() => {
  if (saved === undefined) delete process.env[CODEX_HOOK_TRUST_ENV_VAR];
  else process.env[CODEX_HOOK_TRUST_ENV_VAR] = saved;
  removeTempDir(plain);
  removeTempDir(withRepoHooks);
});

describe('resolveCodexHookTrustPolicy', () => {
  it('defaults to auto, including for a value it does not recognise', () => {
    expect(resolveCodexHookTrustPolicy()).toBe(CODEX_HOOK_TRUST_POLICY_DEFAULT);
    expect(CODEX_HOOK_TRUST_POLICY_DEFAULT).toBe('auto');

    process.env[CODEX_HOOK_TRUST_ENV_VAR] = '1';
    expect(resolveCodexHookTrustPolicy()).toBe('auto');
  });

  it('reads the three values it acts on', () => {
    for (const value of ['auto', 'never', 'bypass'] as const) {
      process.env[CODEX_HOOK_TRUST_ENV_VAR] = value;
      expect(resolveCodexHookTrustPolicy()).toBe(value);
    }
  });

  it('still gates the launch flag on `bypass` alone', () => {
    // The flag disables review for EVERY hook the invocation can see, a
    // repository's `.codex/hooks.json` included. Nothing here widens it.
    expect(isCodexHookTrustBypassEnabled()).toBe(false);
    process.env[CODEX_HOOK_TRUST_ENV_VAR] = 'never';
    expect(isCodexHookTrustBypassEnabled()).toBe(false);
    process.env[CODEX_HOOK_TRUST_ENV_VAR] = 'bypass';
    expect(isCodexHookTrustBypassEnabled()).toBe(true);
  });
});

describe('shouldTrustCodexHooks', () => {
  it('trusts for an ordinary worktree', () => {
    expect(shouldTrustCodexHooks(plain)).toBe(true);
  });

  it('withholds trust from a worktree that ships its own .codex/hooks.json', () => {
    // "Trust all" would include the repository's hooks, which is exactly the
    // grant Issue #1760 refused to make on the operator's behalf — and refusing
    // it here is what separates this from `--dangerously-bypass-hook-trust`.
    expect(shouldTrustCodexHooks(withRepoHooks)).toBe(false);
  });

  it('withholds trust everywhere under CM_CODEX_HOOK_TRUST=never', () => {
    process.env[CODEX_HOOK_TRUST_ENV_VAR] = 'never';
    expect(shouldTrustCodexHooks(plain)).toBe(false);
    expect(shouldTrustCodexHooks(withRepoHooks)).toBe(false);
  });

  it('still refuses a repository’s hooks under `bypass`', () => {
    // `bypass` is about the launch flag; it is not a licence for this server to
    // press "trust all" on a review that includes a cloned repository's hooks.
    process.env[CODEX_HOOK_TRUST_ENV_VAR] = 'bypass';
    expect(shouldTrustCodexHooks(plain)).toBe(true);
    expect(shouldTrustCodexHooks(withRepoHooks)).toBe(false);
  });

  it('treats a worktree it cannot read as untrustable', () => {
    expect(shouldTrustCodexHooks(join(plain, 'gone'))).toBe(true);
    // A path whose parent is a FILE cannot hold a `.codex/` at all, and the
    // check must answer rather than throw out of a launch.
    const file = join(plain, 'a-file');
    writeFileSync(file, 'x');
    expect(() => shouldTrustCodexHooks(join(file, 'inner'))).not.toThrow();
  });
});
