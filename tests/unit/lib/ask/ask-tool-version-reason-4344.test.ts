/**
 * Issue #4344 (PR3 review, P2 2): `GET /api/asks/capabilities` says WHY a tool
 * in the table is off — its installed version is older than the minimum, or
 * could not be read — so the CLI does not tell the user "this tool has no ask
 * attribution" about claude or codex. The boolean `tools` table is unchanged
 * (the probe and its 30 s failure cache are untouched).
 *
 * Positive (red before the fix: there was no `versions`): too old names the
 * minimum and the installed version; null, an unparsable string and a probe
 * that throws are `unreadable`.
 * Negative: `tools` keeps its booleans; a tool off the table has no entry.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  askAttributionCapable,
  askToolVersion,
  getAskCapabilities,
  setAskVersionProbeForTest,
} from '@/lib/ask/ask-correlation';

afterEach(() => setAskVersionProbeForTest(null));

describe('the version reason of an attributed tool (Issue #4344 PR3 review)', () => {
  it('too old: names the minimum and the installed version', async () => {
    setAskVersionProbeForTest(async (tool) => (tool === 'claude' ? '2.1.200 (Claude Code)' : 'codex-cli 0.167.2'));
    const body = await getAskCapabilities();
    expect(body.tools).toMatchObject({ claude: false, codex: true, copilot: false });
    expect(body.versions).toEqual({
      claude: { minimum: '2.1.239', installed: '2.1.200 (Claude Code)', state: 'too_old' },
      codex: { minimum: '0.167.2', installed: 'codex-cli 0.167.2', state: 'ok' },
    });
  });

  it.each([
    ['not reported', async () => null],
    ['not a version', async () => 'unknown'],
    ['a probe that throws', async () => { throw new Error('spawn failed'); }],
  ])('unreadable: %s', async (_name, probe) => {
    setAskVersionProbeForTest(probe as () => Promise<string | null>);
    expect(await askToolVersion('claude')).toMatchObject({ minimum: '2.1.239', state: 'unreadable' });
    expect(await askAttributionCapable('claude')).toBe(false);
  });

  it('a tool off the table has no version entry, whatever its version', async () => {
    setAskVersionProbeForTest(async () => '99.0.0');
    expect(await askToolVersion('antigravity')).toBeNull();
    const body = await getAskCapabilities();
    expect(body.tools.antigravity).toBe(false);
    expect(body.versions).not.toHaveProperty('antigravity');
  });
});
