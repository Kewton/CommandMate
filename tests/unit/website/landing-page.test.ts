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
 * isolated-environment screenshot; the guards against that regressing live in
 * the `Issue #1272` block at the bottom.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WEBSITE_DIR = path.join(REPO_ROOT, 'website');
const INDEX_HTML = path.join(WEBSITE_DIR, 'index.html');

/** The hero image is the LCP element and the og:image, so it carries a budget. */
const HERO_BUDGET_BYTES = 100_000;
const HERO_IMAGE = 'assets/img/screenshot-desktop.webp';
const PAGES_BASE_URL = 'https://kewton.github.io/CommandMate/';

/** The LP's own source, i.e. everything Pages actually serves as the page. */
const LP_SOURCE_FILES = ['index.html', 'styles.css', 'main.js'];

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
 * Pull every asset/link reference out of the markup. Deliberately regex-based:
 * adding an HTML parser would mean a new npm dependency, which the Issue forbids.
 */
function extractRefs(html: string): string[] {
  const refs: string[] = [];
  const pattern = /(?:src|href)\s*=\s*"([^"]+)"/g;
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
    const bytes = fs.statSync(path.join(WEBSITE_DIR, HERO_IMAGE)).size;

    expect(bytes).toBeLessThan(HERO_BUDGET_BYTES);
  });

  it('never copies the 22MB/47MB originals into website/', () => {
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
 * These tests exist to stop that material coming back. They are deliberately
 * blunt — anything named `demo-*` under website/, or any `<video>` on the page,
 * fails — because the safe way to add a video back is to re-record in an
 * isolated environment and revisit this rule on purpose, not to quietly reuse
 * `docs/images/` (which still holds the tainted originals for the README GIFs).
 */
describe('Issue #1272: the LP ships no demo media', () => {
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

  it('ships no video file under website/ at all', () => {
    const videos = walk(WEBSITE_DIR).filter((f) => /\.(mp4|webm|mov|m4v|ogv)$/i.test(f));

    expect(videos).toEqual([]);
  });

  it('embeds no <video> element, so no playback script is needed', () => {
    const html = readIndexHtml();

    expect(html).not.toMatch(/<video\b/);
  });

  it('points og:image at the isolated-environment hero screenshot', () => {
    const html = readIndexHtml();
    const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);

    expect(ogImage).not.toBeNull();
    expect(ogImage![1]).toBe(`${PAGES_BASE_URL}${HERO_IMAGE}`);
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

  it('serves the hero image eagerly and at a reserved size', () => {
    // It is the LCP element: lazy-loading it delays the largest paint, and
    // dropping width/height reflows the fold once the bytes land.
    const html = readIndexHtml();
    const heroFigure = html.match(/<figure class="hero-media">[\s\S]*?<\/figure>/);

    expect(heroFigure).not.toBeNull();
    expect(heroFigure![0]).toMatch(/<img\b/);
    expect(heroFigure![0]).toContain(HERO_IMAGE);
    expect(heroFigure![0]).not.toMatch(/loading="lazy"/);
    expect(heroFigure![0]).toMatch(/width="\d+"/);
    expect(heroFigure![0]).toMatch(/height="\d+"/);
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
