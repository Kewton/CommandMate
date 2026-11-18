/**
 * Issue #4452: nothing the user did not aim at antigravity may start `agy`.
 *
 * Before this Issue the agents version list (`GET /api/agents/versions`, the
 * settings card and the agent pane, and `GET /api/asks/capabilities` through the
 * same fan-out) and the slash-command catalog's staleness probe ran
 * `agy --version` next to `claude --version` / `codex --version` on the first
 * request after every server start. The rule now: antigravity's version is read
 * only with the usage declaration (`CM_ANTIGRAVITY_USAGE=api-key|enterprise`) or
 * after antigravity was used in this process (a launch or a send).
 *
 * Every probe here is a real child process, but of a FAKE binary: `PATH` holds
 * only a private directory whose `agy` / `claude` / `codex` are shell scripts
 * that append their argv to a calls log, and `HOME` is a private directory too.
 * The real agy is never run and `~/.gemini` is never read (I4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NextRequest } from 'next/server';
import { clearAgentVersionsCache, getAgentVersions } from '@/lib/updates/agent-versions';
import { clearCatalogCache, getCatalogStaleness } from '@/lib/slash-command-catalog';
import { GET as getVersionsRoute } from '@/app/api/agents/versions/route';

const FAKE_BANNERS: Record<string, string> = {
  agy: '1.1.18',
  claude: '2.1.0 (Claude Code)',
  codex: 'codex-cli 0.100.0',
};

const SAVED_KEYS = ['PATH', 'HOME', 'CM_ANTIGRAVITY_USAGE'] as const;

let root: string;
let logPath: string;
let saved: Record<string, string | undefined>;

/** Every recorded call of one fake binary, as `"<name> <argv>"` lines. */
function callsOf(name: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.split(' ')[0] === name);
}

async function resetUse(): Promise<void> {
  // The use flag does not exist before the fix; a missing module is "never used".
  try {
    const gate = await import('@/lib/tool-policy/version-probe-gate');
    gate.resetAntigravityUseForTest();
  } catch {
    // pre-fix: nothing to reset
  }
}

beforeEach(async () => {
  saved = {};
  for (const key of SAVED_KEYS) saved[key] = process.env[key];

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4452-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  logPath = path.join(root, 'calls.log');
  for (const [name, banner] of Object.entries(FAKE_BANNERS)) {
    const script = path.join(bin, name);
    fs.writeFileSync(
      script,
      `#!/bin/sh\necho "${name} $*" >> '${logPath}'\necho '${banner}'\n`,
      { mode: 0o755 }
    );
  }

  process.env.PATH = bin;
  process.env.HOME = home;
  delete process.env.CM_ANTIGRAVITY_USAGE;

  clearAgentVersionsCache();
  clearCatalogCache();
  await resetUse();
});

afterEach(async () => {
  for (const key of SAVED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearAgentVersionsCache();
  clearCatalogCache();
  await resetUse();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('[#4452] agents version list (lib/updates/agent-versions)', () => {
  it('4452: without the declaration, agy is started 0 times and antigravity has no row', async () => {
    const rows = await getAgentVersions({ force: true });

    expect(callsOf('agy')).toEqual([]);
    expect(rows.find((row) => row.tool === 'antigravity')).toBeUndefined();
  });

  it('4452 (I2): claude and codex are still probed once each with `--version`', async () => {
    const rows = await getAgentVersions({ force: true });

    expect(callsOf('claude')).toEqual(['claude --version']);
    expect(callsOf('codex')).toEqual(['codex --version']);
    expect(rows.find((row) => row.tool === 'claude')?.installed).toBe('2.1.0');
    expect(rows.find((row) => row.tool === 'codex')?.installed).toBe('0.100.0');
  });

  it.each(['api-key', 'enterprise'])(
    '4452 (I3): with CM_ANTIGRAVITY_USAGE=%s the antigravity version is returned',
    async (declaration) => {
      process.env.CM_ANTIGRAVITY_USAGE = declaration;
      const rows = await getAgentVersions({ force: true });

      expect(callsOf('agy')).toEqual(['agy --version']);
      expect(rows.find((row) => row.tool === 'antigravity')?.installed).toBe('1.1.18');
    }
  );

  it('4452: a declaration that is not one of the accepted values withholds the probe', async () => {
    process.env.CM_ANTIGRAVITY_USAGE = 'personal';
    await getAgentVersions({ force: true });
    expect(callsOf('agy')).toEqual([]);
  });

  it('4452 (I3): after antigravity is used in this process, its version is returned', async () => {
    const gate = await import('@/lib/tool-policy/version-probe-gate');
    gate.noteAntigravityUse();

    const rows = await getAgentVersions({ force: true });

    expect(callsOf('agy')).toEqual(['agy --version']);
    expect(rows.find((row) => row.tool === 'antigravity')?.installed).toBe('1.1.18');
  });
});

describe('[#4452] GET /api/agents/versions', () => {
  const request = { nextUrl: { searchParams: new URLSearchParams() } } as unknown as NextRequest;

  it('4452: without the declaration, the route starts agy 0 times', async () => {
    const response = await getVersionsRoute(request);
    const body = (await response.json()) as { tools: { tool: string }[] };

    expect(response.status).toBe(200);
    expect(callsOf('agy')).toEqual([]);
    expect(body.tools.map((row) => row.tool)).not.toContain('antigravity');
    expect(callsOf('claude')).toEqual(['claude --version']);
    expect(callsOf('codex')).toEqual(['codex --version']);
  });

  it('4452 (I3): with the declaration, the route returns the antigravity version', async () => {
    process.env.CM_ANTIGRAVITY_USAGE = 'api-key';
    const response = await getVersionsRoute(request);
    const body = (await response.json()) as { tools: { tool: string; installed: string | null }[] };

    expect(body.tools.find((row) => row.tool === 'antigravity')?.installed).toBe('1.1.18');
    expect(callsOf('agy')).toEqual(['agy --version']);
  });
});

describe('[#4452] slash-command catalog staleness (lib/slash-command-catalog)', () => {
  it('4452: without the declaration, the catalog probe starts agy 0 times', async () => {
    const staleness = await getCatalogStaleness();

    expect(callsOf('agy')).toEqual([]);
    expect(staleness.antigravity).toBeUndefined();
  });

  it('4452 (I2): claude and codex are still probed once each with `--version`', async () => {
    const staleness = await getCatalogStaleness();

    expect(callsOf('claude')).toEqual(['claude --version']);
    expect(callsOf('codex')).toEqual(['codex --version']);
    expect(staleness.claude?.current).toBe('2.1.0');
    expect(staleness.codex?.current).toBe('0.100.0');
  });

  it('4452 (I3): with the declaration, the antigravity version is returned', async () => {
    process.env.CM_ANTIGRAVITY_USAGE = 'enterprise';
    const staleness = await getCatalogStaleness();

    expect(callsOf('agy')).toEqual(['agy --version']);
    expect(staleness.antigravity?.current).toBe('1.1.18');
  });

  it('4452 (I3): a use after the cache was filled adds antigravity without re-probing the others', async () => {
    await getCatalogStaleness();
    expect(callsOf('agy')).toEqual([]);

    const gate = await import('@/lib/tool-policy/version-probe-gate');
    gate.noteAntigravityUse();
    const staleness = await getCatalogStaleness();

    expect(callsOf('agy')).toEqual(['agy --version']);
    expect(staleness.antigravity?.current).toBe('1.1.18');
    // I2: claude and codex were not asked a second time.
    expect(callsOf('claude')).toEqual(['claude --version']);
    expect(callsOf('codex')).toEqual(['codex --version']);
  });
});

describe('[#4452] server startup', () => {
  // The server's own start sequence runs no version probe at all: the calls the
  // acceptance run recorded "at every start" came from the first requests after
  // it (the routes above). Pinned so a startup warm-up cannot bring it back.
  it('4452: server.ts imports none of the version probes', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    for (const probeModule of [
      'updates/agent-versions',
      'slash-command-catalog',
      'detection/version-probes',
      'cli-tools/antigravity',
    ]) {
      expect(source, probeModule).not.toContain(probeModule);
    }
  });
});
