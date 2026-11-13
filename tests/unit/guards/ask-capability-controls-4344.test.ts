/**
 * A tool's ask capability is true only with its controls in place (Issue #4344,
 * design `docs/design/ask-attribution-4344.md` §0.1).
 *
 * `ASK_ATTRIBUTION_TOOLS` is what `GET /api/asks/capabilities` publishes and the
 * send route stamps envelopes by. Turning a tool on is a claim that its
 * transcript reader binds the enveloped input to the completed turn and holds
 * M1〜M6 — so each `true` row needs the adapter's control file
 * (`tests/unit/hooks/sources/<tool>-ask-attribution-4344.test.ts`), and that file
 * has to name every M case.
 *
 * H5 (§0.1 版の判定): each `true` tool has a minimum version, and its control
 * fixtures (`tests/fixtures/<tool>-ask-attribution-4344/`) are records of that
 * version or later whose assistant records all carry `stop_reason`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ASK_ATTRIBUTION_MIN_VERSIONS, ASK_ATTRIBUTION_TOOLS, versionAtLeast } from '@/lib/ask/ask-correlation';

const M_CASES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'] as const;

/** M4 (command bodies) is the send side's, pinned in the route's and the envelope's controls. */
const M4_CONTROLS = ['tests/unit/app/api/worktrees/send-ask-4344.test.ts', 'tests/unit/lib/ask/envelope-4344.test.ts'];

const enabled = Object.entries(ASK_ATTRIBUTION_TOOLS).filter(([, on]) => on).map(([tool]) => tool);

describe('ask capability controls (Issue #4344)', () => {
  it('claude is the first tool on (PR1), and only it', () => {
    expect(enabled).toEqual(['claude']);
  });

  it.each(enabled)('%s has its adapter control file naming M1, M2, M3, M5 and M6', (tool) => {
    const file = join(process.cwd(), 'tests/unit/hooks/sources', `${tool}-ask-attribution-4344.test.ts`);
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    for (const name of M_CASES.filter((m) => m !== 'M4')) {
      // A case is named when a test title starts with it: it('M1 …') / ['M3 …', …].
      expect(text, `${tool}: ${name}`).toMatch(new RegExp(`['"\`]${name} `));
    }
  });

  it('M4 is pinned on the send side', () => {
    for (const path of M4_CONTROLS) {
      expect(readFileSync(join(process.cwd(), path), 'utf8')).toMatch(/M4/);
    }
  });

  it.each(enabled)('%s has a minimum version, and its control fixtures are at least that version with stop_reason on every assistant record (H5)', (tool) => {
    const minimum = (ASK_ATTRIBUTION_MIN_VERSIONS as Record<string, string | undefined>)[tool];
    expect(minimum, `${tool}: minimum version`).toBeDefined();
    const dir = join(process.cwd(), 'tests/fixtures', `${tool}-ask-attribution-4344`);
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n').filter((l) => l.trim())) {
        const record = JSON.parse(line) as { type: string; version?: string; message?: { stop_reason?: string } };
        if (record.type === 'user' || record.type === 'assistant') {
          expect(record.version && versionAtLeast(record.version, minimum!), `${name}: version ${record.version}`).toBe(true);
        }
        if (record.type === 'assistant') expect(record.message?.stop_reason, `${name}: stop_reason`).toBeTruthy();
      }
    }
  });
});
