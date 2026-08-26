/**
 * The vocabulary of opencode's per-instance launch settings (Issue #2048).
 *
 * Everything here guards one property: **what comes out of
 * `normalizeOpencodeInstanceSettings` is safe to interpolate into a shell
 * command line**, because `prepareOpencodeLaunch` does exactly that with the
 * agent and the model. The values arrive over HTTP, so this is the boundary.
 *
 * The accepted spellings are not invented — they are the ids the four providers
 * on the measured 1.18.22 install actually publish
 * (`docs/design/opencode-server-live-verification.md` §20.1), which is why `/`
 * and `:` have to be in the model class and why nothing else does.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_OPENCODE_INSTANCE_SETTINGS,
  hasOpencodeInstanceSettings,
  normalizeOpencodeInstanceSettings,
  opencodeModelReference,
} from '@/types/opencode-instance-settings';

describe('normalizeOpencodeInstanceSettings (Issue #2048)', () => {
  it('keeps the measured provider / model / agent / variant spellings verbatim', () => {
    expect(
      normalizeOpencodeInstanceSettings({
        agent: 'plan',
        providerId: 'github-copilot',
        modelId: 'claude-sonnet-4.6',
        variant: 'high',
      })
    ).toEqual({
      agent: 'plan',
      providerId: 'github-copilot',
      modelId: 'claude-sonnet-4.6',
      variant: 'high',
    });
  });

  it.each([
    ['LMStudio publishes org/model', 'lmstudio', 'qwen/qwen3-coder-30b'],
    ['Ollama Cloud publishes model:tag', 'ollama-cloud', 'deepseek-v4-flash:0731'],
  ])('accepts a model id measured on a real provider — %s', (_label, providerId, modelId) => {
    const settings = normalizeOpencodeInstanceSettings({ providerId, modelId });
    expect(settings.providerId).toBe(providerId);
    expect(settings.modelId).toBe(modelId);
    expect(opencodeModelReference(settings)).toBe(`${providerId}/${modelId}`);
  });

  it.each([
    ['a command substitution', '$(rm -rf ~)'],
    ['a shell separator', 'build; rm -rf /'],
    ['a quote', "build'"],
    ['a space', 'claude sonnet'],
    ['a backtick', '`id`'],
    ['a newline', 'build\nplan'],
    ['a leading dash, which would read as another flag', '--auto'],
  ])('refuses %s rather than escaping it', (_label, hostile) => {
    const settings = normalizeOpencodeInstanceSettings({
      agent: hostile,
      providerId: hostile,
      modelId: hostile,
      variant: hostile,
    });
    expect(settings).toEqual(EMPTY_OPENCODE_INSTANCE_SETTINGS);
  });

  it('drops half a model reference — `-m` takes provider/model or nothing', () => {
    expect(normalizeOpencodeInstanceSettings({ providerId: 'github-copilot' })).toEqual(
      EMPTY_OPENCODE_INSTANCE_SETTINGS
    );
    expect(normalizeOpencodeInstanceSettings({ modelId: 'claude-sonnet-4.6' })).toEqual(
      EMPTY_OPENCODE_INSTANCE_SETTINGS
    );
  });

  it('keeps the fields that are valid when one field is not', () => {
    expect(
      normalizeOpencodeInstanceSettings({
        agent: 'plan',
        providerId: 'github-copilot',
        modelId: 'claude-sonnet-4.6',
        variant: 'not a variant',
      })
    ).toEqual({
      agent: 'plan',
      providerId: 'github-copilot',
      modelId: 'claude-sonnet-4.6',
      variant: null,
    });
  });

  it.each([null, undefined, 'string', 42, []])('answers all-unset for %s', (input) => {
    expect(normalizeOpencodeInstanceSettings(input)).toEqual(EMPTY_OPENCODE_INSTANCE_SETTINGS);
  });

  it('treats blank strings as unset rather than as values', () => {
    expect(
      normalizeOpencodeInstanceSettings({ agent: '   ', variant: '', modelId: '' })
    ).toEqual(EMPTY_OPENCODE_INSTANCE_SETTINGS);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(normalizeOpencodeInstanceSettings({ agent: '  plan  ' }).agent).toBe('plan');
  });
});

describe('hasOpencodeInstanceSettings (Issue #2048)', () => {
  it('is false for the empty settings and for nothing at all', () => {
    expect(hasOpencodeInstanceSettings(EMPTY_OPENCODE_INSTANCE_SETTINGS)).toBe(false);
    expect(hasOpencodeInstanceSettings(null)).toBe(false);
  });

  it('is true when the variant alone is set — it is a setting the launch cannot carry', () => {
    expect(
      hasOpencodeInstanceSettings({
        agent: null,
        providerId: null,
        modelId: null,
        variant: 'high',
      })
    ).toBe(true);
  });
});

describe('opencodeModelReference (Issue #2048)', () => {
  it('is null unless both halves are present', () => {
    expect(opencodeModelReference(EMPTY_OPENCODE_INSTANCE_SETTINGS)).toBeNull();
    expect(
      opencodeModelReference({
        agent: null,
        providerId: 'github-copilot',
        modelId: null,
        variant: null,
      })
    ).toBeNull();
  });
});
