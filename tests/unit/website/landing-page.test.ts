/**
 * Issue #1200 — GitHub Pages landing page.
 *
 * The LP is plain HTML/CSS/JS with no build step, so these tests are the only
 * automated gate on it. They encode the Issue's machine-verifiable acceptance
 * criteria: the page must resolve every asset it references relative to
 * `website/`, must ship nothing that needs compiling, and must respect the
 * media budget that keeps the hero's LCP defensible.
 *
 * Issue #1272 removed the demo videos and pinned the hero/og:image to an
 * isolated-environment screenshot; Issue #1577 put four vetted demos back and
 * recast those guards around where media comes from rather than what container
 * it is in. Both live in the `Issue #1272/#1577` block below.
 *
 * Issue #1812 rebuilt the page on the Vibe Engineering axis. Two things moved
 * here as a result. The hero is now an inline SVG of the loop rather than a
 * screenshot, so the guard that kept the screenshot eager became a guard on the
 * drawing being an image to a screen reader and taking its colours from the
 * page's custom properties — the screenshot's own budget survives untouched
 * because it is still the og:image. And the wording is no longer free text: it
 * is copied from `docs/design/public-messaging.md`, so the retired vocabulary is
 * asserted absent from everything Pages serves.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WEBSITE_DIR = path.join(REPO_ROOT, 'website');
const INDEX_HTML = path.join(WEBSITE_DIR, 'index.html');
const STYLES_CSS = path.join(WEBSITE_DIR, 'styles.css');
const MESSAGING_DOC = path.join(REPO_ROOT, 'docs/design/public-messaging.md');

/**
 * The social preview image carries a budget. It used to be the hero as well, so
 * it was also the LCP element; #1812 made the hero a drawing and moved this
 * screenshot to the head of the gallery. The budget stays because the reason it
 * existed did not change: this is the file that expands as a preview card every
 * time the page is linked, and a 500KB card is a slow card.
 */
const HERO_BUDGET_BYTES = 100_000;
const OG_IMAGE = 'assets/img/screenshot-desktop.webp';
const PAGES_BASE_URL = 'https://kewton.github.io/CommandMate/';

/** The LP's own source, i.e. everything Pages actually serves as the page. */
const LP_SOURCE_FILES = ['index.html', 'styles.css', 'main.js'];

/** Everything under website/ a human reads, as opposed to the media bytes. */
const TEXT_FILE = /\.(html|css|js|md|json|svg|txt)$/i;

/** The single reviewed location for anything that moves. */
const MEDIA_DIR = path.join('assets', 'media');

/**
 * Every container a moving image can arrive in. #1272's guard listed video
 * extensions only, which is why a GIF re-encode of the same tainted recording
 * would have walked straight through it — `docs/images/demo-mobile.gif` still
 * exists next to the mp4 it was made from.
 */
const MOVING_IMAGE = /\.(mp4|webm|mov|m4v|ogv|gif|apng)$/i;

/**
 * The only files the LP may ship under `assets/media/`. This is an allowlist
 * rather than a format rule because the property #1272 was defending is
 * provenance: the recording must have been made in an isolated environment.
 * No test can read that off the bytes, so adding a line here is the point at
 * which a human confirms it — see `website/assets/media/README.md`.
 */
const ALLOWED_MEDIA = [
  'README.md',
  'contract-verify.mp4',
  'install-skill.mp4',
  'never-miss-waiting.mp4',
  'parallel-worktrees.mp4',
  'poster-contract-verify.webp',
  'poster-install-skill.webp',
  'poster-never-miss-waiting.webp',
  'poster-parallel-worktrees.webp',
];

/**
 * The four demos, in page order, and the `docs/images/features/` take each one
 * is a byte-for-byte copy of. Named here rather than left implicit because the
 * copy is the whole provenance argument: a re-encode looks identical in the
 * markup and identical on screen, and only `cmp` against these sources tells
 * them apart (see `website/assets/media/README.md`).
 */
const DEMO_SOURCES: Record<string, string> = {
  'contract-verify.mp4': 'cm-11-contract-verify.en.mp4',
  'never-miss-waiting.mp4': 'cm-03-never-miss-waiting.en.mp4',
  'parallel-worktrees.mp4': 'cm-01-parallel-worktrees.en.mp4',
  'install-skill.mp4': 'cm-12-install-skill.en.mp4',
};

/** Every file under website/, recursively, as paths relative to website/. */
function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

function readIndexHtml(): string {
  return fs.readFileSync(INDEX_HTML, 'utf-8');
}

/**
 * The markup with every run of whitespace collapsed. Copy taken verbatim from
 * the messaging doc is re-wrapped by hand when it lands in HTML, so comparing
 * the raw file against a sentence would fail on indentation rather than on
 * wording — which is the opposite of what these assertions are for.
 */
function normalizedHtml(): string {
  return readIndexHtml().replace(/\s+/g, ' ');
}

/**
 * The en definition sentence, read out of `docs/design/public-messaging.md`
 * between its `<!-- def:en -->` markers. Read rather than restated: the point of
 * that file is that one string exists once, so a copy of it here would be the
 * second place it could drift.
 */
function definitionEn(): string {
  const doc = fs.readFileSync(MESSAGING_DOC, 'utf-8');
  const match = /<!-- def:en -->([\s\S]*?)<!-- \/def:en -->/.exec(doc);

  expect(
    match,
    'docs/design/public-messaging.md must delimit the en definition with <!-- def:en --> … <!-- /def:en -->',
  ).not.toBeNull();
  return match![1].trim();
}

/** The retired vocabulary, as `docs/design/public-messaging.md` publishes it. */
function documentedBannedTerms(): string[] {
  const doc = fs.readFileSync(MESSAGING_DOC, 'utf-8');
  const start = doc.indexOf('<!-- banned-terms:start -->');
  const end = doc.indexOf('<!-- banned-terms:end -->');

  expect(start, 'the banned-term table must be delimited').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  return doc
    .slice(start, end)
    .split('\n')
    .map((line) => /^\|\s*`([^`]+)`\s*\|/.exec(line)?.[1])
    .filter((term): term is string => Boolean(term));
}

/**
 * What Issue #1812 measured on this page before the rewrite and required gone.
 * These are shorter than some of the doc's rows on purpose — the old H1 is
 * banned as a whole sentence there, but the LP carried it split across a `<br>`
 * and rephrased in three meta tags, so the substring is what actually finds it.
 */
const LP_BANNED_TERMS = [
  'control plane',
  'Orchestrate your agent CLIs',
  'Remote Control',
  'Happy Coder',
  'claude-squad',
  'Omnara',
];

/** Every file under website/ a person reads, with its text. */
function textFiles(): { file: string; body: string }[] {
  return walk(WEBSITE_DIR)
    .filter((file) => TEXT_FILE.test(file))
    .map((file) => ({ file, body: fs.readFileSync(path.join(WEBSITE_DIR, file), 'utf-8') }));
}

/**
 * Pull every asset/link reference out of the markup. Deliberately regex-based:
 * adding an HTML parser would mean a new npm dependency, which the Issue forbids.
 */
function extractRefs(html: string): string[] {
  const refs: string[] = [];
  // `poster` is in here because a video's still is an asset like any other: it
  // 404s the same way, and it escapes website/ the same way.
  const pattern = /(?:src|href|poster)\s*=\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

const isExternal = (ref: string) =>
  /^(https?:)?\/\//.test(ref) || ref.startsWith('mailto:') || ref.startsWith('#');

interface CopyableBox {
  id: string;
  text: string;
  /** Marked `.install-url`: pasted into the CommandMate UI, not into a shell. */
  isUrl: boolean;
}

/**
 * Every `.install-cmd` box the page offers a working copy button for. A box only
 * counts if a `.copy-btn` actually targets its id — markup that renders a
 * command without wiring the button is what this catches.
 *
 * The class match is deliberately open-ended (`install-cmd[^"]*`): pinning it to
 * exactly `class="install-cmd"` meant any added modifier dropped the box out of
 * this sweep silently, which is a guard that passes by going blind.
 */
function copyableBoxes(html: string): CopyableBox[] {
  const targeted = new Set(
    Array.from(html.matchAll(/data-copy-target="([^"]+)"/g), (match) => match[1]),
  );

  return Array.from(html.matchAll(/<code class="(install-cmd[^"]*)" id="([^"]+)">([^<]+)<\/code>/g))
    .filter(([, , id]) => targeted.has(id))
    .map(([, classes, id, text]) => ({
      id,
      text: text.trim(),
      isUrl: classes.split(/\s+/).includes('install-url'),
    }));
}

/** The shell commands the page offers a working copy button for, as command text. */
function copyableCommands(html: string): string[] {
  return copyableBoxes(html)
    .filter((box) => !box.isUrl)
    .map((box) => box.text);
}

/** Track A's card, i.e. everything the `Just try it` track renders. */
function trackAMarkup(): string {
  const article = readIndexHtml().match(
    /<article class="track" aria-labelledby="track-try-h">[\s\S]*?<\/article>/,
  );

  expect(article, 'Track A card not found in index.html').not.toBeNull();
  return article![0];
}

describe('Issue #1200: landing page structure', () => {
  it('has an index.html at the website root', () => {
    expect(fs.existsSync(INDEX_HTML)).toBe(true);
  });

  it('ships no TypeScript, which has no build step here to compile it', () => {
    // Not a type-check concern since #1265 anchored the root tsconfig include
    // (tests/unit/config/tsconfig-scope.test.ts guards that). The reason now is
    // Pages-specific: it serves website/ verbatim, so a .ts would never run.
    const typescriptFiles = walk(WEBSITE_DIR).filter((f) => /\.tsx?$/.test(f));
    expect(typescriptFiles).toEqual([]);
  });
});

describe('Issue #1200: asset references resolve under sub-path hosting', () => {
  it('resolves every local src/href to a real file on disk', () => {
    const html = readIndexHtml();
    const broken = extractRefs(html)
      .filter((ref) => !isExternal(ref))
      .filter((ref) => !fs.existsSync(path.join(WEBSITE_DIR, ref.split(/[?#]/)[0])));

    expect(broken).toEqual([]);
  });

  it('uses no root-absolute local paths', () => {
    // The site is served from https://kewton.github.io/CommandMate/, so a
    // reference like /assets/x.webp resolves to the org root and 404s.
    const html = readIndexHtml();
    const rootAbsolute = extractRefs(html).filter(
      (ref) => ref.startsWith('/') && !ref.startsWith('//'),
    );

    expect(rootAbsolute).toEqual([]);
  });

  it('does not reference the oversized originals in docs/images/', () => {
    const html = readIndexHtml();
    expect(html).not.toMatch(/docs\/images/);
  });

  it('references nothing outside website/, which Pages does not deploy', () => {
    const html = readIndexHtml();
    const escaping = extractRefs(html)
      .filter((ref) => !isExternal(ref))
      .filter((ref) => {
        const resolved = path.resolve(WEBSITE_DIR, ref.split(/[?#]/)[0]);
        return !resolved.startsWith(WEBSITE_DIR + path.sep);
      });

    expect(escaping).toEqual([]);
  });

  it('points og:image at an absolute URL, the one place a relative path fails', () => {
    const html = readIndexHtml();
    const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);

    expect(ogImage).not.toBeNull();
    expect(ogImage![1]).toMatch(/^https:\/\/kewton\.github\.io\/CommandMate\//);
  });
});

describe('Issue #1200: media budget', () => {
  it('keeps the hero image under 100KB, since it is the LCP element', () => {
    const bytes = fs.statSync(path.join(WEBSITE_DIR, OG_IMAGE)).size;

    expect(bytes).toBeLessThan(HERO_BUDGET_BYTES);
  });

  it('never copies the 22MB/47MB originals into website/, in any container', () => {
    // Deliberately extension-agnostic: a GIF re-encode of a recording is the
    // same weight problem as the mp4, and at 2-3x the bytes.
    const huge = walk(WEBSITE_DIR)
      .map((f) => ({ file: f, bytes: fs.statSync(path.join(WEBSITE_DIR, f)).size }))
      .filter((f) => f.bytes > 5_000_000);

    expect(huge).toEqual([]);
  });
});

describe('Issue #1200: page-level markup', () => {
  it('declares an icon so the browser stops probing /favicon.ico at the root', () => {
    const html = readIndexHtml();
    expect(html).toMatch(/<link\s+rel="icon"\s+href="[^/][^"]*"/);
  });
});

/**
 * Issue #1272 — the demo videos were re-encodes of recordings made on a personal
 * machine: six private repo names, readable private source, and the retired
 * product name `MyCodeBranchDesk` in the hero. The desktop poster doubled as the
 * og:image, so it expanded as the preview card every time the LP was linked.
 *
 * Issue #1577 took the revisit those guards invited. The blunt form — no
 * `<video>`, no video extension — turned out not to defend the property it was
 * written for: what was wrong with the old material was where it came from, not
 * what container it sat in, and a GIF of the identical footage passed every one
 * of the checks. The rules below name the location and the exact files instead,
 * so a re-encode of `docs/images/` fails whatever it is called, and growing the
 * set means editing ALLOWED_MEDIA — the point at which someone has to confirm
 * the footage was recorded in an isolated environment.
 */
describe('Issue #1272/#1577: the LP ships only vetted media', () => {
  it('references demo-desktop/demo-mobile from nowhere in the LP source', () => {
    const offenders = LP_SOURCE_FILES.flatMap((file) => {
      const body = fs.readFileSync(path.join(WEBSITE_DIR, file), 'utf-8');
      return body.split('\n').flatMap((line, i) =>
        /demo-desktop|demo-mobile/.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [],
      );
    });

    expect(offenders).toEqual([]);
  });

  it('ships no file named demo-* under website/', () => {
    const demoFiles = walk(WEBSITE_DIR).filter((f) => path.basename(f).startsWith('demo-'));

    expect(demoFiles).toEqual([]);
  });

  it('keeps every moving image under assets/media/, the one reviewed location', () => {
    const strays = walk(WEBSITE_DIR)
      .filter((f) => MOVING_IMAGE.test(f))
      .filter((f) => path.dirname(f) !== MEDIA_DIR);

    expect(strays).toEqual([]);
  });

  it('ships nothing under assets/media/ that is not on the allowlist', () => {
    const unvetted = walk(path.join(WEBSITE_DIR, MEDIA_DIR)).filter(
      (f) => !ALLOWED_MEDIA.includes(f),
    );

    expect(unvetted).toEqual([]);
  });

  it('lists nothing on the allowlist that is no longer on disk', () => {
    // Without this the allowlist rots into names nobody ships, and the review
    // gate above degrades into whatever someone last remembered to delete.
    const missing = ALLOWED_MEDIA.filter(
      (f) => !fs.existsSync(path.join(WEBSITE_DIR, MEDIA_DIR, f)),
    );

    expect(missing).toEqual([]);
  });

  it('points og:image at the isolated-environment screenshot', () => {
    const html = readIndexHtml();
    const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);

    expect(ogImage).not.toBeNull();
    expect(ogImage![1]).toBe(`${PAGES_BASE_URL}${OG_IMAGE}`);
  });

  it('resolves og:image to a file that exists, which no other test covers', () => {
    // og:image is the one reference that must be absolute, so `isExternal`
    // filters it out of the broken-link sweep above. Deleting its target would
    // otherwise ship a silently broken social preview — exactly the shape of
    // the #1272 regression.
    const html = readIndexHtml();
    const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);

    expect(ogImage).not.toBeNull();
    expect(ogImage![1].startsWith(PAGES_BASE_URL)).toBe(true);

    const relative = ogImage![1].slice(PAGES_BASE_URL.length);
    expect(fs.existsSync(path.join(WEBSITE_DIR, relative))).toBe(true);
  });

  it('still ships the og:image as a file the LP itself serves', () => {
    // #1812 took it out of the hero, and "the hero no longer needs it" is
    // exactly the reasoning that would delete it and leave og:image pointing at
    // nothing. It is referenced from the gallery now; what this pins is that it
    // is referenced from the page at all, so the broken-link sweep above keeps
    // covering it.
    expect(readIndexHtml()).toContain(`src="${OG_IMAGE}"`);
  });
});

/**
 * Issue #1812 — the hero is a drawing of the loop rather than a screenshot.
 *
 * That swap moves two risks. An inline SVG is a pile of `<text>` nodes to a
 * screen reader unless it is labelled as one image, and — the one that has
 * actually happened repeatedly on this project — a diagram whose inks are
 * literals is composed while looking at one theme and turns invisible in the
 * other. Both are pinned here rather than left to a reviewer opening the page.
 */
describe('Issue #1812: the hero diagram', () => {
  const heroFigure = (): string => {
    const figure = readIndexHtml().match(/<figure class="hero-media">[\s\S]*?<\/figure>/);

    expect(figure, 'hero-media figure not found in index.html').not.toBeNull();
    return figure![0];
  };

  /** Every declaration inside a `.loop-diagram …` rule, selector kept for the message. */
  const diagramDeclarations = (): { selector: string; property: string; value: string }[] => {
    const css = fs.readFileSync(STYLES_CSS, 'utf-8');

    return Array.from(css.matchAll(/(\.loop-diagram[^{}]*)\{([^}]*)\}/g)).flatMap(
      ([, selector, body]) =>
        Array.from(body.matchAll(/\b(fill|stroke|color|background|background-color)\s*:\s*([^;]+);/g)).map(
          (declaration) => ({
            selector: selector.trim(),
            property: declaration[1],
            value: declaration[2].trim(),
          }),
        ),
    );
  };

  it('draws the loop inline, so the page CSS reaches it', () => {
    expect(heroFigure()).toMatch(/<svg\b/);
  });

  it('presents the drawing as a single labelled image to a screen reader', () => {
    const svg = heroFigure();

    expect(svg).toMatch(/role="img"/);
    const label = /aria-label="([^"]+)"/.exec(svg);
    expect(label, 'the hero svg needs an aria-label').not.toBeNull();
    // A label of "diagram" describes the container, not the content.
    expect(label![1].length).toBeGreaterThan(40);
  });

  it('reserves the drawing box before layout', () => {
    const svg = heroFigure();

    expect(svg).toMatch(/viewBox="[^"]+"/);
    expect(svg).toMatch(/width="\d+"/);
    expect(svg).toMatch(/height="\d+"/);
  });

  it('takes every ink in the drawing from a custom property', () => {
    // The failure this exists for: a hard-coded ink is picked while looking at
    // one colour scheme and is unreadable in the other, and nothing in a unit
    // suite notices because the markup is valid either way.
    const declarations = diagramDeclarations();

    expect(declarations.length, 'no .loop-diagram paint rules found in styles.css').toBeGreaterThan(4);

    const literal = declarations
      .filter(({ value }) => !/^var\(--/.test(value) && !['none', 'inherit'].includes(value))
      .map(({ selector, property, value }) => `${selector} { ${property}: ${value} }`);

    expect(literal, 'every colour in the hero diagram must be a CSS variable').toEqual([]);
  });
});

/**
 * Issue #1577 — four feature demos, in mp4 rather than GIF. Pages serves
 * website/ verbatim with no markdown sanitiser in the way, so `<video>` works
 * here even though docs/ has to settle for GIFs; at 0.56MB against 1.02MB for
 * the same twenty seconds, the container is also the cheaper one.
 *
 * What is easy to get wrong is autoplay: iOS Safari refuses it without both
 * `muted` and `playsinline`, and the failure is silent — a still frame with no
 * error anywhere. These pin the attributes that make playback happen at all.
 */
describe('Issue #1577: feature demo playback', () => {
  const videoTags = (): string[] => readIndexHtml().match(/<video\b[\s\S]*?<\/video>/g) ?? [];

  it('embeds the four demos the Issue settled on', () => {
    // #1812 re-cut the set: the retired three were shot from four reused scenes
    // (#1811 measured two of them at SSIM 0.970), and the four below are one per
    // card in public-messaging.md §3. Order is asserted because the page reads
    // as an argument — contract, then what happens when it stops, then parallel,
    // then where the method comes from.
    const sources = videoTags().map((tag) => /src="([^"]+)"/.exec(tag)?.[1]);

    expect(sources).toEqual(
      Object.keys(DEMO_SOURCES).map((file) => `${MEDIA_DIR.split(path.sep).join('/')}/${file}`),
    );
  });

  it('ships each demo as a byte-for-byte copy of its docs/images/features take', () => {
    // The provenance argument in website/assets/media/README.md is "these are
    // copies, not re-encodes". A re-encode is indistinguishable in the markup
    // and on screen, so the bytes are what has to be compared.
    const reencoded = Object.entries(DEMO_SOURCES).filter(([file, source]) => {
      const shipped = fs.readFileSync(path.join(WEBSITE_DIR, MEDIA_DIR, file));
      const original = fs.readFileSync(path.join(REPO_ROOT, 'docs/images/features', source));
      return !shipped.equals(original);
    });

    expect(reencoded.map(([file]) => file)).toEqual([]);
  });

  it('carries muted and playsinline, without which iOS Safari will not autoplay', () => {
    for (const tag of videoTags()) {
      expect(tag, `missing muted:\n${tag}`).toMatch(/\bmuted\b/);
      expect(tag, `missing playsinline:\n${tag}`).toMatch(/\bplaysinline\b/);
    }
  });

  it('gives every demo a poster that exists, so preload="none" is not a black box', () => {
    for (const tag of videoTags()) {
      const poster = /poster="([^"]+)"/.exec(tag);

      expect(poster, `no poster:\n${tag}`).not.toBeNull();
      expect(fs.existsSync(path.join(WEBSITE_DIR, poster![1])), poster![1]).toBe(true);
    }
  });

  it('reserves each demo box, so the first frame does not reflow the page', () => {
    for (const tag of videoTags()) {
      expect(tag, tag).toMatch(/width="\d+"/);
      expect(tag, tag).toMatch(/height="\d+"/);
    }
  });

  it('sources every demo from the reviewed media directory', () => {
    for (const tag of videoTags()) {
      expect(tag, tag).toMatch(/src="assets\/media\//);
      expect(tag, tag).toMatch(/poster="assets\/media\//);
    }
  });

  it('drops autoplay for readers who asked for reduced motion', () => {
    // A media query cannot stop an autoplaying video, so this has to be script;
    // the CSS block that handles animations elsewhere does nothing here.
    const js = fs.readFileSync(path.join(WEBSITE_DIR, 'main.js'), 'utf-8');

    expect(js).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(js).toMatch(/removeAttribute\(['"]autoplay['"]\)/);
    expect(js).toMatch(/\.controls\s*=\s*true/);
  });

  it('keeps the demos out of the hero, which owns the LCP and the og:image', () => {
    const hero = /<section class="hero">[\s\S]*?<\/section>/.exec(readIndexHtml());

    expect(hero).not.toBeNull();
    expect(hero![0]).not.toMatch(/<video\b/);
  });
});

/**
 * Issue #1316 — a bare `npx commandmate` runs an already-installed global bin
 * without consulting the registry at all, so a reader following the LP on a
 * machine that once installed CommandMate silently gets whatever version is
 * already there (0.3.5 against a current 0.10.0, as measured). `@latest` is what
 * forces the resolve, and the LP advertises npx in three places, so the pin has
 * to hold in all of them rather than in whichever one was edited last.
 *
 * Issue #1317 — the quick start is two tracks, and Track B only earns its place
 * by being copy-pasteable: it exists so a long-running daemon is launched from a
 * stable global install rather than from npm's `_npx` cache, which a later npx
 * run replaces underneath the running server.
 */
describe('Issue #1316/#1317: quick start tracks', () => {
  it('pins every npx invocation to @latest', () => {
    const invocations = readIndexHtml().match(/npx commandmate[^\s<]*/g) ?? [];

    expect(invocations.length).toBeGreaterThan(0);
    expect([...new Set(invocations)]).toEqual(['npx commandmate@latest']);
  });

  it('gives every Track B command its own copy button', () => {
    const copyable = copyableCommands(readIndexHtml());

    for (const command of ['npm install -g commandmate', 'commandmate init', 'commandmate start --daemon']) {
      expect(copyable).toContain(command);
    }
  });

  it('tells the reader how to stop the server both tracks leave running', () => {
    const html = readIndexHtml();

    expect(html).toMatch(/commandmate stop/);
    expect(html).toMatch(/commandmate status/);
  });
});

/**
 * Issue #1327 — Track A was a prose sentence next to Track B's numbered steps,
 * so it read as the thinner option when it is in fact the whole flow automated.
 * It now lists what `npx commandmate@latest` runs (src/cli/commands/quickstart.ts:
 * preflight -> init on first run -> start --daemon -> wait -> open browser).
 *
 * The list describes work the command already does, so it must not grow copy
 * buttons: a reader who copies them runs an `init` they do not need, and a
 * `start --daemon` out of npm's `_npx` cache — the fragile form #1318 removed
 * from the docs. Track A earns its place by being one command; this is the test
 * that keeps it one.
 */
describe('Issue #1327: Track A shows what its one command does', () => {
  it('still offers exactly one copyable command', () => {
    expect(copyableCommands(trackAMarkup())).toEqual(['npx commandmate@latest']);
  });

  it('enumerates the automated steps, rather than burying them in prose', () => {
    // steps-stack is Track B's list markup: the point of the Issue was that the
    // two tracks should carry the same weight.
    const list = trackAMarkup().match(/<ol class="steps steps-stack">([\s\S]*?)<\/ol>/);

    expect(list, 'Track A renders no steps-stack list').not.toBeNull();
    expect(list![1].match(/<li>/g) ?? []).toHaveLength(4);
  });

  it('lists the setup questions init actually asks, browsable roots included', () => {
    // Four steps, but the second one describes five prompts: #1517 added
    // CM_BROWSE_ROOTS ("Additional browsable directories") between the managed
    // root and the port (src/cli/commands/init.ts), and the LP kept promising
    // four. A reader who hits an unexpected prompt does not know whether they
    // are running the thing the page described.
    const steps = trackAMarkup()
      .match(/<ol class="steps steps-stack">([\s\S]*?)<\/ol>/)![1]
      .split('<li>')
      .slice(1);

    expect(steps).toHaveLength(4);
    expect(steps[1].toLowerCase(), 'Track A step 2 must name the browsable-roots prompt').toContain(
      'browsable',
    );
  });
});

/**
 * Issue #1812 — the page is written on the Vibe Engineering axis, and its words
 * are copied from `docs/design/public-messaging.md` rather than composed here.
 *
 * Two failures are worth machine-checking. The first is the retired vocabulary
 * surviving in a corner nobody re-read: before this Issue the old H1 and "local
 * control plane" were still in the `<title>`, three meta tags, the hero, a
 * section lede and the footer, and the competitor comparison was a whole
 * section — nine lines across a file that had been "updated" twice since. The
 * second is paraphrase: the definition sentence is the one string every surface
 * repeats, and a reworded copy of it reads fine in isolation and splits the
 * product's story everywhere it is quoted.
 */
describe('Issue #1812: the page says what the messaging doc says', () => {
  it('keeps every term the Issue named traceable to the messaging doc', () => {
    // The scan below is the union of both lists, so this is what stops the two
    // drifting into "the doc bans it but the LP does not look for it".
    const documented = documentedBannedTerms().map((term) => term.toLowerCase());

    const orphaned = LP_BANNED_TERMS.filter(
      (term) => !documented.some((row) => row.includes(term.toLowerCase())),
    );

    expect(documented.length).toBeGreaterThan(0);
    expect(orphaned, 'these are banned here but no longer in public-messaging.md').toEqual([]);
  });

  it('ships none of the retired wording anywhere under website/', () => {
    const banned = [...new Set([...documentedBannedTerms(), ...LP_BANNED_TERMS])];

    const offenders = textFiles().flatMap(({ file, body }) =>
      body.split('\n').flatMap((line, index) => {
        const lowered = line.toLowerCase();
        return banned
          .filter((term) => lowered.includes(term.toLowerCase()))
          .map((term) => `${file}:${index + 1}: ${term}`);
      }),
    );

    expect(offenders).toEqual([]);
  });

  it('names the axis and states the definition verbatim in the hero', () => {
    expect(normalizedHtml()).toContain('Vibe Engineering');

    // Scoped to the hero rather than the whole file, because the same sentence
    // also sits in `description` and `og:description`: a page-wide `toContain`
    // stays green with the visible copy paraphrased. Measured, not assumed —
    // swapping "expertise" for "skills" in the hero passed the page-wide form.
    const hero = /<section class="hero">[\s\S]*?<\/section>/.exec(readIndexHtml());

    expect(hero, 'hero section not found in index.html').not.toBeNull();
    expect(
      hero![0].replace(/\s+/g, ' '),
      'the en definition must be copied into the hero, not paraphrased',
    ).toContain(definitionEn());
  });

  it('opens on the hero line the messaging doc settled on', () => {
    // Kept as a literal rather than read from the doc: this is the one string
    // where a marker in the source file would have to be threaded through the
    // ja row as well, and the doc's own test already pins it there.
    expect(normalizedHtml()).toContain('<h1>From vibe coding to Vibe Engineering.</h1>');
  });

  it('carries the axis word in the title and in both social tags', () => {
    const html = readIndexHtml();
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? '';
    const ogTitle = /<meta property="og:title" content="([^"]+)"/.exec(html)?.[1] ?? '';
    const description = /<meta\s+name="description"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    const ogDescription = /<meta\s+property="og:description"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';

    for (const [name, value] of Object.entries({ title, ogTitle, description, ogDescription })) {
      expect(value, `${name} is missing from index.html`).not.toBe('');
      expect(value, `${name} must name the axis`).toContain('Vibe Engineering');
    }
  });

  it('replaces the competitor comparison with the With / Without table', () => {
    const html = readIndexHtml();

    // Both halves matter: the section has to be gone, and the nav link that
    // pointed at it has to have moved with it or it scrolls nowhere. Anchors
    // rather than the bare word, which survives legitimately in prose.
    expect(html, 'the #comparison section must be gone').not.toMatch(/id="comparison[^"]*"/);
    expect(html, 'the nav must not link to a section that no longer exists').not.toMatch(
      /href="#comparison"/,
    );
    expect(html).toMatch(/id="with-without"/);
    expect(html).toMatch(/href="#with-without"/);
  });

  it('states all seven With / Without rows', () => {
    const section = /<section class="section" id="with-without"[\s\S]*?<\/section>/.exec(
      readIndexHtml(),
    );

    expect(section, '#with-without section not found').not.toBeNull();
    const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(section![0]);

    expect(body, '#with-without renders no table body').not.toBeNull();
    expect(body![1].match(/<tr>/g) ?? []).toHaveLength(7);
  });
});

/**
 * Issue #1329 — the LP sends a reader to a running server and stops there, with
 * nothing to point the agent at. The tutorial repo is that something. The URL is
 * pasted into the Repositories screen rather than a shell, so what matters is
 * that it is copyable at all — an uncopyable URL means transcribing it by hand,
 * which is the whole reason the copy buttons exist.
 */
describe('Issue #1329: tutorial entry point', () => {
  const TUTORIAL_CLONE_URL = 'https://github.com/Kewton/commandmate-tutorial.git';

  it('wires a copy button to the tutorial clone URL', () => {
    const box = copyableBoxes(readIndexHtml()).find((b) => b.text === TUTORIAL_CLONE_URL);

    expect(box, `no copy-wired box renders ${TUTORIAL_CLONE_URL}`).toBeDefined();
  });

  it('marks the clone URL as a URL, so it renders without a shell prompt', () => {
    // .install-cmd::before prepends "$ ", which would present the URL as a
    // command to run. .install-url is what suppresses it (styles.css).
    const box = copyableBoxes(readIndexHtml()).find((b) => b.text === TUTORIAL_CLONE_URL);

    expect(box?.isUrl).toBe(true);
  });

  it('links out to the tutorial rather than inlining its steps', () => {
    // The LP has no build step, so every step spelled out here is one more thing
    // to keep in sync by hand with the doc that already carries it.
    expect(readIndexHtml()).toMatch(
      /href="https:\/\/github\.com\/Kewton\/CommandMate\/blob\/main\/docs\/en\/user-guide\/tutorial\.md"/,
    );
  });
});

describe('Issue #1200: metadata and honest copy', () => {
  it('declares the OGP tags needed for a decent social preview', () => {
    const html = readIndexHtml();
    for (const property of ['og:title', 'og:description', 'og:image']) {
      expect(html).toMatch(new RegExp(`<meta\\s+property="${property}"`));
    }
  });

  it('declares the page language as English', () => {
    const html = readIndexHtml();
    expect(html).toMatch(/<html[^>]*\blang="en"/);
  });

  it('supports both colour schemes', () => {
    const css = fs.readFileSync(path.join(WEBSITE_DIR, 'styles.css'), 'utf-8');
    expect(css).toMatch(/prefers-color-scheme:\s*dark/);
  });

  it('states Beta status rather than overselling maturity', () => {
    // README.md:8 says "Status: Beta"; the LP must not imply more than that.
    const html = readIndexHtml();
    expect(html).toMatch(/Beta/);
  });

  it('quotes the same Node major that package.json engines requires', () => {
    // #1264 raised engines to >=22 but its sweep did not reach website/, so the
    // LP kept telling newcomers "Node.js v20+" while the very install it
    // advertises refuses to run on 20. The LP is the entry point for people who
    // read nothing else, so its prerequisite has to track engines rather than be
    // remembered.
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    const enginesMajor = /(\d+)/.exec(pkg.engines.node)?.[1];
    expect(enginesMajor).toBeDefined();

    const quoted = /Node\.js v(\d+)\+/.exec(readIndexHtml())?.[1];
    expect(quoted).toBeDefined();
    expect(quoted).toBe(enginesMajor);
  });
});
