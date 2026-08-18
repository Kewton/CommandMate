/**
 * render-overlays.ts — telop/card PNG planning and the HTML templates (#1554).
 *
 * The screenshot itself needs a browser and belongs to the dogfood run, not to
 * `npm run test:unit`. What is pinned here is everything that can silently go
 * wrong without a browser: which PNG each scene expects, and the two template
 * invariants that would only show up as a wrong-looking video — an external
 * font request that fails offline, and a missing injection target.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  TEXT_SELECTOR,
  overlayJobs,
  overlayKind,
  parseRenderArgs,
  templatePath,
} from '../../../../.claude/skills/demo-video/scripts/render-overlays';
import {
  DEFAULT_STORYBOARD_PATH,
  buildPlan,
  parseStoryboard,
} from '../../../../.claude/skills/demo-video/scripts/storyboard';

const STORYBOARD = parseStoryboard(fs.readFileSync(DEFAULT_STORYBOARD_PATH, 'utf8')).storyboard!;
const FRAME = { width: 1280, height: 800 };

describe('overlayJobs', () => {
  const jobs = overlayJobs(buildPlan(STORYBOARD, 'ja'), {
    storyboardPath: DEFAULT_STORYBOARD_PATH,
    outDir: '/tmp/overlays',
    locale: 'ja',
    frame: FRAME,
  });

  it('produces exactly one PNG per scene', () => {
    expect(jobs).toHaveLength(STORYBOARD.scenes.length);
    expect(jobs.map((job) => job.sceneId)).toEqual(STORYBOARD.scenes.map((scene) => scene.id));
  });

  it('names the files compose.sh goes looking for', () => {
    // compose.sh derives these paths independently. A rename on either side
    // shows up here rather than as "missing telop image" mid-take.
    expect(jobs.map((job) => path.basename(job.file))).toEqual([
      'card-title.ja.png',
      'telop-sessions-overview.ja.png',
      'telop-send-and-generate.ja.png',
      'telop-respond-from-mobile.ja.png',
      'telop-complete.ja.png',
      'card-outro.ja.png',
    ]);
  });

  it('keeps the two locales in separate files', () => {
    const en = overlayJobs(buildPlan(STORYBOARD, 'en'), {
      storyboardPath: DEFAULT_STORYBOARD_PATH,
      outDir: '/tmp/overlays',
      locale: 'en',
      frame: FRAME,
    });
    expect(en.map((job) => job.file)).not.toEqual(jobs.map((job) => job.file));
    expect(en[1].text).toBe('All your agents at a glance');
    expect(jobs[1].text).toBe('複数エージェントの状態をひと目で');
  });

  it('renders the mobile scene telop at the output frame size, not the phone size', () => {
    // The mobile take is letterboxed into the 1280x800 frame by compose.sh, so
    // a band sized to 390x844 would be composited into the wrong place.
    const mobile = jobs.find((job) => job.sceneId === 'respond-from-mobile')!;
    expect(mobile.width).toBe(FRAME.width);
    expect(mobile.height).toBe(FRAME.height);
  });

  it('draws cards as full frames and telops as bands', () => {
    expect(jobs.filter((job) => job.kind === 'card').map((job) => job.sceneId)).toEqual([
      'title',
      'outro',
    ]);
  });
});

describe('parseRenderArgs', () => {
  it('requires an output directory', () => {
    expect(() => parseRenderArgs([])).toThrow(/--out is required/);
  });

  it.each([
    [['--out', '/tmp/x', '--locale', 'fr'], /--locale must be one of ja\|en/],
    [['--out', '/tmp/x', '--frame', '1280'], /--frame must look like/],
    [['--out'], /--out needs a value/],
    [['--out', '/tmp/x', '--nope'], /unknown argument/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseRenderArgs(argv)).toThrow(message);
  });

  it('defaults to the committed storyboard at the recording frame size', () => {
    const options = parseRenderArgs(['--out', '/tmp/x']);
    expect(options.storyboardPath).toBe(DEFAULT_STORYBOARD_PATH);
    expect(options.frame).toEqual(FRAME);
    expect(options.locale).toBe('ja');
  });
});

describe('templates', () => {
  const templates = (['telop', 'card', 'code'] as const).map((kind) => ({
    kind,
    file: templatePath(kind),
    html: fs.readFileSync(templatePath(kind), 'utf8'),
  }));

  it('all three exist where render-overlays.ts looks for them', () => {
    expect(templates).toHaveLength(3);
    for (const template of templates) expect(fs.existsSync(template.file)).toBe(true);
  });

  it('reads the code card from code-card.html, not from code.html', () => {
    expect(path.basename(templatePath('code'))).toBe('code-card.html');
  });

  it.each(templates)('$kind.html carries the element the renderer injects into', ({ kind, html }) => {
    expect(html).toContain(`id="${TEXT_SELECTOR[kind].slice(1)}"`);
  });

  it('the code template carries the listing container and its syntax label', () => {
    const code = templates.find((template) => template.kind === 'code')!;
    expect(code.html).toContain('id="code-body"');
    expect(code.html).toContain('id="code-lang"');
  });

  it('the code template does not wrap, so a listing cannot be re-flowed', () => {
    // storyboard.ts refuses an over-wide source line rather than letting the
    // card wrap one: a wrapped YAML key reads as a different document.
    const code = templates.find((template) => template.kind === 'code')!;
    expect(code.html).toMatch(/white-space:\s*pre/);
  });

  it.each(templates)('$kind.html requests nothing over the network', ({ html }) => {
    // A webfont or CDN stylesheet would fail silently offline and change the
    // line width between the ja and en passes — a difference nobody would
    // attribute to the template.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/<(script|link|img)\b/i);
  });

  it.each(templates)('$kind.html names a Japanese-capable system font', ({ html }) => {
    expect(html).toMatch(/Hiragino Sans|Noto Sans JP|Yu Gothic/);
  });

  it('the telop template does not paint its own background', () => {
    // `omitBackground: true` only produces a transparent PNG if the page itself
    // is transparent; an opaque body would cover the footage entirely.
    const telop = templates.find((template) => template.kind === 'telop')!;
    expect(telop.html).toMatch(/background:\s*transparent/);
  });

  it('the network guard is not vacuous', () => {
    // A typo in the patterns above would let every template pass regardless.
    const offending = '<link rel="stylesheet" href="https://fonts.example/x.css" />';
    expect(offending).toMatch(/https?:\/\//);
    expect(offending).toMatch(/<(script|link|img)\b/i);
  });
});


/**
 * `type: code` overlays (Issue #1810). The card is a still like `card`, so the
 * only thing that can silently go wrong without a browser is which file the
 * renderer reads and which PNG compose.sh then goes looking for.
 */
describe('code overlays', () => {
  const file = path.resolve(
    __dirname,
    '../../../../.claude/skills/demo-video/storyboard/contract-verify.yaml',
  );
  const board = parseStoryboard(fs.readFileSync(file, 'utf8'), undefined, path.dirname(file))
    .storyboard!;
  const jobs = overlayJobs(buildPlan(board, 'ja'), {
    storyboardPath: file,
    outDir: '/tmp/overlays',
    locale: 'ja',
    frame: FRAME,
  });

  it('gives a code scene its own PNG prefix, which is how compose.sh finds it', () => {
    expect(overlayKind('code')).toBe('code');
    expect(jobs.map((job) => path.basename(job.file))).toEqual([
      'card-title.ja.png',
      'code-contract-yaml.ja.png',
      'code-verify-yaml.ja.png',
      'telop-contract-verify.ja.png',
      'card-outro.ja.png',
    ]);
  });

  it('loads the listing off disk, and the telop stays the caption', () => {
    const job = jobs.find((j) => j.sceneId === 'contract-yaml')!;
    expect(job.code).toContain('scope:');
    expect(job.code).toContain('requireWorkEvidence: true');
    expect(job.code!.endsWith('\n')).toBe(false);
    expect(job.lang).toBe('yaml');
    expect(job.text).toBe('契約つきで送信する');
  });

  it('carries no listing on a scene that is not code', () => {
    expect(jobs.find((j) => j.sceneId === 'title')!.code).toBeUndefined();
    expect(jobs.find((j) => j.sceneId === 'contract-verify')!.code).toBeUndefined();
  });

  it('refuses to render a code row the plan gave no source', () => {
    // Unreachable through the validator; kept so a hand-built plan fails loudly
    // rather than rendering an empty card that looks deliberate.
    expect(() =>
      overlayJobs(
        [
          {
            id: 'x',
            type: 'code',
            viewport: 'pc',
            startSec: 0,
            durationSec: 1,
            endSec: 1,
            telop: 'a',
          },
        ],
        { storyboardPath: file, outDir: '/tmp/overlays', locale: 'ja', frame: FRAME },
      ),
    ).toThrow(/no sourcePath in the plan/);
  });
});
