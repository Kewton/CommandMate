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
 * because it is still the og:image. And the competitor names and unmeasured
 * claims `docs/design/public-messaging.md` lists are asserted absent from
 * everything Pages serves.
 *
 * Issue #3057 retired the rule that the page copies its wording verbatim from
 * that file. What this suite still reads out of it is facts, not sentences: the
 * banned terms, the claims §5 puts outside what was measured, and §6's network
 * routes and retracted network wording. The page is free to say the rest its
 * own way.
 *
 * Issue #2551 gave the hero to a drawing of the product and made the colour
 * guard scan every drawing in INLINE_DRAWINGS rather than the one that happens
 * to be in the hero.
 *
 * Issue #3060 rebuilt the page around three levels and setting up by asking an
 * agent. The blocks that pinned the old sections (The loop, the four cards, the
 * quick start tracks, the FAQ, Measured and the lead run, the tutorial box, the
 * gallery and the compact passes) went with them; what the page inherits — sub-
 * path asset resolution, the media budget and vetted media, lazy playback, no
 * video in the hero, page-level markup, reduced motion, dark mode, the network
 * scope under Trust, the metadata, llms.txt and the version line, and the banned
 * names — is still pinned, and the new structure has its own block at the end.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
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

/**
 * The class of every inline SVG drawing on the page, each of which must take
 * all of its inks from custom properties. #1812 had one, #2551 two; #3060
 * replaced both with figures A to G (the three levels in the hero, then one or
 * two per section) and kept the network drawing under Trust. A new drawing is
 * one more entry here.
 */
const INLINE_DRAWINGS = [
  'levels-diagram',
  'phone-story',
  'flow-diagram',
  'contrast-diagram',
  'team-diagram',
  'day-timeline',
  'setup-chat',
  'trust-diagram',
];

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
  'orchestrate-run.mp4',
  'parallel-worktrees.mp4',
  'poster-contract-verify.webp',
  'poster-install-skill.webp',
  'poster-never-miss-waiting.webp',
  'poster-orchestrate-run.webp',
  'poster-parallel-worktrees.webp',
];

/**
 * The lead demo (Issue #2495). Unlike the four below it, this is not a feature
 * cut from `docs/images/features/`: it is one recorded orchestrate run, and its
 * take lives in `workspace/`, which is gitignored. So there is no in-repo
 * original to `cmp` against and the allowlist above is the whole provenance
 * gate for it — which is why `website/assets/media/README.md` carries the run
 * it came from in prose.
 */
const LEAD_DEMO = 'orchestrate-run.mp4';

/**
 * The four feature demos and the `docs/images/features/` take each one is a
 * byte-for-byte copy of. Named here rather than left implicit because the copy
 * is the whole provenance argument: a re-encode looks identical in the markup
 * and identical on screen, and only `cmp` against these sources tells them
 * apart (see `website/assets/media/README.md`).
 */
const DEMO_SOURCES: Record<string, string> = {
  'contract-verify.mp4': 'cm-11-contract-verify.en.mp4',
  'install-skill.mp4': 'cm-12-install-skill.en.mp4',
  'parallel-worktrees.mp4': 'cm-01-parallel-worktrees.en.mp4',
  'never-miss-waiting.mp4': 'cm-03-never-miss-waiting.en.mp4',
};

/**
 * Page order (Issue #3060): the demos sit in the level each one shows. Level 1
 * has waiting reaching your phone and the sessions side by side, Level 2 the
 * contract and its checks and a Skill being installed, and Level 3 the recorded
 * orchestrate run.
 */
const DEMO_ORDER = [
  'never-miss-waiting.mp4',
  'parallel-worktrees.mp4',
  'contract-verify.mp4',
  'install-skill.mp4',
  LEAD_DEMO,
];

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
 * The rows of the banned-term table in `docs/design/public-messaging.md`: each
 * term with its reason (the last column). The table writes `同上` ("same as
 * above") for a run of rows sharing one reason, so that is resolved to the row
 * above here — otherwise every competitor after the first would read as having
 * no reason at all.
 */
function documentedBannedRows(): { term: string; reason: string }[] {
  const doc = fs.readFileSync(MESSAGING_DOC, 'utf-8');
  const start = doc.indexOf('<!-- banned-terms:start -->');
  const end = doc.indexOf('<!-- banned-terms:end -->');

  expect(start, 'the banned-term table must be delimited').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  const rows: { term: string; reason: string }[] = [];

  for (const line of doc.slice(start, end).split('\n')) {
    const term = /^\|\s*`([^`]+)`\s*\|/.exec(line)?.[1];
    if (!term) continue;

    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    const reason = cells[cells.length - 1].trim();
    const above = rows[rows.length - 1];

    rows.push({ term, reason: reason.startsWith('同上') && above ? above.reason : reason });
  }

  return rows;
}

/** The retired vocabulary, as `docs/design/public-messaging.md` publishes it. */
function documentedBannedTerms(): string[] {
  return documentedBannedRows().map((row) => row.term);
}

/**
 * The competitor names the page must not carry. #1812 also listed the old-axis
 * wording here (`control plane`, the old H1); #3057 cut the doc's table to
 * competitor names and this list with it, leaving the axis to the page.
 *
 * Every competitor name the doc bans is mirrored here, and a test pins that
 * (Issue #2549). The mirror is what makes deleting such a row from the doc
 * loud: the term stays here, so the traceability check fails, instead of the
 * name quietly dropping out of the union the page is scanned for.
 */
const LP_BANNED_TERMS = [
  'Remote Control',
  'Happy Coder',
  'claude-squad',
  'Omnara',
  'Orca',
  'Herdr',
  'Lanes',
];

/**
 * The two rows of `docs/design/public-messaging.md` §5 that cannot be scanned
 * for as substrings. Listed rather than silently skipped: a test pins that both
 * are still rows in that table, so dropping one from the doc surfaces here
 * instead of leaving a dead exemption behind.
 */
const UNSCANNABLE_CLAIMS = ['loop', 'the only …'];

/** Whitespace collapsed, tags dropped: HTML copy as a reader hears it. */
function text(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The rows of the `|`-delimited tables in one `## <n>.` section of
 * `docs/design/public-messaging.md`, header and separator rows dropped. Parsed
 * rather than restated: a copy of a fact here would be the second place it
 * could drift.
 */
function sectionBody(section: string): string {
  const lines = fs.readFileSync(MESSAGING_DOC, 'utf-8').split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${section}.`));

  expect(start, `public-messaging.md has no "## ${section}." section`).toBeGreaterThan(-1);

  // Fence-aware rather than a plain "up to the next `## `": a fenced sample in
  // the doc may open with a `## ` line of its own, and a naive scan would end the
  // section in the middle of it.
  const body: string[] = [];
  let fenced = false;

  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('```')) {
      fenced = !fenced;
    } else if (!fenced && line.startsWith('## ')) {
      break;
    }
    body.push(line);
  }

  return body.join('\n');
}

/** Every `|`-delimited row in a markdown fragment, as trimmed cells, separator rows dropped. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length > 1 && !/^[-:\s]+$/.test(cells[0]));
}

function messagingTable(section: string): string[][] {
  return tableRows(sectionBody(section)).filter(
    (cells) => cells[0] !== '#' && cells[0] !== '項目' && cells[0] !== '言語',
  );
}

/**
 * What sits under one heading of a markdown fragment, down to the next heading
 * at the same level or above (`### en` stops at `### ja`, not at a `####`).
 * Fence-aware like sectionBody(): a fenced YAML sample may open with a `# ` comment.
 */
function headingBody(markdown: string, heading: string): string {
  const level = heading.indexOf(' ');
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));

  expect(start, `public-messaging.md has no "${heading}" heading here`).toBeGreaterThan(-1);

  const body: string[] = [];
  let fenced = false;

  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('```')) {
      fenced = !fenced;
    } else if (!fenced) {
      const hashes = /^(#+) /.exec(line)?.[1].length;
      if (hashes !== undefined && hashes <= level) break;
    }
    body.push(line);
  }

  return body.join('\n');
}

/**
 * The claims §5 puts outside what has actually been measured. Backticked
 * first cells only, which is exactly the "言えないこと" table: the "言えること"
 * rows above it are prose.
 */
function unmeasuredClaims(): string[] {
  return messagingTable('5')
    .map((cells) => /^`([^`]+)`$/.exec(cells[0])?.[1])
    .filter((claim): claim is string => Boolean(claim));
}

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

  it('opens on a skip link to <main>, with a viewport for phones', () => {
    const html = readIndexHtml();

    expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1"/);
    expect(html.indexOf('<a class="skip-link" href="#main">')).toBeLessThan(html.indexOf('<header'));
    expect(html).toMatch(/<main id="main">/);
    expect(fs.readFileSync(STYLES_CSS, 'utf-8')).toMatch(/\.skip-link:focus\s*\{/);
  });

  it('shortens every animation and transition for reduced motion', () => {
    const css = fs.readFileSync(STYLES_CSS, 'utf-8');
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?\})\s*\}/.exec(css);

    expect(block, 'no prefers-reduced-motion block in styles.css').not.toBeNull();
    expect(block![1]).toMatch(/scroll-behavior:\s*auto/);
    expect(block![1]).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(block![1]).toMatch(/transition-duration:\s*0\.01ms !important/);
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

  /** Every declaration inside a `.<drawing> …` rule, selector kept for the message. */
  const diagramDeclarations = (
    drawing: string,
  ): { selector: string; property: string; value: string }[] => {
    const css = fs.readFileSync(STYLES_CSS, 'utf-8');

    return Array.from(css.matchAll(new RegExp(`(\\.${drawing}[^{}]*)\\{([^}]*)\\}`, 'g'))).flatMap(
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

  it('draws the hero inline, so the page CSS reaches it', () => {
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
    const literal = INLINE_DRAWINGS.flatMap((drawing) => {
      const declarations = diagramDeclarations(drawing);

      // Per drawing, so a renamed class fails here instead of scanning nothing.
      expect(declarations.length, `no .${drawing} paint rules found in styles.css`).toBeGreaterThan(4);

      return declarations
        .filter(({ value }) => !/^var\(--/.test(value) && !['none', 'inherit'].includes(value))
        .map(({ selector, property, value }) => `${selector} { ${property}: ${value} }`);
    });

    expect(literal, 'every colour in an inline drawing must be a CSS variable').toEqual([]);
  });
});

/**
 * Issue #3060 — figures A to G. Each is inline SVG, one labelled image to a
 * screen reader, with its box reserved before layout. The colour scan in the
 * #1812 block reads their CSS through INLINE_DRAWINGS; what it cannot see is
 * the markup, where an ink written as a `fill=` attribute never reaches
 * styles.css, so that is pinned here. (Issue #2551 put this markup guard in
 * place for the hero mock and the loop drawing, which #3060 removed.)
 */
describe('Issue #3060: figures A to G', () => {
  const drawingMarkup = (drawing: string): string => {
    const svg = new RegExp(`<svg\\s+class="${drawing}"[\\s\\S]*?</svg>`).exec(readIndexHtml());

    expect(svg, `no <svg class="${drawing}"> in index.html`).not.toBeNull();
    return svg![0];
  };

  const section = (id: string): string => {
    const found = new RegExp(`<section class="section[^"]*" id="${id}"[\\s\\S]*?</section>`).exec(readIndexHtml());

    expect(found, `no #${id} section in index.html`).not.toBeNull();
    return found![0];
  };

  it('puts each figure in the section the Issue names', () => {
    const hero = /<section class="hero">[\s\S]*?<\/section>/.exec(readIndexHtml())![0];
    const placement: [string, string][] = [
      ['level-1', 'phone-story'],
      ['level-2', 'flow-diagram'],
      ['level-2', 'contrast-diagram'],
      ['level-3', 'team-diagram'],
      ['level-3', 'day-timeline'],
      ['setup', 'setup-chat'],
    ];

    expect(hero).toContain(drawingMarkup('levels-diagram'));
    for (const [id, drawing] of placement) {
      expect(section(id), `${drawing} belongs in #${id}`).toContain(drawingMarkup(drawing));
    }
    for (const drawing of INLINE_DRAWINGS) {
      expect(readIndexHtml().split(`class="${drawing}"`), `${drawing} drawn once`).toHaveLength(2);
    }
  });

  it('presents every drawing as one labelled image, its box reserved before layout', () => {
    for (const drawing of INLINE_DRAWINGS) {
      const svg = drawingMarkup(drawing);

      expect(svg, drawing).toMatch(/role="img"/);
      // A label of "diagram" describes the container, not the content.
      expect(/aria-label="([^"]+)"/.exec(svg)?.[1].length ?? 0, drawing).toBeGreaterThan(40);
      expect(svg, drawing).toMatch(/viewBox="[^"]+"\s+width="\d+"\s+height="\d+"/);
    }
  });

  it('writes no ink into the markup of any drawing, where the CSS scan cannot see it', () => {
    const offenders = INLINE_DRAWINGS.flatMap((drawing) =>
      [...drawingMarkup(drawing).matchAll(/\s(fill|stroke|color|stop-color|style)="[^"]*"/g)].map(
        (match) => `.${drawing}: ${match[0].trim()}`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  it('draws the three levels as steps, each under a prompt chip', () => {
    const svg = drawingMarkup('levels-diagram');
    const titles = [...svg.matchAll(/<text class="step-title"[^>]*>([\s\S]*?)<\/text>/g)].map((m) => text(m[1]));
    const chips = [...svg.matchAll(/<text class="chip-text"[^>]*>([\s\S]*?)<\/text>/g)].map((m) => text(m[1]));

    expect(titles).toEqual(['Level 1', 'Level 2', 'Level 3']);
    expect(chips).toHaveLength(3);
    expect(chips.every((chip) => chip.includes('prompt'))).toBe(true);
  });

  it('sends failed work back from the checks in figure C', () => {
    const svg = drawingMarkup('flow-diagram');
    const nodes = [...svg.matchAll(/<g class="node[^"]*">[\s\S]*?<text[^>]*>([\s\S]*?)<\/text><\/g>/g)].map((m) =>
      text(m[1]),
    );

    expect(nodes).toEqual(['Issue', 'worktree', 'contract', 'work', 'checks', 'UAT', 'PR']);
    expect(svg).toMatch(/class="edge edge-fail"/);
  });

  it("times the agents' side of the day and marks yours as an example in figure F", () => {
    const svg = drawingMarkup('day-timeline');
    const times = [...svg.matchAll(/<text class="time"[^>]*>([\s\S]*?)<\/text>/g)].map((m) => text(m[1]));

    expect(times).toEqual(['06:30', '07:00', '08:30']);
    expect(svg).toContain('You (example)');
  });

  it('leaves the provider to the person in figure G', () => {
    const said = text(drawingMarkup('setup-chat'));

    expect(said).toContain('setup.md');
    expect(said).toContain('You choose');
    expect(said).toContain('Tailscale');
    expect(said).toContain('Cloudflare');
  });
});

/**
 * Issue #2554 — the network-scope note under the cards becomes a section of its
 * own, "Runs on your machine", with a drawing of the machine and the two
 * connections every session has: the lede is what CommandMate itself does, the
 * drawing's footnote is what goes over the network and when. The footnote's
 * length is read from public-messaging.md §6's evidence table, so a route added
 * there stays red here until the page lists it too. (#3057 dropped the check
 * that the two halves are that file's sentence verbatim.) #3060 made it the
 * first of four points under "Why you can trust it".
 *
 * The colour scan in the #1812 block and the markup scan in the #3060 block reach
 * this drawing through INLINE_DRAWINGS. The other three drawing guards in #1812
 * read the hero's figure only, so they are repeated here for this one.
 */
describe('Issue #2554: Trust', () => {
  const firstGroup = (html: string, pattern: RegExp, what: string): string => {
    const found = pattern.exec(html);

    expect(found, `${what} not found`).not.toBeNull();
    return found![1];
  };

  const trustSection = (): string =>
    firstGroup(readIndexHtml(), /(<section class="section" id="trust"[\s\S]*?<\/section>)/, 'the #trust section');

  const trustSvg = (): string =>
    firstGroup(trustSection(), /(<svg\s+class="trust-diagram"[\s\S]*?<\/svg>)/, 'the trust drawing');

  const footnote = (): string =>
    firstGroup(trustSection(), /<figcaption class="trust-notes">([\s\S]*?)<\/figcaption>/, 'the drawing footnote');

  /** The rows of one `### ` table in §6, its header row dropped. */
  const trustTable = (heading: string): string[][] => {
    const [header, ...rows] = tableRows(headingBody(sectionBody('6'), heading));

    expect(header, `§6 has no table under "${heading}"`).not.toBeUndefined();
    return rows;
  };

  it('opens Trust on "Runs on your machine", between My setup and Start (#3060)', () => {
    expect(readIndexHtml()).toMatch(
      /id="my-setup"[\s\S]*?<\/section>\s*(?:<!--(?:(?!-->)[\s\S])*-->\s*)?<section class="section" id="trust"/,
    );
    expect(text(firstGroup(trustSection(), /<h2 id="trust-h">([\s\S]*?)<\/h2>/, 'the #trust heading'))).toBe(
      'Why you can trust it',
    );
    expect(text(firstGroup(trustSection(), /<h3 class="trust-point">([\s\S]*?)<\/h3>/, 'the first trust point'))).toBe(
      'Runs on your machine',
    );
    // The other three points the Issue lists: you decide, the limits, MIT.
    const points = [...trustSection().matchAll(/<div class="trust-card">\s*<h3>([\s\S]*?)<\/h3>/g)].map((m) => text(m[1]));
    expect(points).toEqual(['You decide', 'The limits, written down', 'Open source, MIT']);
  });

  it("lists one footnote per route in §6's evidence table", () => {
    const routes = [...footnote().matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => text(match[1]));
    const evidence = trustTable('### 機能ごとの通信');

    // §6's rule: a route is dropped from the sentence only after the table
    // shows the traffic itself is gone. So the table's length is the list's.
    expect(evidence.length).toBeGreaterThan(0);
    expect(routes).toHaveLength(evidence.length);
  });

  it('carries none of the network wording §6 retracted, anywhere Pages serves', () => {
    const rows = trustTable('### 書かない表現');
    const terms = (conditional: boolean): string[] =>
      rows
        .filter(([cell]) => cell.includes('無条件') === conditional)
        .flatMap(([cell]) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1].toLowerCase()));
    // The Issue's own criterion, as a literal too: §6 lists the whole retracted
    // sentence, and the start of it is what would come back reworded.
    const banned = ['the only network traffic', ...terms(false)];
    // "No external server" is retracted only as a bare claim; §6's own
    // rule says it needs none "to run".
    const bare = terms(true);

    expect(banned.length).toBeGreaterThan(1);
    expect(bare.length).toBeGreaterThan(0);

    const offenders = textFiles().flatMap(({ file, body }) => {
      const flat = body.replace(/\s+/g, ' ').toLowerCase();

      return [
        ...banned.filter((term) => flat.includes(term)).map((term) => `${file}: ${term}`),
        ...bare.flatMap((term) =>
          flat
            .split(term)
            .slice(1)
            .filter((after) => !after.startsWith(' to run'))
            .map(() => `${file}: ${term} (not "to run")`),
        ),
      ];
    });

    expect(offenders).toEqual([]);
  });

  it('scans the drawing with the colour and markup guards of the others', () => {
    expect(INLINE_DRAWINGS).toContain('trust-diagram');
  });

  it('draws the network scope inline, inside the section', () => {
    const figure = firstGroup(trustSection(), /<figure class="trust-figure">([\s\S]*?)<\/figure>/, 'the trust figure');

    expect(figure).toMatch(/<svg\s+class="trust-diagram"/);
  });

  it('presents the drawing as a single labelled image to a screen reader', () => {
    const svg = trustSvg();

    expect(svg).toMatch(/role="img"/);
    const label = /aria-label="([^"]+)"/.exec(svg);
    expect(label, 'the trust svg needs an aria-label').not.toBeNull();
    expect(label![1].length).toBeGreaterThan(40);
  });

  it('reserves the drawing box before layout', () => {
    expect(trustSvg()).toMatch(/viewBox="[^"]+"\s+width="\d+"\s+height="\d+"/);
  });

  it("draws three nodes: your machine running CommandMate and the agent CLI in tmux, a browser or phone, the agent's API", () => {
    const svg = trustSvg();
    const machine = firstGroup(svg, /<g class="machine">([\s\S]*?)<\/g>/, 'the machine node');
    const labels = (html: string, kind: string): string[] =>
      [...html.matchAll(new RegExp(`<text class="${kind}"[^>]*>([\\s\\S]*?)</text>`, 'g'))].map((match) =>
        text(match[1]),
      );

    expect(labels(machine, 'machine-title')).toEqual(['Your machine']);
    expect(labels(machine, 'chip-title')).toEqual(['CommandMate', 'Agent CLI']);
    expect(labels(machine, 'tmux-title')).toEqual(['tmux']);
    expect(labels(svg, 'peer-title')).toEqual(['Browser or phone', "The agent's API"]);
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
 *
 * Since #2556 the tags carry `data-autoplay` rather than `autoplay`, and main.js
 * calls play() once a demo is on screen; the conditions iOS checks are the same
 * for that call, so the pins below stayed and only the marker they sit next to
 * changed. The `Issue #2556` block after this one runs main.js itself.
 */
describe('Issue #1577: feature demo playback', () => {
  const videoTags = (): string[] => readIndexHtml().match(/<video\b[\s\S]*?<\/video>/g) ?? [];
  const source = (tag: string): string | undefined => /src="([^"]+)"/.exec(tag)?.[1];

  it('embeds the five demos in page order, each in the level it shows', () => {
    // #3060 moved each demo into the level it shows (see DEMO_ORDER), the
    // recorded orchestrate run last, under Level 3.
    const expected = DEMO_ORDER.map((file) => `${MEDIA_DIR.split(path.sep).join('/')}/${file}`);

    expect(videoTags().map(source)).toEqual(expected);
    // #2556: main.js plays what is marked, so a demo without the mark would sit
    // on its poster for good while every assertion about the markup held.
    expect(
      videoTags()
        .filter((tag) => /\sdata-autoplay\b/.test(tag))
        .map(source),
    ).toEqual(expected);
  });

  it('ships each feature demo as a byte-for-byte copy of its docs/images/features take', () => {
    // The provenance argument in website/assets/media/README.md is "these are
    // copies, not re-encodes". A re-encode is indistinguishable in the markup
    // and on screen, so the bytes are what has to be compared. LEAD_DEMO is not
    // in here: its take is in gitignored `workspace/`, so the allowlist and the
    // README are the whole gate for that one.
    const reencoded = Object.entries(DEMO_SOURCES).filter(([file, source]) => {
      const shipped = fs.readFileSync(path.join(WEBSITE_DIR, MEDIA_DIR, file));
      const original = fs.readFileSync(path.join(REPO_ROOT, 'docs/images/features', source));
      return !shipped.equals(original);
    });

    expect(reencoded.map(([file]) => file)).toEqual([]);
  });

  it('carries muted and playsinline, without which iOS Safari will not autoplay', () => {
    // Autoplay here is main.js calling play() on a `data-autoplay` video with no
    // gesture behind it, which iOS Safari allows on exactly these two terms.
    for (const tag of videoTags()) {
      expect(tag, `missing data-autoplay:\n${tag}`).toMatch(/\sdata-autoplay\b/);
      expect(tag, `missing muted:\n${tag}`).toMatch(/\smuted\b/);
      expect(tag, `missing playsinline:\n${tag}`).toMatch(/\splaysinline\b/);
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
    // A media query cannot stop a video from playing, so this has to be script;
    // the CSS block that handles animations elsewhere does nothing here. Since
    // #2556 there is no `autoplay` attribute to take off — script is what starts
    // a demo — so what has to hold is that the reduced-motion branch takes the
    // mark off and hands over controls. The `Issue #2556` block below runs it.
    const js = fs.readFileSync(path.join(WEBSITE_DIR, 'main.js'), 'utf-8');

    expect(js).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(js).toMatch(/removeAttribute\(['"]data-autoplay['"]\)/);
    expect(js).toMatch(/\.controls\s*=\s*true/);
    expect(readIndexHtml(), 'a bare autoplay attribute outranks preload="none"').not.toMatch(
      /<video\b[^>]*\sautoplay\b/,
    );
  });

  it('keeps the demos out of the hero, which owns the LCP and the og:image', () => {
    const hero = /<section class="hero">[\s\S]*?<\/section>/.exec(readIndexHtml());

    expect(hero).not.toBeNull();
    expect(hero![0]).not.toMatch(/<video\b/);
  });
});

/**
 * Issue #2556 — "The autoplay attribute has precedence over preload" (MDN), so
 * with `autoplay` on the tags all five demos, 3.0 MB, downloaded on first load
 * whether or not anyone scrolled to them. The tags carry `data-autoplay` now,
 * and main.js plays a demo once an IntersectionObserver sees a quarter of it,
 * or at once in a browser that has no observer.
 *
 * What changed is when play() gets called, which reading main.js as text cannot
 * show, so these run it against index.html in jsdom — already a dependency of
 * the app, not a new one for the LP. jsdom has neither media playback nor an
 * IntersectionObserver; both are stubbed, which is also what lets a test decide
 * what is on screen. The request count itself was measured in Chromium and is
 * not repeated here. Neither is iOS Safari, which has not been run on a device:
 * the most a test can pin is that every video main.js plays still has `muted`
 * and `playsinline` at the moment it plays it.
 */
describe('Issue #2556: lazy demo playback', () => {
  /** The part of jsdom used here. It ships no types and @types/jsdom is not installed. */
  interface VirtualConsoleLike {
    on(event: string, listener: (message: unknown) => void): void;
  }
  interface JsdomModule {
    JSDOM: new (
      html: string,
      options: { runScripts: 'outside-only'; virtualConsole: VirtualConsoleLike },
    ) => { window: Window & typeof globalThis };
    VirtualConsole: new () => VirtualConsoleLike;
  }

  type ObserverEntry = Pick<IntersectionObserverEntry, 'target' | 'isIntersecting' | 'intersectionRatio'>;

  interface FakeObserver {
    readonly options?: IntersectionObserverInit;
    readonly observed: Element[];
    /** What the browser does when `target` crosses a threshold with `ratio` of it on screen. */
    report(target: Element, ratio: number): void;
  }

  interface PlaybackRun {
    window: Window & typeof globalThis;
    videos: HTMLVideoElement[];
    /** Every play() call, with the two attributes iOS Safari checks as they were at that moment. */
    plays: { src: string; muted: boolean; playsinline: boolean }[];
    pauses: string[];
    observers: FakeObserver[];
    /** Anything the page wrote to the console, jsdom's own complaints included. */
    consoleOutput: unknown[];
  }

  const src = (element: Element): string => element.getAttribute('src') ?? '';

  /** Load index.html in a fresh jsdom, stub what jsdom lacks, and run main.js the way the page does. */
  function runMainJs(setup: {
    intersectionObserver: boolean;
    reducedMotion?: boolean;
    play?: () => Promise<void>;
  }): PlaybackRun {
    const { JSDOM, VirtualConsole } = createRequire(__filename)('jsdom') as JsdomModule;
    const consoleOutput: unknown[] = [];
    const virtualConsole = new VirtualConsole();
    for (const event of ['error', 'warn', 'jsdomError']) {
      virtualConsole.on(event, (message) => consoleOutput.push(message));
    }
    const { window } = new JSDOM(readIndexHtml(), { runScripts: 'outside-only', virtualConsole });

    const plays: PlaybackRun['plays'] = [];
    const pauses: string[] = [];
    const playing = new Set<HTMLMediaElement>();
    const media = window.HTMLMediaElement.prototype;
    Object.defineProperty(media, 'paused', {
      configurable: true,
      get(this: HTMLMediaElement) {
        return !playing.has(this);
      },
    });
    media.play = function (this: HTMLMediaElement) {
      plays.push({
        src: src(this),
        muted: this.hasAttribute('muted'),
        playsinline: this.hasAttribute('playsinline'),
      });
      playing.add(this);
      return setup.play ? setup.play() : Promise.resolve();
    };
    media.pause = function (this: HTMLMediaElement) {
      pauses.push(src(this));
      playing.delete(this);
    };

    window.matchMedia = (query: string) =>
      ({
        matches: Boolean(setup.reducedMotion) && /prefers-reduced-motion:\s*reduce/.test(query),
        media: query,
      }) as MediaQueryList;

    const observers: FakeObserver[] = [];
    if (setup.intersectionObserver) {
      class FakeIntersectionObserver implements FakeObserver {
        readonly observed: Element[] = [];

        constructor(
          private readonly callback: (entries: ObserverEntry[]) => void,
          readonly options?: IntersectionObserverInit,
        ) {
          observers.push(this);
        }

        observe(target: Element): void {
          this.observed.push(target);
        }

        unobserve(): void {}

        disconnect(): void {}

        report(target: Element, ratio: number): void {
          this.callback([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]);
        }
      }
      Object.assign(window, { IntersectionObserver: FakeIntersectionObserver });
    } else {
      Reflect.deleteProperty(window, 'IntersectionObserver');
    }

    window.eval(fs.readFileSync(path.join(WEBSITE_DIR, 'main.js'), 'utf-8'));

    return {
      window,
      videos: Array.from(window.document.querySelectorAll('video')),
      plays,
      pauses,
      observers,
      consoleOutput,
    };
  }

  it('keeps autoplay off every demo, with preload="none", loop and a poster still on it', () => {
    const { videos } = runMainJs({ intersectionObserver: true });

    expect(videos.map(src)).toEqual(DEMO_ORDER.map((file) => `assets/media/${file}`));
    for (const video of videos) {
      expect(video.hasAttribute('autoplay'), src(video)).toBe(false);
      expect(video.getAttribute('preload'), src(video)).toBe('none');
      expect(video.loop, src(video)).toBe(true);
      expect(video.getAttribute('poster'), src(video)).toMatch(/^assets\/media\/poster-/);
    }
  });

  it('observes every demo at a quarter visible and plays none of them on load', () => {
    const { videos, plays, pauses, observers } = runMainJs({ intersectionObserver: true });

    expect(observers).toHaveLength(1);
    expect(observers[0].options?.threshold).toBe(0.25);
    expect(observers[0].observed.map(src)).toEqual(videos.map(src));

    // A browser reports every target once on observe(); for a demo below the
    // fold that report is a zero, and it must neither play nor pause anything.
    for (const video of videos) observers[0].report(video, 0);

    expect(plays).toEqual([]);
    expect(pauses).toEqual([]);
  });

  it('plays a demo once a quarter of it is on screen, and pauses it once that is no longer so', () => {
    const { videos, plays, pauses, observers } = runMainJs({ intersectionObserver: true });
    const [observer] = observers;
    const demo = videos[1];

    // On screen, but less than the threshold: `isIntersecting` alone would play it.
    observer.report(demo, 0.1);
    expect(plays).toEqual([]);

    observer.report(demo, 0.25);
    expect(plays.map((play) => play.src)).toEqual([src(demo)]);
    expect(demo.paused).toBe(false);

    observer.report(demo, 0.2);
    expect(pauses).toEqual([src(demo)]);
    expect(demo.paused).toBe(true);
  });

  it('plays every demo at once in a browser without IntersectionObserver', () => {
    const { window, videos, plays } = runMainJs({ intersectionObserver: false });

    expect('IntersectionObserver' in window, 'the fallback is not what ran').toBe(false);
    expect(plays.map((play) => play.src)).toEqual(videos.map(src));
    expect(plays).toHaveLength(DEMO_ORDER.length);
  });

  it('only ever plays a demo that is muted and playsinline, the terms iOS Safari plays on', () => {
    // Not run on an iOS device; this pins the conditions, not the outcome.
    const lazy = runMainJs({ intersectionObserver: true });
    for (const video of lazy.videos) lazy.observers[0].report(video, 1);
    const eager = runMainJs({ intersectionObserver: false });

    for (const { plays } of [lazy, eager]) {
      expect(plays).toHaveLength(DEMO_ORDER.length);
      for (const play of plays) {
        expect(play, play.src).toEqual({ src: play.src, muted: true, playsinline: true });
      }
    }
  });

  it('swallows a play() the browser refuses, so a blocked autoplay writes nothing to the console', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const { plays, consoleOutput } = runMainJs({
        intersectionObserver: false,
        play: () => Promise.reject(new Error('NotAllowedError: play() needs a user gesture')),
      });
      // Node reports an unhandled rejection once the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(plays).toHaveLength(DEMO_ORDER.length);
      expect(unhandled).toEqual([]);
      expect(consoleOutput).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('starts nothing for reduced motion, with or without an observer, and hands over controls', () => {
    for (const intersectionObserver of [true, false]) {
      const label = `IntersectionObserver ${intersectionObserver ? 'present' : 'absent'}`;
      const { videos, plays, observers } = runMainJs({ intersectionObserver, reducedMotion: true });

      expect(observers.flatMap((observer) => observer.observed), label).toEqual([]);
      expect(plays, label).toEqual([]);
      for (const video of videos) {
        expect(video.hasAttribute('data-autoplay'), `${label}: ${src(video)}`).toBe(false);
        expect(video.controls, `${label}: ${src(video)}`).toBe(true);
        expect(video.loop, `${label}: ${src(video)}`).toBe(false);
      }
    }
  });
});

/**
 * Issue #1316 — a bare `npx commandmate` runs an already-installed global bin
 * without consulting the registry at all, so a reader following the LP on a
 * machine that once installed CommandMate silently gets whatever version is
 * already there. `@latest` is what forces the resolve. Since #3060 the page
 * sends the reader to their agent rather than to a shell, so it may carry no
 * npx line at all; any it does carry stays pinned.
 */
describe('Issue #1316: npx invocations', () => {
  it('pins every npx invocation to @latest', () => {
    const invocations = textFiles().flatMap(({ body }) => body.match(/npx commandmate[^\s<`]*/g) ?? []);

    expect(invocations.filter((invocation) => invocation !== 'npx commandmate@latest')).toEqual([]);
  });
});

/**
 * Issue #1812 — the page is written on the Vibe Engineering axis. The failure
 * worth machine-checking is banned wording surviving in a corner nobody re-read:
 * before this Issue the old H1 was still in the `<title>`, three meta tags, the
 * hero, a section lede and the footer, and the competitor comparison was a whole
 * section. Since #3057 the banned list is competitor names, and the page's
 * wording is no longer compared with `docs/design/public-messaging.md`.
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

  it('mirrors every competitor name the messaging doc bans into LP_BANNED_TERMS', () => {
    // The check above only runs one way — a term here must be in the doc — so a
    // competitor added to the doc and forgotten here stayed green. Issue #2549
    // added three at once. A competitor row is one whose reason reads 競合製品名
    // ("competitor product name"), `同上` rows included via documentedBannedRows.
    const competitors = documentedBannedRows()
      .filter((row) => row.reason.startsWith('競合製品名'))
      .map((row) => row.term);
    const mirrored = LP_BANNED_TERMS.map((term) => term.toLowerCase());

    expect(competitors.length, 'no banned-term row reads as a competitor name').toBeGreaterThan(0);
    expect(
      competitors.filter((name) => !mirrored.includes(name.toLowerCase())),
      'these competitors are banned in public-messaging.md but missing from LP_BANNED_TERMS',
    ).toEqual([]);
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

  it('carries the H1 in the title and in both social tags', () => {
    // Until #2495 these carried the axis word, because the axis word was the H1.
    // It is the Philosophy heading now, so what the card and the tab have to
    // carry is the claim the page actually opens on. Read off the page itself
    // since #3057: the tab and the card agree with the hero, whatever it says.
    const html = readIndexHtml();
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? '';
    const ogTitle = /<meta property="og:title" content="([^"]+)"/.exec(html)?.[1] ?? '';
    const description = /<meta\s+name="description"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    const ogDescription =
      /<meta\s+property="og:description"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';

    const h1 = text(/<h1>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '');
    const [lede] = text(/<p class="lede">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '').split(/(?<=\.)\s+/);

    expect(h1, 'index.html has no <h1>').not.toBe('');
    expect(lede, 'index.html has no hero lede').not.toBe('');

    for (const [name, value] of Object.entries({ title, ogTitle })) {
      expect(value, `${name} is missing from index.html`).toBe(`CommandMate — ${h1}`);
    }
    for (const [name, value] of Object.entries({ description, ogDescription })) {
      expect(value, `${name} must open on the lede's first sentence`).toBe(lede);
    }
  });
});

/**
 * Issue #2495 — §5 of `docs/design/public-messaging.md` lists the claims
 * nobody measured. Since #3057 this is the only part of the orchestrate-axis
 * block that still applies: the page may say things its own way, but not
 * these.
 */
describe('Issue #2495: claims outside what was measured', () => {
  it('makes none of the claims §5 puts outside what was measured', () => {
    const claims = unmeasuredClaims().filter((claim) => !UNSCANNABLE_CLAIMS.includes(claim));

    expect(claims.length).toBeGreaterThan(0);
    const offenders = textFiles().flatMap(({ file, body }) =>
      body.split('\n').flatMap((line, index) => {
        const lowered = line.toLowerCase();
        return claims
          .filter((claim) => lowered.includes(claim.toLowerCase()))
          .map((claim) => `${file}:${index + 1}: ${claim}`);
      }),
    );

    expect(offenders).toEqual([]);
  });

  it('still finds the two §5 rows a substring scan cannot be run for', () => {
    // Both are real rules, and neither can be a substring search: "loop" is
    // an ordinary word that §5 rules out only as a claim that something runs
    // forever, and "the only …" is an ellipsis, a shape rather than a string.
    // Pinned here so the exemption cannot outlive the rows.
    expect(unmeasuredClaims()).toEqual(expect.arrayContaining(UNSCANNABLE_CLAIMS));
  });

  it('says neither "loop" nor "the only" in the copy a reader sees', () => {
    // The page has no section named after a loop any more (#3060), so the
    // exemption above is not needed for the page's own text.
    const said = text(readIndexHtml().replace(/<!--[\s\S]*?-->/g, '').replace(/<head>[\s\S]*?<\/head>/, '')).toLowerCase();

    expect(said).not.toMatch(/\bloop(?:s|ed|ing)?\b/);
    expect(said).not.toMatch(/\bthe only\b/);
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

/**
 * Issue #2552 — the furniture a visitor looks for before reading anything: where
 * the docs are, what changed lately, whether the project is alive, and a text
 * version of the page for a crawler that does not run a browser.
 *
 * Three of these go stale without anyone touching the page. The version line is
 * static on purpose (no API call at load), so the release skill rewrites it —
 * which is why the step's own script is run against a copy here: renaming the
 * markup would otherwise break the next release, not this PR. `llms.txt` copies
 * the hero and the cards, so it is read against the messaging doc exactly as the
 * page is. And the header gave its in-page anchors to the footer, so every `#…`
 * link on the page has to land on an id that still exists.
 */
describe('Issue #2552: nav, footer, version line and llms.txt', () => {
  const REPO_URL = 'https://github.com/Kewton/CommandMate';
  const LLMS_TXT = path.join(WEBSITE_DIR, 'llms.txt');
  const RELEASE_SKILL = path.join(REPO_ROOT, '.claude/skills/release/SKILL.md');
  const RELEASE_LINE = /<p class="release-line">v(\d+\.\d+\.\d+) · released (\d{4}-\d{2}-\d{2}) · (\d+)\+ releases<\/p>/g;

  interface Anchor {
    text: string;
    href: string;
    classes: string[];
  }

  const anchors = (fragment: string): Anchor[] =>
    Array.from(fragment.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g), ([, attributes, inner]) => ({
      text: text(inner),
      href: /\bhref="([^"]*)"/.exec(attributes)?.[1] ?? '',
      classes: (/\bclass="([^"]*)"/.exec(attributes)?.[1] ?? '').split(/\s+/).filter(Boolean),
    }));

  const markup = (pattern: RegExp, what: string): string => {
    const found = pattern.exec(readIndexHtml());

    expect(found, `${what} not found in index.html`).not.toBeNull();
    return found![0];
  };

  const navLinks = (): Anchor[] =>
    anchors(markup(/<div class="nav-links">[\s\S]*?<\/div>/, 'the primary nav'));

  const footer = (): string => markup(/<footer class="site-footer">[\s\S]*?<\/footer>/, 'the footer');

  /** The body of the first `@media (<query>) { … }` block, braces balanced. */
  const mediaBlock = (query: string): string => {
    const css = fs.readFileSync(STYLES_CSS, 'utf-8');
    const open = css.indexOf(`@media (${query}) {`);

    expect(open, `styles.css has no @media (${query}) block`).toBeGreaterThan(-1);

    const start = css.indexOf('{', open) + 1;
    let depth = 1;
    let at = start;
    for (; at < css.length && depth > 0; at++) {
      if (css[at] === '{') depth++;
      if (css[at] === '}') depth--;
    }
    return css.slice(start, at - 1);
  };

  const packageVersion = (): string =>
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')).version;

  const releaseLine = (): { version: string; date: string; count: number } => {
    const lines = Array.from(readIndexHtml().matchAll(RELEASE_LINE));

    expect(lines, 'index.html must carry exactly one version line').toHaveLength(1);
    const [, version, date, count] = lines[0];
    return { version, date, count: Number(count) };
  };

  /** The `node -e '…'` script the release skill runs in Phase 2-2a. */
  const releaseLineScript = (): string => {
    const script = /node -e '\n([\s\S]*?)\n' "\$\{NEXT_VERSION\}"/.exec(
      fs.readFileSync(RELEASE_SKILL, 'utf-8'),
    );

    expect(script, 'the release skill no longer rewrites the version line with node -e').not.toBeNull();
    return script![1];
  };

  /** Run that script against a copy of the page, the way the skill runs it from the repo root. */
  const runReleaseLineScript = (args: string[]): { status: number | null; before: string; after: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-release-line-'));

    try {
      fs.mkdirSync(path.join(root, 'website'));
      const copy = path.join(root, 'website', 'index.html');
      const before = readIndexHtml();
      fs.writeFileSync(copy, before);

      const run = spawnSync(process.execPath, ['-e', releaseLineScript(), ...args], {
        cwd: root,
        encoding: 'utf-8',
      });
      return { status: run.status, before, after: fs.readFileSync(copy, 'utf-8') };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  const llmsTxt = (): string => fs.readFileSync(LLMS_TXT, 'utf-8');

  it('links the nav to Docs, Tutorial, Changelog and GitHub, in that order', () => {
    expect(navLinks().map(({ text: label, href }) => [label, href])).toEqual([
      ['Docs', `${REPO_URL}/tree/main/docs/en`],
      ['Tutorial', `${REPO_URL}/blob/main/docs/en/user-guide/tutorial.md`],
      ['Changelog', `${REPO_URL}/releases`],
      ['GitHub', REPO_URL],
    ]);
  });

  it('keeps Docs and GitHub in the nav at 560px and below', () => {
    const narrow = mediaBlock('max-width: 560px');

    // By class, never by position: `:not(:last-child)` hid Docs along with the
    // rest the moment Docs stopped being the last link.
    expect(narrow).toMatch(/\.nav-links \.nav-secondary\s*\{\s*display:\s*none;\s*\}/);
    expect(narrow).not.toMatch(/\.nav-links a[^{]*\{[^}]*display:\s*none/);
    expect(
      navLinks()
        .filter((link) => !link.classes.includes('nav-secondary'))
        .map((link) => link.text),
    ).toEqual(['Docs', 'GitHub']);
  });

  it('moves the in-page anchors to the footer, and every #link lands on an id', () => {
    const html = readIndexHtml();

    expect(anchors(footer()).map((link) => link.href)).toEqual(
      expect.arrayContaining(['#level-1', '#level-2', '#level-3', '#setup', '#trust']),
    );

    const dangling = Array.from(html.matchAll(/href="#([^"]+)"/g), ([, id]) => id).filter(
      (id) => !html.includes(`id="${id}"`),
    );
    expect(dangling, 'these in-page links scroll nowhere').toEqual([]);
  });

  it('links the footer to Discussions and Releases, and the page to one X account', () => {
    const links = anchors(footer()).map(({ text: label, href }) => [label, href]);

    expect(links).toEqual(
      expect.arrayContaining([
        ['Discussions', `${REPO_URL}/discussions`],
        ['Releases', `${REPO_URL}/releases`],
      ]),
    );
    // #3060 asks for "Follow on X" in Start. One account, the author's, and
    // nowhere else: a second handle would be a guess.
    const xLinks = anchors(readIndexHtml())
      .map((link) => link.href)
      .filter((href) => /\/\/(www\.)?(x|twitter)\.com\b/.test(href));
    expect(xLinks).toEqual(['https://x.com/SibaKotaro']);
  });

  it('points a feed reader at the GitHub releases feed', () => {
    const head = markup(/<head>[\s\S]*?<\/head>/, '<head>');

    expect(head).toContain(
      `<link rel="alternate" type="application/atom+xml" href="${REPO_URL}/releases.atom"`,
    );
  });

  it('states the version package.json ships, directly under the prerequisites', () => {
    // In Start since #3060, where the reader decides to go ahead.
    const start = markup(/<section class="section start" id="start"[\s\S]*?<\/section>/, 'the Start section');

    expect(releaseLine().version).toBe(packageVersion());
    expect(start.indexOf('class="prereq"')).toBeGreaterThan(-1);
    expect(start.indexOf('class="release-line"')).toBeGreaterThan(start.indexOf('class="prereq"'));
    expect(start.indexOf('class="release-line"')).toBeLessThan(start.indexOf('class="cta-row"'));
  });

  it("dates the version line from that version's CHANGELOG heading", () => {
    const { version, date } = releaseLine();
    const changelog = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');

    expect(changelog.split('\n')).toContain(`## [${version}] - ${date}`);
  });

  it('writes the release count as a floor, rounded down to ten', () => {
    const { count } = releaseLine();

    expect(count).toBeGreaterThanOrEqual(10);
    expect(count % 10).toBe(0);
  });

  it("rewrites only the version line when the release skill's step runs", () => {
    const { status, before, after } = runReleaseLineScript(['9.9.9', '2099-01-31', '990']);

    expect(status).toBe(0);
    const changed = after.split('\n').filter((line, index) => line !== before.split('\n')[index]);
    expect(changed.map((line) => line.trim())).toEqual([
      '<p class="release-line">v9.9.9 · released 2099-01-31 · 990+ releases</p>',
    ]);
  });

  it('refuses to write the version line from a count that failed to arrive', () => {
    // `gh api … | wc -l` prints 0 when gh fails, which the skill turns into a
    // floor of 0. That has to stop the step, not ship "0+ releases".
    const { status, before, after } = runReleaseLineScript(['9.9.9', '2099-01-31', '0']);

    expect(status).toBe(1);
    expect(after).toBe(before);
  });

  it('adds the page to what the release commit stages', () => {
    const skill = fs.readFileSync(RELEASE_SKILL, 'utf-8');

    expect(skill).toMatch(/^git add package\.json package-lock\.json CHANGELOG\.md website\/index\.html$/m);
  });

  it('serves llms.txt inside the wording scans above', () => {
    // The banned-term and §5 scans walk textFiles(); a file they skip is a
    // file they cannot keep clean.
    expect(fs.existsSync(LLMS_TXT)).toBe(true);
    expect(textFiles().map((entry) => entry.file)).toContain('llms.txt');
  });

  it('links llms.txt to the docs, the tutorial and GitHub', () => {
    const targets = Array.from(llmsTxt().matchAll(/\]\(([^)]+)\)/g), ([, url]) => url);

    expect(targets).toEqual(
      expect.arrayContaining([
        `${REPO_URL}/tree/main/docs/en`,
        `${REPO_URL}/blob/main/docs/en/user-guide/tutorial.md`,
        REPO_URL,
      ]),
    );
  });

  it('quotes the same Node major in llms.txt that package.json engines requires', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    const quoted = Array.from(llmsTxt().matchAll(/Node\.js v(\d+)\+/g), ([, major]) => major);

    expect(quoted.length).toBeGreaterThan(0);
    expect(new Set(quoted)).toEqual(new Set([/(\d+)/.exec(pkg.engines.node)?.[1]]));
  });
});

/**
 * Issue #3060 — the page is rebuilt for a reader who arrived from a post on X
 * and has not decided anything yet: the three levels, then setting up by asking
 * an agent. What is pinned here is the Issue's acceptance criteria: the order
 * of the sections, the four numbers exactly as written (the estimate says it
 * is one), the line to paste pointing at setup.md with a working Copy button,
 * and the CSS that keeps a 390px phone from scrolling sideways.
 */
describe('Issue #3060: three levels and setup with your agent', () => {
  const SETUP_URL = 'https://kewton.github.io/CommandMate/setup.md';
  const SETUP_PROMPT = `Read ${SETUP_URL} and help me set up CommandMate on this machine. Explain each step before you run it, and ask me before you install anything or open access from the internet.`;

  /** The four numbers, and their wording, as the Issue's table and README.md write them. */
  const STATS = [
    '10+ PRs a day, solo',
    '$110–$210 a month: Claude Max + Command Code Goat',
    '~80% of my instructions sent from a phone (my estimate)',
    '689 PRs merged in September 2026, across my repositories',
  ];

  /** The 390px phone, less the page's side padding (1.25rem a side). */
  const PHONE_CONTENT_PX = 390 - 2 * 20;

  const html = (): string => readIndexHtml();

  const firstMatch = (source: string, pattern: RegExp, what: string): string => {
    const found = pattern.exec(source);

    expect(found, `${what} not found in index.html`).not.toBeNull();
    return found![0];
  };

  const hero = (): string => firstMatch(html(), /<section class="hero">[\s\S]*?<\/section>/, 'the hero');

  const section = (id: string): string =>
    firstMatch(html(), new RegExp(`<section class="section[^"]*" id="${id}"[\\s\\S]*?</section>`), `#${id}`);

  const heading = (fragment: string, tag: 'h1' | 'h2'): string =>
    text(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(fragment)?.[1] ?? '');

  /** styles.css with every `@media (min-width: …)` block taken out: what a phone gets. */
  const narrowCss = (): string => {
    let css = fs.readFileSync(STYLES_CSS, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (let open = css.indexOf('@media (min-width:'); open > -1; open = css.indexOf('@media (min-width:')) {
      let depth = 1;
      let at = css.indexOf('{', open) + 1;
      for (; at < css.length && depth > 0; at++) {
        if (css[at] === '{') depth++;
        if (css[at] === '}') depth--;
      }
      css = css.slice(0, open) + css.slice(at);
    }
    return css;
  };

  const toPx = (value: string, unit: string): number => Number(value) * (unit === 'rem' || unit === 'em' ? 16 : 1);

  it('orders the sections hero, problem, the three levels, setup, my setup, trust, start', () => {
    const page = html();
    const order = [
      '<section class="hero">',
      'id="problem"',
      'id="level-1"',
      'id="level-2"',
      'id="level-3"',
      'id="setup"',
      'id="my-setup"',
      'id="trust"',
      'id="start"',
    ].map((needle) => {
      const at = page.indexOf(needle);
      expect(at, `${needle} is not in index.html`).toBeGreaterThan(-1);
      return at;
    });

    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page.match(/<section\b/g) ?? []).toHaveLength(order.length);
    expect(page.slice(page.indexOf(section('start')) + section('start').length)).toMatch(/^\s*<\/main>/);
  });

  it('heads each section with the words the Issue gives it', () => {
    expect(heading(hero(), 'h1')).toBe('No long blocks of time? Run an AI team from your phone.');
    expect(heading(section('problem'), 'h2')).toBe(
      'Day job. Housework. Kids. Family time. Your project gets the gaps.',
    );
    expect(section('problem').match(/<li>/g) ?? []).toHaveLength(3);
    expect(heading(section('level-1'), 'h2')).toBe('Many agents, one place, in your pocket');
    expect(heading(section('level-2'), 'h2')).toBe('Work like a team, not a chat');
    expect(heading(section('level-3'), 'h2')).toBe('An AI team that builds and maintains');
    expect(heading(section('setup'), 'h2')).toBe('Set up with your agent');
    expect(heading(section('my-setup'), 'h2')).toBe('My setup');
  });

  it('shows the four numbers, and only those four, exactly as written', () => {
    const list = firstMatch(hero(), /<ul class="stats"[^>]*>[\s\S]*?<\/ul>/, 'the numbers');
    const stats = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => text(match[1]));

    expect(stats).toEqual(STATS);
    // The same four in README.md, so the two surfaces never disagree.
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8');
    for (const stat of STATS) {
      expect(readme.split('\n'), `README.md no longer says "${stat}"`).toContain(`- ${stat}`);
    }
    expect(fs.readFileSync(path.join(WEBSITE_DIR, 'llms.txt'), 'utf-8').split('\n')).toEqual(
      expect.arrayContaining(STATS.map((stat) => `- ${stat}`)),
    );
  });

  it('keeps the four numbers traceable to the messaging doc', () => {
    const facts = sectionBody('1');

    for (const stat of STATS) {
      expect(facts, `public-messaging.md §1 has no source for "${stat}"`).toContain(stat);
    }
  });

  it('offers the line to paste, pointing at setup.md, with a Copy button, in the hero and again in Start', () => {
    const inHero = copyableBoxes(hero());
    const inStart = copyableBoxes(section('start'));

    expect(inHero.map((box) => box.text)).toEqual([SETUP_PROMPT]);
    expect(inStart.map((box) => box.text)).toEqual([SETUP_PROMPT]);
    // The URL the line points at is a file this site serves.
    expect(fs.existsSync(path.join(WEBSITE_DIR, 'setup.md'))).toBe(true);
    expect(fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8')).toContain(SETUP_PROMPT);
  });

  it('ends each level on an "Ask your agent" line that points at setup.md', () => {
    for (const id of ['level-1', 'level-2', 'level-3']) {
      const ask = firstMatch(section(id), /<div class="ask">[\s\S]*?<\/div>\s*<\/div>/, `the ask box in #${id}`);
      const boxes = copyableBoxes(ask);

      expect(text(ask), id).toContain('Ask your agent');
      expect(boxes, id).toHaveLength(1);
      expect(boxes[0].text, id).toContain(SETUP_URL);
    }
  });

  it('says Level 1 runs on the plan you already pay for, and Level 3 that the daily run is an example', () => {
    expect(text(section('level-1'))).toContain('It runs on the plan you already pay for.');
    expect(section('level-1').match(/<li class="pillar">/g) ?? []).toHaveLength(4);
    expect(section('level-2').match(/<li class="pillar">/g) ?? []).toHaveLength(4);
    expect(section('level-3').match(/<li class="pillar">/g) ?? []).toHaveLength(2);
    expect(text(section('level-3'))).toContain('It is not a switch in the product.');
  });

  it('walks the five stages of setup.md, in its order and under its names, each with what the agent checks', () => {
    const guide = fs.readFileSync(path.join(WEBSITE_DIR, 'setup.md'), 'utf-8');
    const stagesInGuide = Array.from(guide.matchAll(/^## Stage \d+: (.+)$/gm), ([, name]) => name);
    const stages = Array.from(section('setup').matchAll(/<li class="stage">([\s\S]*?)<\/li>/g), ([, inner]) => inner);

    expect(stagesInGuide).toHaveLength(5);
    expect(stages.map((stage) => text(/<h3>([\s\S]*?)<\/h3>/.exec(stage)?.[1] ?? ''))).toEqual(stagesInGuide);
    for (const stage of stages) {
      expect(text(stage)).toMatch(/Your agent checks:/);
    }
  });

  it('names the phone connection by its command and both providers in My setup', () => {
    const rows = Array.from(section('my-setup').matchAll(/<tr>([\s\S]*?)<\/tr>/g), ([, row]) => text(row));

    expect(rows).toContain('Phone connection commandmate remote (Tailscale or Cloudflare) — —');
    expect(rows.some((row) => row.startsWith('Total') && row.includes(STATS[1]))).toBe(true);
  });

  it('closes with Star on GitHub, Follow on X and the README', () => {
    const links = Array.from(section('start').matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g), ([, href, label]) => [
      text(label),
      href,
    ]);

    expect(links).toEqual([
      ['Star on GitHub', 'https://github.com/Kewton/CommandMate'],
      ['Follow on X', 'https://x.com/SibaKotaro'],
      ['Read the README', 'https://github.com/Kewton/CommandMate#readme'],
    ]);
  });

  it('sets no fixed width on a 390px phone wider than the content box', () => {
    const wide = Array.from(
      narrowCss().matchAll(/(?:^|[;{\s])((?:min-|max-)?width|flex-basis)\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)\b/g),
    )
      .filter(([, property]) => property !== 'max-width')
      .filter(([, , value, unit]) => toPx(value, unit) > PHONE_CONTENT_PX)
      .map(([declaration]) => declaration.trim());

    // The one exception is a table inside .table-scroll, which scrolls in its
    // own box rather than widening the page.
    expect(wide.filter((declaration) => !/min-width:\s*34rem/.test(declaration))).toEqual([]);
    for (const table of html().match(/<table\b[\s\S]*?<\/table>/g) ?? []) {
      expect(html().slice(0, html().indexOf(table)), 'a table outside .table-scroll').toMatch(
        /<div class="table-scroll"[^>]*>\s*$/,
      );
    }
  });

  it('lets every grid column shrink to a phone', () => {
    const fixedTracks = Array.from(narrowCss().matchAll(/grid-template-columns\s*:\s*([^;]+);/g), ([, value]) => value)
      .map((value) => value.replace(/min\(100%,\s*[^)]+\)/g, '').replace(/minmax\(0,\s*[^)]+\)/g, ''))
      .filter((value) => /\d(?:px|rem|em)\b/.test(value));

    expect(fixedTracks).toEqual([]);
  });

  it('wraps the line to paste instead of letting its URL widen the page', () => {
    const css = fs.readFileSync(STYLES_CSS, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.install-prompt\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(rule).toMatch(/white-space:\s*normal/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.install-cmd\s*\{[^}]*min-width:\s*0/);
    // Every drawing shrinks with its column.
    for (const drawing of INLINE_DRAWINGS) {
      const rules = Array.from(css.matchAll(new RegExp(`([^{}]*\\.${drawing}(?:\\s*,[^{}]*)?)\\s*\\{([^}]*)\\}`, 'g')))
        .filter(([, selector]) => selector.split(',').some((one) => one.trim() === `.${drawing}`))
        .map(([, , body]) => body)
        .join('\n');

      expect(rules, drawing).toMatch(/width:\s*100%/);
      expect(rules, drawing).toMatch(/height:\s*auto/);
    }
  });

  it('carries the new one line in llms.txt', () => {
    const llms = fs.readFileSync(path.join(WEBSITE_DIR, 'llms.txt'), 'utf-8');

    expect(llms.split('\n')[0]).toBe(`# CommandMate — ${heading(hero(), 'h1')}`);
    expect(llms).toContain(SETUP_PROMPT);
  });
});
