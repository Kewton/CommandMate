/**
 * Tests for the guarded fetch layer and provider fail-soft behavior (Issue #1489).
 *
 * All network access is injected via `fetchImpl`, so these are deterministic and
 * never touch the real network.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest';
import { isAllowedReconcileUrl, fetchAllowedText } from '@/lib/slash-command-reconcile/fetch';
import {
  fetchClaudeCommands,
  CLAUDE_COMMANDS_DOC_URL,
} from '@/lib/slash-command-reconcile/providers/claude';
import { fetchCodexCommands, codexEnumRawUrl } from '@/lib/slash-command-reconcile/providers/codex';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('isAllowedReconcileUrl', () => {
  it('allows the pinned claude docs, codex raw prefix, and codex releases API', () => {
    expect(isAllowedReconcileUrl(CLAUDE_COMMANDS_DOC_URL)).toBe(true);
    expect(isAllowedReconcileUrl(codexEnumRawUrl('rust-v0.145.0'))).toBe(true);
    expect(
      isAllowedReconcileUrl('https://api.github.com/repos/openai/codex/releases/latest')
    ).toBe(true);
  });

  it('rejects http, look-alike hosts, and unrelated hosts', () => {
    expect(isAllowedReconcileUrl('http://code.claude.com/docs/en/commands.md')).toBe(false);
    expect(
      isAllowedReconcileUrl('https://raw.githubusercontent.com.evil.example/openai/codex/x')
    ).toBe(false);
    expect(isAllowedReconcileUrl('https://evil.example/openai/codex/x')).toBe(false);
    expect(isAllowedReconcileUrl('not a url')).toBe(false);
  });
});

describe('fetchAllowedText', () => {
  it('never calls fetch for a disallowed URL', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchAllowedText('https://evil.example/x', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns the body on a 2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('hello', { status: 200 }));
    const result = await fetchAllowedText(CLAUDE_COMMANDS_DOC_URL, { fetchImpl });
    expect(result).toEqual({ ok: true, text: 'hello' });
  });

  it('fails soft on a non-2xx status', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    const result = await fetchAllowedText(CLAUDE_COMMANDS_DOC_URL, { fetchImpl });
    expect(result.ok).toBe(false);
  });

  it('fails soft when fetch throws (network error / abort)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('aborted');
    });
    const result = await fetchAllowedText(CLAUDE_COMMANDS_DOC_URL, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning).toContain('aborted');
  });

  it('rejects an oversized body by declared content-length', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('x', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } })
    );
    const result = await fetchAllowedText(CLAUDE_COMMANDS_DOC_URL, { fetchImpl });
    expect(result.ok).toBe(false);
  });

  it('rejects an oversized body by actual bytes read', async () => {
    const big = 'x'.repeat(1024);
    const fetchImpl = vi.fn(async () => new Response(big, { status: 200 }));
    const result = await fetchAllowedText(CLAUDE_COMMANDS_DOC_URL, { fetchImpl, maxBytes: 100 });
    expect(result.ok).toBe(false);
  });
});

describe('provider fetch fail-soft', () => {
  it('fetchClaudeCommands returns ok:false when the docs are unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    const result = await fetchClaudeCommands({ fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.commands).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('fetchClaudeCommands returns ok:false when parsing yields zero commands', async () => {
    const fetchImpl = vi.fn(async () => new Response('# No table here', { status: 200 }));
    const result = await fetchClaudeCommands({ fetchImpl });
    expect(result.ok).toBe(false);
  });

  it('fetchCodexCommands fails soft when the raw enum is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    const result = await fetchCodexCommands({ ref: 'rust-v0.145.0', fetchImpl });
    expect(result.ok).toBe(false);
  });

  it('fetchCodexCommands parses and stamps sourceVersion on success', async () => {
    const rust = `
#[strum(serialize_all = "kebab-case")]
pub enum SlashCommand {
    Model,
}
impl SlashCommand {
    pub fn description(self) -> &'static str {
        match self {
            SlashCommand::Model => "choose a model",
        }
    }
}
`;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(codexEnumRawUrl('rust-v0.145.0'));
      return new Response(rust, { status: 200 });
    });
    const result = await fetchCodexCommands({ ref: 'rust-v0.145.0', fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.sourceVersion).toBe('0.145.0');
    expect(result.commands.map((c) => c.name)).toEqual(['model']);
  });

  it('fetchCodexCommands resolves the latest tag when no ref is given', async () => {
    const rust = `
#[strum(serialize_all = "kebab-case")]
pub enum SlashCommand { New, }
impl SlashCommand {
    pub fn description(self) -> &'static str {
        match self { SlashCommand::New => "start a new chat", }
    }
}
`;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('releases/latest')) return jsonResponse({ tag_name: 'rust-v0.150.0' });
      return new Response(rust, { status: 200 });
    });
    const result = await fetchCodexCommands({ fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.sourceVersion).toBe('0.150.0');
  });
});
