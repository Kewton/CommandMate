/**
 * Reading opencode's own model / agent catalogue (Issue #2048).
 *
 * Every fixture here is a **live capture** from opencode 1.18.22 in an isolated
 * `HOME` (`docs/design/opencode-server-live-verification.md` §20.1), trimmed to
 * the providers that carry a shape worth guarding and otherwise verbatim. Three
 * shapes are easy to get wrong from the field names alone and all three are
 * asserted:
 *
 *  - `providers` is an **array**, `models` is an **object** keyed by model id;
 *  - `variants` is an **object** too, keyed by variant name;
 *  - `variants: {}` is a real answer, not a missing field.
 *
 * The file also pins the one thing #2042 and #2048 share: both read
 * `GET /config/providers`, and there is now a single reader for it. The context
 * limit assertion is #2042's, re-run against #2048's parser, so a change to one
 * that breaks the other fails here.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  isOpencodeLaunchableAgent,
  readOpencodeAgents,
  readOpencodeModelContextLimit,
  readOpencodeProviderCatalog,
} from '@/lib/hooks/sources/opencode/client';
import { frameVariant } from '@/lib/hooks/sources/opencode/mappers';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

const PROVIDERS = fixture('config-providers-2048');
const AGENTS = fixture('agents-2048');
const SESSION_UPDATED = fixture('session-updated-variant-2048') as {
  withVariant: Record<string, unknown>;
  withoutVariant: Record<string, unknown>;
};
const MESSAGE_UPDATED = fixture('message-updated-variant-2048') as Record<string, unknown>;

describe('readOpencodeProviderCatalog (Issue #2048)', () => {
  const catalog = readOpencodeProviderCatalog(PROVIDERS);

  it('reads every provider the captured install published', () => {
    expect(catalog.map((provider) => provider.id)).toEqual([
      'github-copilot',
      'lmstudio',
      'ollama-cloud',
    ]);
  });

  it('keeps the display name opencode shows in its own footer', () => {
    expect(catalog.find((p) => p.id === 'github-copilot')?.name).toBe('GitHub Copilot');
  });

  it('reads models out of an OBJECT — an Array.isArray guard would find none', () => {
    const copilot = catalog.find((provider) => provider.id === 'github-copilot');
    expect(copilot?.models.map((model) => model.id)).toEqual([
      'claude-haiku-4.5',
      'claude-sonnet-4.6',
      'kimi-k2.7-code',
    ]);
  });

  it('reads variant NAMES out of an object, sorted', () => {
    const sonnet = catalog
      .find((provider) => provider.id === 'github-copilot')
      ?.models.find((model) => model.id === 'claude-sonnet-4.6');
    expect(sonnet?.variants).toEqual(['high', 'low', 'max', 'medium']);
  });

  it('reports a model with `variants: {}` as having none, rather than skipping it', () => {
    const kimi = catalog
      .find((provider) => provider.id === 'github-copilot')
      ?.models.find((model) => model.id === 'kimi-k2.7-code');
    expect(kimi).toBeDefined();
    expect(kimi?.variants).toEqual([]);
  });

  it('keeps model ids containing / and : — both are real, measured spellings', () => {
    expect(
      catalog.find((provider) => provider.id === 'lmstudio')?.models.map((m) => m.id)
    ).toEqual(['qwen/qwen3-coder-30b']);
    expect(
      catalog.find((provider) => provider.id === 'ollama-cloud')?.models.map((m) => m.id)
    ).toEqual(['deepseek-v4-flash:0731']);
  });

  it.each([null, undefined, [], 'nope', { providers: 'nope' }])(
    'answers an empty catalogue for an unreadable body (%s)',
    (body) => {
      expect(readOpencodeProviderCatalog(body)).toEqual([]);
    }
  );
});

describe('readOpencodeModelContextLimit — #2042 through #2048 s reader', () => {
  it('still answers `limit.context`, not `limit.input`', () => {
    expect(
      readOpencodeModelContextLimit(PROVIDERS, 'github-copilot', 'claude-sonnet-4.6')
    ).toBe(1_000_000);
  });

  it('answers null for a model the catalogue does not list', () => {
    expect(readOpencodeModelContextLimit(PROVIDERS, 'github-copilot', 'nope')).toBeNull();
    expect(readOpencodeModelContextLimit(PROVIDERS, 'nope', 'claude-sonnet-4.6')).toBeNull();
  });
});

describe('readOpencodeAgents (Issue #2048)', () => {
  const agents = readOpencodeAgents(AGENTS);

  it('drops the three internal personas, which declare `hidden: true`', () => {
    expect(agents.map((agent) => agent.name)).toEqual([
      'build',
      'explore',
      'general',
      'plan',
    ]);
  });

  it('keeps `mode`, which is what says an agent can start a session', () => {
    const launchable = agents.filter(isOpencodeLaunchableAgent).map((agent) => agent.name);
    expect(launchable).toEqual(['build', 'plan']);
  });

  it('is the pair Issue #2048 s acceptance condition names', () => {
    expect(agents.filter(isOpencodeLaunchableAgent)).toHaveLength(2);
  });

  it.each([null, undefined, {}, 'nope'])('answers an empty list for %s', (body) => {
    expect(readOpencodeAgents(body)).toEqual([]);
  });
});

describe('frameVariant (Issue #2048)', () => {
  it('reads `Session.model.variant` off a live session.updated frame', () => {
    expect(frameVariant(SESSION_UPDATED.withVariant)).toBe('high');
  });

  it('reads the FLAT `info.variant` off a live message.updated frame', () => {
    expect(frameVariant(MESSAGE_UPDATED)).toBe('high');
  });

  it('answers null when the key is simply absent, which is the default-model case', () => {
    expect(frameVariant(SESSION_UPDATED.withoutVariant)).toBeNull();
  });

  it.each([{}, { properties: {} }, { properties: { info: 'nope' } }])(
    'answers null for an unreadable frame (%s)',
    (frame) => {
      expect(frameVariant(frame as Record<string, unknown>)).toBeNull();
    }
  );
});
