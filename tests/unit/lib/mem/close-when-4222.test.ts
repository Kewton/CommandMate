/**
 * What #4222 changed in the grammar and the stored form (design S1・P2-1), against the
 * fixture `tests/fixtures/mem/close-when-v1.json`: `session:` takes only the task /
 * verify / schedule namespaces; `deleted` keeps the tip when there is one.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { closeWhenGitNeeds, finalizeCloseWhen, parseCloseWhen, parseSessionId } from '@/lib/mem/close-when';

const FIXTURE = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/mem/close-when-v1.json'), 'utf8')) as {
  storedDeleted: { input: string; withTip: Record<string, unknown>; withoutTip: Record<string, unknown> };
  binding: { tip: string; repositoryId: string };
};

const binding = (tip: string | null) => ({
  origin: null,
  tip,
  repositoryId: FIXTURE.binding.repositoryId,
  worktreeIncarnation: () => null,
  sessionGeneration: null,
});

describe('close_when after #4222', () => {
  it('S1: session takes task: / verify:<number> / schedule: and nothing else', () => {
    for (const ok of ['session:task:run-42', 'session:verify:17', 'session:schedule:9f1c-2']) expect([ok, parseCloseWhen('next', ok).ok]).toEqual([ok, true]);
    for (const bad of ['session:run-42', 'session:verify:abc', 'session:job:1', 'session:task:', 'session:12345']) {
      expect([bad, parseCloseWhen('next', bad).ok]).toEqual([bad, false]);
    }
    expect(parseSessionId('verify:17')).toEqual({ kind: 'verify', id: '17' });
    expect(parseSessionId('run-42')).toBeNull();
  });

  it('P2-1: deleted asks for the tip of its scope’s ref, keeps it when there is one, and is stored without one', () => {
    const local = parseCloseWhen('next', FIXTURE.storedDeleted.input);
    expect(local.ok).toBe(true);
    if (!local.ok) return;
    expect(closeWhenGitNeeds(local.draft)).toEqual({ origin: false, tipOf: ['refs/heads/feature/4221-worktree'] });
    expect(finalizeCloseWhen(local.draft, binding(FIXTURE.binding.tip))).toEqual({ ok: true, value: FIXTURE.storedDeleted.withTip });
    expect(finalizeCloseWhen(local.draft, binding(null))).toEqual({ ok: true, value: FIXTURE.storedDeleted.withoutTip });
    const remote = parseCloseWhen('next', 'branch:x?deleted&scope=remote');
    expect(remote.ok && closeWhenGitNeeds(remote.draft)).toEqual({ origin: false, tipOf: ['refs/remotes/origin/x', 'refs/heads/x'] });
  });

  it('(control) merged still refuses without a tip', () => {
    const merged = parseCloseWhen('next', 'branch:x?merged=develop');
    expect(merged.ok && finalizeCloseWhen(merged.draft, binding(null))).toEqual({ ok: false, reason: 'no_tip' });
  });
});
