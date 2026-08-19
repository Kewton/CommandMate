/**
 * stills.ts — the byte budget and the privacy sweep (Issue #1810).
 *
 * These are the two rules that decide whether a screenshot may be published at
 * all, and both used to be human habits: #1225 could not reproduce the gallery
 * because nobody knew where it came from, and #1272 withdrew the whole demo set
 * because six private repository names and a retired product name were visible
 * in it. Neither is testable through a browser, and both are pure functions
 * here for exactly that reason.
 *
 * Importing the script from here is also what puts it under `npx tsc --noEmit`:
 * `.claude/**` is outside the root tsconfig `include` (Issue #1265).
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BUDGET_BYTES,
  QUALITY_LADDER,
  SCALE_LADDER,
  STILLS,
  WIDE_BUDGET_BYTES,
  cwebpArgs,
  encodeLadder,
  findLeaks,
  fitToBudget,
  parseStillsArgs,
  selectedStills,
  writeWebpWithinBudget,
  type EncodeAttempt,
  type WebpDeps,
} from '../../../../.claude/skills/demo-video/scripts/stills';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('STILLS', () => {
  it('names the five files the LP and the README already reference', () => {
    // The names are load-bearing: website/index.html and the docs point at
    // them, and landing-page.test.ts pins the hero by path.
    expect(STILLS.map((still) => still.id)).toEqual([
      'screenshot-desktop',
      'screenshot-worktree-desktop',
      'screenshot-mobile',
      'screenshot-worktree-mobile',
      'screenshot-worktree-mobile-terminal',
    ]);
  });

  it('shoots the desktop pair at 2x and the phone trio at 3x', () => {
    for (const still of STILLS) {
      const phone = still.viewport.width < 768;
      expect(still.deviceScaleFactor, still.id).toBe(phone ? 3 : 2);
    }
  });

  it('holds every still to the hero budget except the wide worktree shot', () => {
    // `website/assets/media/README.md` documents exactly this exception, and
    // `landing-page.test.ts` enforces the hero's 100KB independently.
    for (const still of STILLS) {
      const expected =
        still.id === 'screenshot-worktree-desktop' ? WIDE_BUDGET_BYTES : DEFAULT_BUDGET_BYTES;
      expect(still.budgetBytes, still.id).toBe(expected);
    }
    expect(DEFAULT_BUDGET_BYTES).toBe(100_000);
  });

  it('writes every still to both published locations', () => {
    const options = parseStillsArgs([], {});
    expect(options.pngDir).toBe(path.join(REPO_ROOT, 'docs/images'));
    expect(options.webpDir).toBe(path.join(REPO_ROOT, 'website/assets/img'));
  });
});

describe('parseStillsArgs', () => {
  it('defaults to the English UI, which is what the LP publishes', () => {
    expect(parseStillsArgs([], {}).locale).toBe('en');
  });

  it('takes the worktree id from the environment env-up.sh writes', () => {
    expect(parseStillsArgs([], { CM_DEMO_WORKTREE_ID: 'wt-dark-mode' }).worktreeId).toBe(
      'wt-dark-mode',
    );
  });

  it('selects individual stills by id', () => {
    const options = parseStillsArgs(['--still', 'screenshot-mobile'], {});
    expect(selectedStills(options).map((s) => s.id)).toEqual(['screenshot-mobile']);
  });

  it('films everything when nothing is selected', () => {
    expect(selectedStills(parseStillsArgs([], {}))).toHaveLength(STILLS.length);
  });

  it.each([
    [['--still', 'nope'], /unknown still\(s\): nope/],
    [['--locale', 'fr'], /--locale must be one of ja\|en/],
    [['--theme', 'sepia'], /--theme must be light or dark/],
    [['--state'], /--state needs a value/],
    [['--nope'], /unknown argument/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseStillsArgs(argv, {})).toThrow(message);
  });
});

describe('findLeaks', () => {
  it('finds a home directory, whichever platform spelled it', () => {
    expect(findLeaks('cloned into /Users/someone/work/private-repo')).toContain('/Users/someone');
    expect(findLeaks('/home/dev/src')).toContain('/home/dev');
    expect(findLeaks('C:\\Users\\dev\\src')).toContain('C:\\Users\\dev');
  });

  it('finds a private LAN address, which is how #1272 leaked a machine', () => {
    expect(findLeaks('http://192.168.1.42:3000/')).toContain('192.168.1.42');
    expect(findLeaks('10.0.1.7')).toContain('10.0.1.7');
    expect(findLeaks('172.20.3.4')).toContain('172.20.3.4');
  });

  it('finds the retired product name, which dates the whole gallery', () => {
    expect(findLeaks('MyCodeBranchDesk')).toEqual(['MyCodeBranchDesk']);
  });

  it('finds a caller-supplied literal, which is how the host repo is excluded', () => {
    expect(findLeaks('branch: commandmate-issue-1810', ['commandmate-issue-1810'])).toEqual([
      'commandmate-issue-1810',
    ]);
  });

  it('passes the seed the isolated environment actually shows', () => {
    // The whole point of shooting inside env-up.sh: the only repository on
    // screen is the throwaway one, and its names are safe to publish.
    expect(
      findLeaks('cmdemo-app / wt-dark-mode / feature/demo-dark-mode — 127.0.0.1:3399'),
    ).toEqual([]);
  });

  it('does not mistake a version number for a LAN address', () => {
    expect(findLeaks('CommandMate v0.24.0, Node.js 22.10.0')).toEqual([]);
  });

  it('reports each leak once, however often it appears', () => {
    expect(findLeaks('/Users/dev/a /Users/dev/b')).toEqual(['/Users/dev']);
  });
});

describe('encodeLadder', () => {
  it('exhausts quality before it touches resolution', () => {
    // Quality costs detail nobody misses on flat UI; resolution costs the
    // legibility of the very text a screenshot exists to show.
    const ladder = encodeLadder();
    expect(ladder.slice(0, QUALITY_LADDER.length).every((a) => a.scale === 1)).toBe(true);
    expect(ladder[QUALITY_LADDER.length].scale).toBe(SCALE_LADDER[1]);
    expect(ladder).toHaveLength(QUALITY_LADDER.length * SCALE_LADDER.length);
  });

  it('starts at the quality the manual procedure used', () => {
    // `website/assets/media/README.md` documented `cwebp -q 82`; the first rung
    // reproduces the existing gallery byte for byte.
    expect(ladder0().quality).toBe(82);
    expect(ladder0().scale).toBe(1);
  });

  const ladder0 = (): EncodeAttempt => encodeLadder()[0];
});

describe('fitToBudget', () => {
  it('takes the first rung that fits, and stops there', () => {
    const seen: number[] = [];
    const result = fitToBudget(
      encodeLadder(),
      (attempt) => {
        seen.push(attempt.quality);
        return attempt.quality >= 76 ? 120_000 : 90_000;
      },
      100_000,
    );
    expect(result).toEqual({ attempt: { quality: 70, scale: 1 }, bytes: 90_000 });
    expect(seen).toEqual([82, 76, 70]);
  });

  it('treats the budget as exclusive, matching the test that enforces it', () => {
    // `landing-page.test.ts` asserts `toBeLessThan(100_000)`, so exactly
    // 100_000 is a failure there and must be one here.
    expect(fitToBudget([{ quality: 82, scale: 1 }], () => 100_000, 100_000)).toBeNull();
    expect(fitToBudget([{ quality: 82, scale: 1 }], () => 99_999, 100_000)).not.toBeNull();
  });

  it('returns null when the whole ladder is over budget', () => {
    expect(fitToBudget(encodeLadder(), () => 999_999, 100_000)).toBeNull();
  });
});

describe('writeWebpWithinBudget', () => {
  const deps = (sizes: (attempt: EncodeAttempt) => number): WebpDeps & { removed: string[] } => {
    const removed: string[] = [];
    return {
      encode: (attempt) => sizes(attempt),
      remove: (file) => {
        removed.push(file);
      },
      removed,
    };
  };

  it('writes at the best rung that fits', () => {
    const d = deps((attempt) => (attempt.quality > 62 ? 200_000 : 80_000));
    const result = writeWebpWithinBudget('/in.png', '/out.webp', 100_000, d);
    expect(result.attempt.quality).toBe(62);
    expect(d.removed).toEqual([]);
  });

  it('writes nothing and fails when nothing fits', () => {
    // The `video-to-gif` discipline. An over-budget hero quietly committed
    // turns into a red landing-page.test.ts for whoever next touches the LP,
    // with nothing pointing back here.
    const d = deps(() => 400_000);
    expect(() => writeWebpWithinBudget('/in.png', '/out.webp', 100_000, d)).toThrow(
      /does not fit in 100000 bytes.*nothing was written/s,
    );
    // cwebp leaves its last attempt on disk, and that attempt is by definition
    // the over-budget one.
    expect(d.removed).toEqual(['/out.webp']);
  });
});

describe('cwebpArgs', () => {
  it('encodes at the requested quality and leaves the size alone at scale 1', () => {
    expect(cwebpArgs({ quality: 82, scale: 1 }, '/a.png', '/a.webp', 2560)).toEqual([
      '-quiet', '-q', '82', '/a.png', '-o', '/a.webp',
    ]);
  });

  it('resizes by width, letting cwebp derive the height', () => {
    // `-resize W 0` keeps the aspect ratio; naming both would round the height
    // independently and shear the image by a pixel.
    expect(cwebpArgs({ quality: 70, scale: 0.8 }, '/a.png', '/a.webp', 2560)).toEqual([
      '-quiet', '-q', '70', '-resize', '2048', '0', '/a.png', '-o', '/a.webp',
    ]);
  });
});

describe('the published gallery is inside its budget right now', () => {
  const webpDir = path.join(REPO_ROOT, 'website/assets/img');

  it.each(STILLS.map((still) => [still.id, still.budgetBytes] as const))(
    '%s.webp is under %i bytes',
    (id, budget) => {
      const file = path.join(webpDir, `${id}.webp`);
      expect(fs.existsSync(file), file).toBe(true);
      expect(fs.statSync(file).size).toBeLessThan(budget);
    },
  );

  it.each(STILLS.map((still) => still.id))('%s.png exists for the docs to reference', (id) => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'docs/images', `${id}.png`))).toBe(true);
  });
});

describe('the still capture is wired to the isolated environment', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, '.claude/skills/demo-video/scripts/stills.ts'),
    'utf8',
  );

  it('reads its base URL from state.env, which refuses port 3000', () => {
    expect(source).toContain('parseStateFile');
  });

  it('sweeps every shot before it is written, not after', () => {
    const assertAt = source.indexOf('assertNothingPrivateOnScreen');
    const shotAt = source.indexOf('page.screenshot(');
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(shotAt);
  });

  it('excludes this repository’s own name from every shot', () => {
    expect(source).toContain('path.basename(requested.repoRoot)');
  });
});

describe('mutation control: the budget gate is not vacuous', () => {
  it('fails a hero-sized image that cannot be squeezed under 100KB', () => {
    // The control for the whole budget mechanism: if `fitToBudget` were
    // rewritten to return its last attempt instead of null, this is the
    // assertion that turns red.
    const encode = vi.fn().mockReturnValue(150_000);
    expect(fitToBudget(encodeLadder(), encode, DEFAULT_BUDGET_BYTES)).toBeNull();
    expect(encode).toHaveBeenCalledTimes(encodeLadder().length);
  });
});
