/**
 * H5 (design §0.1・§3.6.3a): the capability is the table narrowed by the installed
 * version — below `ASK_ATTRIBUTION_MIN_VERSIONS`, unreadable, or a probe that
 * fails is false.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  ASK_ATTRIBUTION_MIN_VERSIONS,
  askAttributionCapable,
  getAskCapabilities,
  setAskVersionProbeForTest,
  versionAtLeast,
} from '@/lib/ask/ask-correlation';

afterEach(() => setAskVersionProbeForTest(null));

describe('versionAtLeast', () => {
  it.each([
    ['2.1.239', '2.1.239', true],
    ['2.1.293 (Claude Code)', '2.1.239', true],
    ['2.2.0', '2.1.239', true],
    ['2.1.238', '2.1.239', false],
    ['1.9.999', '2.1.239', false],
    ['unknown', '2.1.239', null],
  ])('%s >= %s → %s', (a, b, expected) => {
    expect(versionAtLeast(a, b)).toBe(expected);
  });
});

describe('askAttributionCapable (H5)', () => {
  it('claude has a minimum version', () => {
    expect(ASK_ATTRIBUTION_MIN_VERSIONS.claude).toBe('2.1.239');
  });

  it.each([
    ['2.1.293', true],
    ['2.1.239', true],
    ['2.1.238', false],
    [null, false],
  ])('claude installed %s → %s', async (installed, expected) => {
    setAskVersionProbeForTest(async () => installed);
    expect(await askAttributionCapable('claude')).toBe(expected);
  });

  it('a probe that throws is false', async () => {
    setAskVersionProbeForTest(async () => {
      throw new Error('spawn failed');
    });
    expect(await askAttributionCapable('claude')).toBe(false);
  });

  // PR2 turns codex on (the contract's decision): the tool off the table here is
  // copilot, which stays off.
  it('a tool off the table stays false whatever its version', async () => {
    setAskVersionProbeForTest(async () => '99.0.0');
    expect(await askAttributionCapable('copilot')).toBe(false);
  });

  it('the capabilities API publishes the narrowed table', async () => {
    setAskVersionProbeForTest(async (tool) => (tool === 'claude' ? '2.1.200' : tool === 'codex' ? '0.166.9' : '99.0.0'));
    expect(await getAskCapabilities()).toMatchObject({ protocol: 1, tools: { claude: false, codex: false, copilot: false } });
  });
});

describe('askAttributionCapable for codex (PR2, H5・Q3)', () => {
  it('codex has a minimum version: the version of the real Q3 record', () => {
    expect(ASK_ATTRIBUTION_MIN_VERSIONS.codex).toBe('0.167.2');
  });

  it.each([
    ['codex-cli 0.167.2', true],
    ['codex-cli 0.168.0', true],
    ['0.167.1', false],
    ['codex-cli 0.154.0', false],
    [null, false],
    ['unknown', false],
  ])('codex installed %s → %s', async (installed, expected) => {
    setAskVersionProbeForTest(async () => installed);
    expect(await askAttributionCapable('codex')).toBe(expected);
  });

  it('the capabilities API publishes codex true at or above its minimum', async () => {
    setAskVersionProbeForTest(async (tool) => (tool === 'codex' ? 'codex-cli 0.167.2' : null));
    expect(await getAskCapabilities()).toMatchObject({ tools: { claude: false, codex: true, copilot: false } });
  });
});
