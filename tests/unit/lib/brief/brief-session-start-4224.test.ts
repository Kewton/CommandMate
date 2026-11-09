/**
 * `commandmate brief --session-start` on the server (Issue #4224, D2 design §6.4 K1〜K5, J8・J10).
 *
 * The form a `SessionStart` hook calls. When the send path will brief the conversation —
 * the branch `derived` / `on` with `injectOnStart`, the instance's tool one whose boundaries
 * are detected — it answers an empty text marked `deferred: 'send'`, so the hook prints
 * nothing and one conversation never gets two briefs. Otherwise it is the plain brief.
 * It reads neither the ledger nor a notice's reservation.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { BriefWorld, resetBriefMemory } from './brief-4223-harness';

const world = new BriefWorld();

function inject(on: boolean): void {
  const current = getMemSettings(world.db, world.repo);
  saveMemSettings(world.db, world.repo, { version: current.version, features: { ...current.features, injectOnStart: on }, rules: current.rules });
}

const ledgerRows = () => world.count('SELECT COUNT(*) n FROM session_brief_boundaries');
const reservations = () => world.count('SELECT COUNT(*) n FROM mem_notice_attempts');

beforeEach(() => {
  resetBriefMemory();
  world.open('brief-session-start-4224-');
  world.worktree('wt-1', [{ id: 'claude', cliTool: 'claude' }]);
  world.setMode('on');
});
afterEach(() => {
  world.close();
  resetBriefMemory();
});

describe('K1 the send path briefs: the hook prints nothing', () => {
  it('injectOnStart on, a claude instance: empty text, deferred to the send', async () => {
    inject(true);
    const run = await world.brief({ sessionStart: '1' });
    expect(run.exit).toBe(0);
    expect(run.body).toMatchObject({ ok: true, format: 'text', text: '', deferred: 'send' });
  });

  it('negative: injectOnStart off — the same text the plain command prints', async () => {
    inject(false);
    const flagged = await world.brief({ sessionStart: '1' });
    const plain = await world.brief();
    expect(flagged.body.deferred).toBeUndefined();
    expect(String(flagged.body.text)).toMatch(/^<<<cmate-brief:/);
    expect(String(flagged.body.text).split('\n').length).toBe(String(plain.body.text).split('\n').length);
  });

  it('derived counts as briefed by the send path too', async () => {
    inject(true);
    world.setMode('derived');
    expect((await world.brief({ sessionStart: '1' })).body).toMatchObject({ deferred: 'send', mode: 'derived' });
  });
});

describe('K2 a tool the send path does not brief', () => {
  it('copilot with injectOnStart on: the hook gets the brief', async () => {
    inject(true);
    world.worktree('wt-c', null);
    setAgentInstances(world.db, 'wt-c', [{ id: 'copilot', cliTool: 'copilot', alias: '', order: 0 }]);
    const run = await world.brief({ worktreeId: 'wt-c', instance: 'copilot', sessionStart: '1' });
    expect(run.exit).toBe(0);
    expect(run.body.deferred).toBeUndefined();
    expect(String(run.body.text)).toMatch(/^<<<cmate-brief:/);
  });
});

describe('K3 / K5 / J10 the flag changes nothing else', () => {
  it('K3 without the flag the answer has no deferred field (the plain command is as before)', async () => {
    inject(true);
    const plain = await world.brief();
    expect(plain.body.deferred).toBeUndefined();
    expect(String(plain.body.text)).toMatch(/^<<<cmate-brief:/);
  });

  it('K5 neither reserves, acknowledges nor touches the ledger', async () => {
    inject(true);
    await world.brief({ sessionStart: '1' });
    inject(false);
    await world.brief({ sessionStart: '1' });
    expect(ledgerRows()).toBe(0);
    expect(reservations()).toBe(0);
  });

  it('a value other than 1, or --json, is an input error', async () => {
    expect((await world.brief({ sessionStart: 'yes' })).body).toMatchObject({ code: 'invalid_request', field: 'sessionStart' });
    expect((await world.brief({ sessionStart: '1', format: 'json' })).body).toMatchObject({ code: 'invalid_request', field: 'format' });
  });
});
