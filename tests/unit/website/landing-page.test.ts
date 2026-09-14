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
 *
 * Issue #2551 gave the hero to a drawing of the product — sessions, then gate
 * lines — and moved the loop down to The loop. The colour guard now scans every
 * drawing in INLINE_DRAWINGS rather than the one that happens to be in the hero.
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
 * all of its inks from custom properties. #1812 had one, the loop in the hero;
 * #2551 put a session mock in the hero and moved the loop to The loop — a
 * drawing that leaves the hero still has to follow the colour scheme, so the
 * scan grew rather than moved. A new drawing is one more entry here.
 */
const INLINE_DRAWINGS = ['hero-mock', 'loop-diagram', 'trust-diagram'];

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
 * Page order, lead first. #2495 moved "See it running" above The loop and put
 * the orchestrate run at its head, so the order is the argument the section
 * makes: one real run, then the gate that judged it, where the method came
 * from, the parallelism it ran under, and how it reaches you when it stops.
 */
const DEMO_ORDER = [LEAD_DEMO, ...Object.keys(DEMO_SOURCES)];

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
 * What Issue #1812 measured on this page before the rewrite and required gone.
 * These are shorter than some of the doc's rows on purpose — the old H1 is
 * banned as a whole sentence there, but the LP carried it split across a `<br>`
 * and rephrased in three meta tags, so the substring is what actually finds it.
 *
 * Every competitor name the doc bans is mirrored here, and a test pins that
 * (Issue #2549). The mirror is what makes deleting such a row from the doc
 * loud: the term stays here, so the traceability check fails, instead of the
 * name quietly dropping out of the union the page is scanned for.
 */
const LP_BANNED_TERMS = [
  'control plane',
  'Orchestrate your agent CLIs',
  'Remote Control',
  'Happy Coder',
  'claude-squad',
  'Omnara',
  'Orca',
  'Herdr',
  'Lanes',
];

/**
 * The two rows of `docs/design/public-messaging.md` §11b that cannot be scanned
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
 * rather than restated for the same reason `definitionEn()` is read out of the
 * file: a copy of the wording here would be the second place it could drift,
 * and #2493 renumbered which demo maps to which card without touching a single
 * string — a hand-copied expectation would have stayed green through that.
 */
function sectionBody(section: string): string {
  const lines = fs.readFileSync(MESSAGING_DOC, 'utf-8').split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${section}.`));

  expect(start, `public-messaging.md has no "## ${section}." section`).toBeGreaterThan(-1);

  // Fence-aware rather than a plain "up to the next `## `": §1b's en block is a
  // fenced sample of the section as it renders, so it opens with a `## ` line of
  // its own, and a naive scan ends the section in the middle of the block it was
  // looking for.
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
 * Fence-aware like sectionBody(): §3e's contract YAML opens with a `# ` comment.
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

/** The contents of the first fenced block in a markdown fragment. */
function firstFence(markdown: string): string {
  const fence = /^```[^\n]*\n([\s\S]*?)\n```/m.exec(markdown);

  expect(fence, 'expected a fenced block in public-messaging.md').not.toBeNull();
  return fence![1];
}

/** Markdown copy as the page renders it: code spans become `<code>`, which text() drops. */
function prose(markdown: string): string {
  return markdown.replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

/** One labelled row of the §1 hero table, by the label its first cell starts with. */
function heroRow(label: string): string {
  const row = messagingTable('1').find((cells) => cells[0].startsWith(label));

  expect(row, `public-messaging.md §1 has no "${label}…" row`).not.toBeUndefined();
  return row![1];
}

/** The en title and sentence of each §3 card, in the order the doc lists them. */
function messagingCards(): { title: string; body: string }[] {
  return messagingTable('3').map((cells) => ({ title: cells[1], body: cells[2] }));
}

/** The en caption of each numbered §5 demo, hero cut excluded. */
function messagingCaptions(): string[] {
  return messagingTable('5')
    .filter((cells) => /^\d+$/.test(cells[0]))
    .map((cells) => cells[3]);
}

/**
 * The claims §11b puts outside what has actually been measured. Backticked
 * first cells only, which is exactly the "言えないこと" table: the "言えること"
 * rows above it are prose.
 */
function unmeasuredClaims(): string[] {
  return messagingTable('11b')
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
 * Issue #2551 — the hero shows the product instead of the loop: a session list
 * with one row waiting on a person, above the gate lines `commandmate wait
 * --verify` prints. "Gate" is used elsewhere for a question an agent stops to
 * ask; this drawing is where the page defines it as a declared command and its
 * exit code. The loop drawing moved down to the head of The loop.
 *
 * The block above still carries the four hero guards and now scans both
 * drawings' CSS. What it cannot see is the markup: an ink written as a `fill=`
 * attribute on the SVG never reaches styles.css, and a class the scan reads
 * that no drawing wears is a scan of nothing. Those two are pinned here.
 */
describe('Issue #2551: the session mock in the hero, the loop in The loop', () => {
  const drawingMarkup = (drawing: string): string => {
    const svg = new RegExp(`<svg\\s+class="${drawing}"[\\s\\S]*?</svg>`).exec(readIndexHtml());

    expect(svg, `no <svg class="${drawing}"> in index.html`).not.toBeNull();
    return svg![0];
  };

  const loopSection = (): string => {
    const section = /<section class="section" id="loop"[\s\S]*?<\/section>/.exec(readIndexHtml());

    expect(section, 'no #loop section in index.html').not.toBeNull();
    return section![0];
  };

  it('draws the session mock in the hero, and the loop nowhere else but The loop', () => {
    const hero = /<figure class="hero-media">[\s\S]*?<\/figure>/.exec(readIndexHtml())![0];

    expect(hero).toContain(drawingMarkup('hero-mock'));
    expect(hero).not.toContain('loop-diagram');
    expect(readIndexHtml().split('class="loop-diagram"')).toHaveLength(2);
  });

  it('opens The loop on the loop drawing, before the four beats', () => {
    const section = loopSection();
    const svg = drawingMarkup('loop-diagram');

    expect(section, 'the loop drawing must sit in #loop').toContain(svg);
    expect(section.indexOf(svg)).toBeLessThan(section.indexOf('<ol class="beats">'));
    // It left the hero, so the hero guards above no longer look at it.
    expect(svg).toMatch(/role="img"/);
    expect(/aria-label="([^"]+)"/.exec(svg)?.[1].length ?? 0).toBeGreaterThan(40);
    expect(svg).toMatch(/viewBox="[^"]+"\s+width="\d+"\s+height="\d+"/);
  });

  it('marks one session as needing you, above gate lines in the verify output format', () => {
    const svg = drawingMarkup('hero-mock');
    const pills = [...svg.matchAll(/<text class="pill-label"[^>]*>([\s\S]*?)<\/text>/g)].map(
      (match) => text(match[1]),
    );
    const terminal = [...svg.matchAll(/<text class="term[\s"][^>]*>([\s\S]*?)<\/text>/g)].map(
      (match) => text(match[1]),
    );

    expect(pills).toHaveLength(4);
    expect(pills.filter((label) => label === 'needs you')).toHaveLength(1);
    expect(pills.filter((label) => label === 'working' || label === 'done')).toHaveLength(3);
    expect(svg, 'the needs-you row is the amber one').toMatch(
      /<g class="session session-needs">(?:(?!<\/g>)[\s\S])*needs you/,
    );
    // The shapes src/cli/utils/verify-runner.ts prints: `GATE <id> <LABEL>`
    // with an optional `(detail)`, then `RESULT <status>`.
    expect(terminal).toEqual([
      '$ commandmate wait wt-pick --verify',
      'GATE work-evidence PASS',
      'GATE unit PASS (exit=0)',
      'RESULT passed',
      '$ echo $?',
      '0',
    ]);
  });

  it('writes no ink into the markup of either drawing, where the CSS scan cannot see it', () => {
    const offenders = INLINE_DRAWINGS.flatMap((drawing) =>
      [...drawingMarkup(drawing).matchAll(/\s(fill|stroke|color|stop-color|style)="[^"]*"/g)].map(
        (match) => `.${drawing}: ${match[0].trim()}`,
      ),
    );

    expect(offenders).toEqual([]);
  });
});

/**
 * Issue #2554 — the network-scope note under the cards becomes a section of its
 * own, "Runs on your machine", with a drawing of the machine and the two
 * connections every session has. The words are public-messaging.md §14 between
 * its `trust:en` markers, split without a word changed: the lede is what
 * CommandMate itself does, the drawing's footnote is what goes over the network
 * and when. Both halves are read from the doc, and the footnote's length from
 * §14's evidence table, so a route added there stays red here until the page
 * lists it too.
 *
 * The colour scan in the #1812 block and the markup scan in the #2551 block reach
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

  /** §14's en sentence as the page renders it, read between its `trust:en` markers. */
  const trustEn = (): string => {
    const doc = fs.readFileSync(MESSAGING_DOC, 'utf-8');
    const match = /<!-- trust:en -->([\s\S]*?)<!-- \/trust:en -->/.exec(doc);

    expect(
      match,
      'docs/design/public-messaging.md must delimit the §14 en sentence with <!-- trust:en --> … <!-- /trust:en -->',
    ).not.toBeNull();
    return prose(match![1]);
  };

  /** The rows of one `### ` table in §14, its header row dropped. */
  const trustTable = (heading: string): string[][] => {
    const [header, ...rows] = tableRows(headingBody(sectionBody('14'), heading));

    expect(header, `§14 has no table under "${heading}"`).not.toBeUndefined();
    return rows;
  };

  it('follows "What it gives you" directly, under the heading the Issue names', () => {
    expect(readIndexHtml()).toMatch(
      /<h2 id="why">[\s\S]*?<\/section>\s*(?:<!--(?:(?!-->)[\s\S])*-->\s*)?<section class="section" id="trust"/,
    );
    expect(text(firstGroup(trustSection(), /<h2 id="trust-h">([\s\S]*?)<\/h2>/, 'the #trust heading'))).toBe(
      'Runs on your machine',
    );
  });

  it('states §14 verbatim: the lede, then the footnote under the drawing', () => {
    const section = trustSection();
    const lede = text(firstGroup(section, /<p class="trust-lede">([\s\S]*?)<\/p>/, 'the #trust lede'));

    // One string split in two, not two strings: joined back, it has to be §14
    // to the character, so neither half can be reworded or trimmed on its own.
    expect(`${lede} ${text(footnote())}`).toBe(trustEn());
    expect(section.indexOf('class="trust-lede"')).toBeLessThan(section.indexOf('<svg'));
    expect(section.indexOf('</svg>')).toBeLessThan(section.indexOf('<figcaption'));
  });

  it("lists one footnote per route in §14's evidence table", () => {
    const routes = [...footnote().matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => text(match[1]));
    const evidence = trustTable('### 機能ごとの通信');

    // §14's rule: a route is dropped from the sentence only after the table
    // shows the traffic itself is gone. So the table's length is the list's.
    expect(evidence.length).toBeGreaterThan(0);
    expect(routes).toHaveLength(evidence.length);
  });

  it('leaves no copy of the note under the cards', () => {
    const cards = firstGroup(readIndexHtml(), /(<h2 id="why">[\s\S]*?<\/section>)/, 'the cards section');

    expect(cards).not.toContain('class="note"');
    expect(text(cards)).not.toMatch(/telemetry|over the network/i);
  });

  it('carries none of the network wording §14 retracted, anywhere Pages serves', () => {
    const rows = trustTable('### 書かない表現');
    const terms = (conditional: boolean): string[] =>
      rows
        .filter(([cell]) => cell.includes('無条件') === conditional)
        .flatMap(([cell]) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1].toLowerCase()));
    // The Issue's own criterion, as a literal too: §14 lists the whole retracted
    // sentence, and the start of it is what would come back reworded.
    const banned = ['the only network traffic', ...terms(false)];
    // "No external server" is retracted only as a bare claim; §14's own
    // replacement says it needs none "to run".
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

  it('scans the drawing with the colour and markup guards of the other two', () => {
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

  it('embeds the five demos in page order, the recorded run first', () => {
    // #1812 cut the set to one demo per card in public-messaging.md §3. #2495
    // put a real orchestrate run at the head of it and moved the whole section
    // above The loop, so the order is the argument the section makes: one run
    // end to end, then the gate that judged it, where the method came from, the
    // parallelism it ran under, and how it reaches you when it stops.
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
 * Issue #2555 — the page had grown to about fifteen screens on a laptop and
 * twenty-seven on a phone. Three things on it repeat what the docs already say,
 * so they were folded or cut, with no wording changed: Track B folds into a
 * <details>, "Pair your phone" keeps its lede, its command and the link to the
 * CLI operations guide, and the gallery keeps four of its seven shots.
 *
 * The heights need a browser and are measured outside this suite. What is
 * pinned here is the markup that made the page shorter, and that nothing a
 * reader could still act on went with it: the fold still holds every command
 * and its copy button, and the guide still carries what the cut cards said.
 */
describe('Issue #2555: compact', () => {
  const CSS_BLOCK_START = '/* Compact (#2555) */';
  const CSS_BLOCK_END = '/* /Compact (#2555) */';
  const CLI_OPERATIONS_GUIDE = 'docs/en/user-guide/cli-operations-guide.md';
  const TRACK_B_COMMANDS = ['npm install -g commandmate', 'commandmate init', 'commandmate start --daemon'];

  /** The four shots the gallery keeps, in page order: the og:image first. */
  const GALLERY_SHOTS = [
    OG_IMAGE,
    'assets/img/screenshot-worktree-desktop-chat.webp',
    'assets/img/screenshot-mobile.webp',
    'assets/img/screenshot-worktree-mobile-chat.webp',
  ];

  /**
   * The three it dropped. They are unreferenced but still on disk: stills.ts
   * writes a webp for each of them, because the docs use their PNGs, and
   * tests/unit/skills/demo-video/stills.test.ts requires that webp to exist —
   * a file this Issue's scope could not change.
   */
  const DROPPED_SHOTS = [
    'assets/img/screenshot-worktree-desktop.webp',
    'assets/img/screenshot-worktree-mobile.webp',
    'assets/img/screenshot-worktree-mobile-terminal.webp',
  ];

  const firstMatch = (html: string, pattern: RegExp, what: string): string => {
    const found = pattern.exec(html);

    expect(found, `${what} not found in index.html`).not.toBeNull();
    return found![0];
  };

  const trackB = (): string =>
    firstMatch(readIndexHtml(), /<article class="track" aria-labelledby="track-daily-h">[\s\S]*?<\/article>/, 'the Track B card');

  const fold = (): string => firstMatch(trackB(), /<details\b[^>]*>[\s\S]*?<\/details>/, 'the Track B <details>');

  const remoteSection = (): string =>
    firstMatch(readIndexHtml(), /<section class="section" id="remote"[\s\S]*?<\/section>/, 'the #remote section');

  const gallerySection = (): string =>
    firstMatch(readIndexHtml(), /<section class="section" aria-labelledby="gallery-h">[\s\S]*?<\/section>/, 'the gallery');

  /** styles.css between this Issue's own opening and closing comments. */
  const compactCss = (): string => {
    const css = fs.readFileSync(STYLES_CSS, 'utf-8');
    const start = css.indexOf(CSS_BLOCK_START);
    const end = css.indexOf(CSS_BLOCK_END);

    expect(start, `styles.css must open the compact rules with ${CSS_BLOCK_START}`).toBeGreaterThan(-1);
    expect(end, `styles.css must close the compact rules with ${CSS_BLOCK_END}`).toBeGreaterThan(start);
    return css.slice(start, end);
  };

  it('folds Track B into a <details> that opens on "Install it for daily use"', () => {
    const details = fold();
    const summary = firstMatch(details, /<summary>([\s\S]*?)<\/summary>/, 'the Track B <summary>');

    expect(text(summary)).toBe('Install it for daily use');
    // The card is still labelled by its heading, which now sits in the summary.
    expect(summary).toMatch(/<h3 id="track-daily-h">/);
    // Folded by default, and toggled by the browser alone, as the FAQ is.
    expect(details).not.toMatch(/<details\b[^>]*\bopen\b/);
    expect(details).not.toMatch(/<(?:details|summary)\b[^>]*\b(?:role|tabindex|onclick)=/);
  });

  it('keeps every Track B command and its copy button inside the fold', () => {
    expect(copyableCommands(fold())).toEqual(TRACK_B_COMMANDS);
    expect(copyableCommands(trackB().replace(fold(), ''))).toEqual([]);
  });

  it('leaves Track A and the stop-the-server note outside any fold', () => {
    const section = firstMatch(readIndexHtml(), /<section class="section" id="quick-start"[\s\S]*?<\/section>/, 'the quick start')
      // The comment above Track B names the element it explains.
      .replace(/<!--[\s\S]*?-->/g, '');

    expect(trackAMarkup()).not.toMatch(/<details\b/);
    expect(section.match(/<details\b/g) ?? []).toHaveLength(1);
    expect(section.slice(section.indexOf('</details>'))).toMatch(/commandmate stop/);
  });

  it('cuts "Pair your phone" to its lede, the command and the link to the CLI operations guide', () => {
    const section = remoteSection();

    expect(section.match(/<h[2-6]\b/g) ?? []).toEqual(['<h2']);
    expect(section).not.toMatch(/<article\b|class="(?:cards|card|note)\b/);
    expect(section.match(/<p class="([^"]+)"/g) ?? []).toEqual(['<p class="section-lede"', '<p class="remote-docs"']);
    expect(copyableCommands(section)).toEqual(['commandmate remote']);
    expect(section).toContain(`href="https://github.com/Kewton/CommandMate/blob/main/${CLI_OPERATIONS_GUIDE}"`);
  });

  it('leaves what the cut cards said in the CLI operations guide the section links to', () => {
    // The cards could go only because the guide says the same; if a heading
    // there is renamed or removed, the page has to be looked at again.
    const guide = fs.readFileSync(path.join(REPO_ROOT, CLI_OPERATIONS_GUIDE), 'utf-8');
    const start = guide.indexOf('\n### commandmate remote\n');

    expect(start, `${CLI_OPERATIONS_GUIDE} has no "### commandmate remote" section`).toBeGreaterThan(-1);
    const end = guide.indexOf('\n### ', start + 1);
    const remote = guide.slice(start, end === -1 ? undefined : end);

    for (const heading of [
      '#### Provider status', // one of two providers, or DEPENDENCY_ERROR
      '#### A public tunnel needs explicit approval', // nothing public without a yes
      '#### Pairing code', // a code that runs out
      '#### Expiry closes the outward door only', // the session closes itself
      '#### remote stop does not guess', // one door, and you close it
    ]) {
      expect(remote.split('\n'), `the guide's remote section lost "${heading}"`).toContain(heading);
    }
    for (const fact of ['DEPENDENCY_ERROR', '--pairing-expires', 'never writes `CM_BIND`', 'Auto-Yes stays off']) {
      expect(remote, `the guide's remote section no longer says ${fact}`).toContain(fact);
    }
  });

  it('shows four shots in the gallery, the og:image first', () => {
    const shots = Array.from(gallerySection().matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g), ([, src]) => src);

    expect(shots).toEqual(GALLERY_SHOTS);
  });

  it('names the three shots it dropped nowhere under website/', () => {
    const names = DROPPED_SHOTS.map((shot) => path.basename(shot));

    expect(
      textFiles().flatMap(({ file, body }) => names.filter((name) => body.includes(name)).map((name) => `${file}: ${name}`)),
    ).toEqual([]);
  });

  it('ships no image under assets/img/ that the page does not reference, but the three stills.ts owns', () => {
    const refs = new Set(extractRefs(readIndexHtml()));
    const unreferenced = walk(path.join(WEBSITE_DIR, 'assets', 'img'))
      .map((file) => `assets/img/${file.split(path.sep).join('/')}`)
      .filter((file) => !refs.has(file));

    // A subset rather than equality, so deleting them once stills.ts stops
    // writing them needs no edit here.
    expect(unreferenced.filter((file) => !DROPPED_SHOTS.includes(file))).toEqual([]);
  });

  it('keeps the fold and the gallery layout inside its one commented block in styles.css', () => {
    const css = fs.readFileSync(STYLES_CSS, 'utf-8');
    const block = compactCss();
    const outside = css.replace(block, '');

    expect(block).toMatch(/\.track-fold\b/);
    expect(block).toMatch(/\.gallery\s*\{[^}]*grid-template-columns/);
    expect(block).toMatch(/\.shot-wide\s*\{/);
    expect(outside, 'a fold rule outside the /* Compact (#2555) */ block').not.toMatch(/\.track-fold\b/);
    expect(outside, 'gallery columns outside the /* Compact (#2555) */ block').not.toMatch(
      /\.gallery\s*\{[^}]*grid-template-columns|\.shot-wide\b/,
    );
    // The card grid the remote section no longer has leaves no rule behind.
    expect(css).not.toMatch(/\.remote-cards\b/);
    expect(readIndexHtml()).not.toMatch(/remote-cards/);
  });
});

/**
 * Issue #2555, second pass — the page was still taller than it was before Epic
 * #2548 on a laptop, and the Epic's additions repeated each other. Four places
 * were folded or laid out closer, again with no wording changed: The loop's
 * beats become one band with their code folded (the page shows a whole contract
 * under One agent leads and gate lines in the hero), the four feature demos sit
 * two by two, the Catalog IDs fold under their §3d label, and the closing call
 * to action shares Philosophy's section.
 *
 * The heights are measured in a browser outside this suite. What is pinned here
 * is the markup and the one CSS block that made the page shorter, and that what
 * the other blocks read — the four beats, the five demos and their playback, §3c,
 * §3d, the definition and #philosophy — is still where they read it.
 */
describe('Issue #2555: compact (2)', () => {
  const CSS_BLOCK_START = '/* Compact 2 (#2555) */';
  const CSS_BLOCK_END = '/* /Compact 2 (#2555) */';

  const firstMatch = (html: string, pattern: RegExp, what: string): string => {
    const found = pattern.exec(html);

    expect(found, `${what} not found in index.html`).not.toBeNull();
    return found![0];
  };

  const section = (opening: string): string =>
    firstMatch(readIndexHtml(), new RegExp(`${opening}[\\s\\S]*?</section>`), opening);

  const beats = (): string[] =>
    Array.from(
      firstMatch(section('<section class="section" id="loop"'), /<ol class="beats">[\s\S]*?<\/ol>/, 'the beats').matchAll(
        /<li class="beat">([\s\S]*?)<\/li>/g,
      ),
      ([, inner]) => inner,
    );

  /** The four cards' markup, comments dropped: the one above the Catalog fold names the element it explains. */
  const cards = (): string[] =>
    Array.from(
      firstMatch(readIndexHtml(), /<h2 id="why">[\s\S]*?<\/section>/, 'the cards section').matchAll(
        /<article class="card">([\s\S]*?)<\/article>/g,
      ),
      ([, inner]) => inner.replace(/<!--[\s\S]*?-->/g, ''),
    );

  /** styles.css between this pass's own opening and closing comments. */
  const compactCss = (): string => {
    const css = fs.readFileSync(STYLES_CSS, 'utf-8');
    const start = css.indexOf(CSS_BLOCK_START);
    const end = css.indexOf(CSS_BLOCK_END);

    expect(start, `styles.css must open the rules with ${CSS_BLOCK_START}`).toBeGreaterThan(-1);
    expect(css.indexOf(CSS_BLOCK_START, start + 1), `${CSS_BLOCK_START} must open one block`).toBe(-1);
    expect(end, `styles.css must close the rules with ${CSS_BLOCK_END}`).toBeGreaterThan(start);
    return css.slice(start, end);
  };

  /** Every `@media (<query>) { … }` block in a CSS fragment, whole, braces balanced. */
  const mediaBlocks = (css: string, query: string): string[] => {
    const blocks: string[] = [];
    for (let open = css.indexOf(`@media (${query}) {`); open > -1; open = css.indexOf(`@media (${query}) {`, open + 1)) {
      let depth = 1;
      let at = css.indexOf('{', open) + 1;
      for (; at < css.length && depth > 0; at++) {
        if (css[at] === '{') depth++;
        if (css[at] === '}') depth--;
      }
      blocks.push(css.slice(open, at));
    }

    expect(blocks.length, `no @media (${query}) block`).toBeGreaterThan(0);
    return blocks;
  };

  it('lays the four beats out as one band: four across from 901px, stacked below it', () => {
    const block = compactCss();
    const wide = mediaBlocks(block, 'min-width: 901px');
    const narrow = wide.reduce((css, media) => css.replace(media, ''), block);
    const outside = fs.readFileSync(STYLES_CSS, 'utf-8').replace(block, '');

    expect(beats().map((beat) => text(/^\s*<h3>([\s\S]*?)<\/h3>/.exec(beat)?.[1] ?? ''))).toEqual([
      'The requirement',
      'The contract',
      'The agent runs',
      'The verdict',
    ]);
    expect(narrow).toMatch(/\.beats\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(wide.join('\n')).toMatch(/\.beats\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
    expect(outside, 'beat columns outside the /* Compact 2 (#2555) */ block').not.toMatch(
      /\.beats\s*\{[^}]*grid-template-columns/,
    );
  });

  it("folds each beat's code under the artifact it holds, in words the page already carries", () => {
    const [requirement, ...coded] = beats();
    const faq = section('<section class="section" id="faq"');

    expect(requirement, 'the requirement has no code to fold').not.toMatch(/<details\b/);
    const folds = coded.map((beat) => {
      expect(beat.match(/<details\b/g) ?? [], beat).toHaveLength(1);
      const details = firstMatch(beat, /<details class="beat-fold">[\s\S]*?<\/details>/, 'a beat fold');
      const summary = /^<details class="beat-fold">\s*<summary><code>([^<]+)<\/code><\/summary>/.exec(details);

      expect(summary, `a beat fold must open on a bare <summary> holding one <code>:\n${details}`).not.toBeNull();
      // The sentence stays in view: it comes before the fold, not inside it.
      expect(beat.indexOf('<p>')).toBeLessThan(beat.indexOf('<details'));
      return {
        label: summary![1],
        snippet: firstMatch(details, /<pre class="snippet"><code>[\s\S]*?<\/code><\/pre>/, 'the folded snippet'),
      };
    });

    expect(folds.map((fold) => fold.label)).toEqual(['fix-shout.yaml', 'commandmate send', 'commandmate wait --verify']);
    // No new words: the file and the send command are named out of their own
    // snippet, and the verdict's command the way the FAQ writes it.
    expect(coded[0]).toContain('<p class="snippet-label">.commandmate/tasks/fix-shout.yaml</p>');
    expect(folds[1].snippet).toContain('$ commandmate send wt-shout');
    expect(faq).toContain(`<code>${folds[2].label}</code>`);
    expect(folds[2].snippet).toContain('$ commandmate wait wt-shout --verify');
    expect(folds[2].snippet).toContain('RESULT passed');
    for (const beat of coded) {
      expect(beat, 'folded by default').not.toMatch(/<details\b[^>]*\bopen\b/);
      expect(beat).not.toMatch(/<(?:details|summary)\b[^>]*\b(?:role|tabindex|onclick)=/);
    }
  });

  it('puts the four feature demos two by two under the Measured table, and folds none of them', () => {
    const demos = section('<section class="section" id="demos"');
    const grid = firstMatch(demos, /<div class="demos">[\s\S]*<\/div>/, 'the demo grid');
    const block = compactCss();
    const outside = fs.readFileSync(STYLES_CSS, 'utf-8').replace(block, '');

    expect(grid.match(/<figure class="demo">/g) ?? []).toHaveLength(Object.keys(DEMO_SOURCES).length);
    expect(demos.indexOf('<div class="measured">')).toBeLessThan(demos.indexOf('<div class="demos">'));
    // Inside a closed <details> a demo never reaches the observer's threshold,
    // so none of the five is behind one.
    expect(demos).not.toMatch(/<details\b/);
    expect(block).toMatch(/\.demos\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(outside, 'demo columns outside the /* Compact 2 (#2555) */ block').not.toMatch(
      /\.demos\s*\{[^}]*grid-template-columns/,
    );
  });

  it('folds the Catalog IDs under their §3d label, and leaves §3c in view under card 1', () => {
    const [first, , , fourth] = cards();
    const fold = firstMatch(fourth, /<details\b[^>]*>[\s\S]*?<\/details>/, 'the Catalog fold');
    const label = messagingTable('3d').find((cells) => cells[0] === 'en')?.[1];

    expect(fold).toMatch(/^<details class="card-more catalog-fold">\s*<summary id="catalog-h">/);
    expect(text(firstMatch(fold, /<summary\b[^>]*>[\s\S]*?<\/summary>/, 'the Catalog summary'))).toBe(label);
    expect(fold.match(/<ul class="chips" aria-labelledby="catalog-h">/g) ?? []).toHaveLength(1);
    expect(fold.match(/<li><code>cmate-[^<]+<\/code><\/li>/g) ?? []).toHaveLength(14);
    expect(fold).not.toMatch(/<details\b[^>]*\bopen\b/);
    expect(fold).not.toMatch(/<(?:details|summary)\b[^>]*\b(?:role|tabindex|onclick)=/);
    // §3c is a paragraph a reader sees without opening anything.
    expect(first).not.toMatch(/<details\b/);
    expect(first).toMatch(/<p class="card-more">/);
  });

  it('makes the closing call to action and Philosophy one section, the last in <main>, still #philosophy', () => {
    const html = readIndexHtml();
    const merged = section('<section class="section philosophy" id="philosophy" aria-labelledby="philosophy-h">');

    expect(html).not.toMatch(/<section class="section closing"/);
    expect(html.match(/\sid="philosophy"/g) ?? []).toHaveLength(1);
    expect(merged.indexOf('<div class="closing">')).toBeGreaterThan(-1);
    expect(merged.indexOf('<div class="closing">')).toBeLessThan(merged.indexOf('<div class="philosophy-body">'));
    expect(text(firstMatch(merged, /<div class="closing">\s*<h2>[\s\S]*?<\/h2>/, 'the closing heading'))).toBe(
      'Start in one command',
    );
    expect(copyableCommands(merged)).toEqual(['npx commandmate@latest']);
    expect(merged.replace(/\s+/g, ' ')).toContain(definitionEn());
    expect(html.slice(html.indexOf(merged) + merged.length)).toMatch(/^\s*<\/main>/);
  });

  it('keeps its rules in one commented block, with no motion for reduced motion to switch off', () => {
    const block = compactCss();
    const outside = fs.readFileSync(STYLES_CSS, 'utf-8').replace(block, '');

    for (const rule of [/\.beat-fold\b/, /\.catalog-fold\b/, /\.philosophy-body\b/, /#loop\b/]) {
      expect(block).toMatch(rule);
      expect(outside, `${rule} outside the /* Compact 2 (#2555) */ block`).not.toMatch(rule);
    }
    // The FAQ switches its chevron's transition off by hand; these folds never
    // declare one, so the page-wide reduced-motion rule has nothing to shorten.
    expect(block.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\b(?:transition|animation)(?:-[a-z]+)?\s*:/);
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

  it('names the axis and states the definition verbatim in the Philosophy section', () => {
    expect(normalizedHtml()).toContain('Vibe Engineering');

    // Scoped to one section rather than the whole file, because a page-wide
    // `toContain` stays green with the visible copy paraphrased — measured, not
    // assumed: swapping "expertise" for "skills" passed the page-wide form.
    // #2495 moved the sentence out of the hero and into Philosophy; what has to
    // hold is that it is somewhere on the page verbatim, not where it sits.
    const philosophy = /<section class="section philosophy"[\s\S]*?<\/section>/.exec(
      readIndexHtml(),
    );

    expect(philosophy, 'philosophy section not found in index.html').not.toBeNull();
    expect(
      philosophy![0].replace(/\s+/g, ' '),
      'the en definition must be copied into the page, not paraphrased',
    ).toContain(definitionEn());
  });

  it('opens on the hero line the messaging doc settled on', () => {
    // Read from the doc rather than restated: #2493 replaced this line outright,
    // and a hand-copied literal here is exactly what would have kept the old one
    // green. §1 is the only place the H1 is decided.
    expect(normalizedHtml()).toContain(`<h1>${heroRow('H1（en')}</h1>`);
  });

  it('carries the H1 in the title and in both social tags', () => {
    // Until #2495 these carried the axis word, because the axis word was the H1.
    // It is the Philosophy heading now, so what the card and the tab have to
    // carry is the claim the page actually opens on.
    const html = readIndexHtml();
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? '';
    const ogTitle = /<meta property="og:title" content="([^"]+)"/.exec(html)?.[1] ?? '';
    const description = /<meta\s+name="description"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    const ogDescription =
      /<meta\s+property="og:description"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';

    const h1 = heroRow('H1（en');
    const [lede] = heroRow('lede（en').split(/(?<=\.)\s+/);

    for (const [name, value] of Object.entries({ title, ogTitle })) {
      expect(value, `${name} is missing from index.html`).toBe(`CommandMate — ${h1}`);
    }
    for (const [name, value] of Object.entries({ description, ogDescription })) {
      expect(value, `${name} must open on the lede's first sentence`).toBe(lede);
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
 * Issue #2495 — the page moved onto the orchestrate axis: the H1 says who leads
 * and what decides completion, the reader's own problem comes before anything
 * the product does, a recorded run opens "See it running" above The loop, and
 * the axis word steps down to a Philosophy section above the footer.
 *
 * The assertions below read `docs/design/public-messaging.md` rather than
 * restating it. That file is the single source, and #2493 rewrote the H1, the
 * lede, all four card titles and the demo-to-card mapping without changing a
 * single file under `website/` — against hand-copied expectations this suite
 * would have stayed green through the whole of it.
 */
describe('Issue #2495: the LP on the orchestrate axis', () => {
  /** The fenced en block of one section, as its lines. */
  function enBlock(section: string): string[] {
    const fenced = /\n### en\n+```\n([\s\S]*?)```/.exec(sectionBody(section));

    expect(fenced, `public-messaging.md §${section} must carry a fenced en block`).not.toBeNull();
    return fenced![1].split('\n');
  }

  const bullets = (lines: string[]): string[] =>
    lines.filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim());

  /** The en rows of the §2 tables: the axis name, the definition, the creed. */
  const philosophyRows = (): string[] =>
    messagingTable('2')
      .filter((cells) => cells[0] === 'en')
      .map((cells) => cells[1]);

  const axisName = (): string => philosophyRows()[0];

  const sectionHtml = (selector: RegExp): string => {
    const found = selector.exec(readIndexHtml());

    expect(found, `no section matching ${selector}`).not.toBeNull();
    return found![0];
  };

  const positionOf = (needle: string): number => {
    const at = readIndexHtml().indexOf(needle);

    expect(at, `${needle} is not in index.html`).toBeGreaterThan(-1);
    return at;
  };

  it('orders the page hero, problem, demos, loop — and philosophy last', () => {
    expect(positionOf('<section class="hero">')).toBeLessThan(positionOf('id="problem"'));
    expect(positionOf('id="problem"')).toBeLessThan(positionOf('id="demos"'));
    expect(positionOf('id="demos"')).toBeLessThan(positionOf('id="loop"'));
    expect(positionOf('id="with-without"')).toBeLessThan(positionOf('id="limits"'));
    expect(positionOf('id="philosophy"')).toBeLessThan(positionOf('<footer'));
  });

  it('states the §1 lede in the hero, verbatim', () => {
    const hero = sectionHtml(/<section class="hero">[\s\S]*?<\/section>/).replace(/\s+/g, ' ');

    expect(hero, 'the lede must be copied from §1, not rephrased').toContain(heroRow('lede（en'));
  });

  it('puts the fact row directly under the install box', () => {
    const hero = sectionHtml(/<section class="hero">[\s\S]*?<\/section>/);

    expect(hero.replace(/\s+/g, ' ')).toContain(heroRow('事実行（en'));
    // Under the command rather than above it: it is the reassurance a reader
    // wants at the moment they are about to paste something into a shell.
    expect(hero.indexOf('class="facts"')).toBeGreaterThan(hero.indexOf('class="install"'));
  });

  it('opens the problem section on §1b, verbatim and complete', () => {
    const lines = enBlock('1b');
    const heading = lines.find((line) => line.startsWith('## '))!.slice(3).trim();
    const closing = lines
      .filter((line) => line.trim() && !line.startsWith('#') && !line.startsWith('- '))
      .join(' ')
      .trim();
    const section = sectionHtml(/<section class="section" id="problem"[\s\S]*?<\/section>/);
    const points = [...section.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => text(match[1]));

    expect(text(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(section)![1])).toBe(heading);
    expect(points).toEqual(bullets(lines));
    expect(text(section)).toContain(closing);
  });

  it('states §4b in full under "What it does not do", and adds nothing to it', () => {
    const section = sectionHtml(/<section class="section" id="limits"[\s\S]*?<\/section>/);
    const listed = [...section.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => text(match[1]));

    // Equality rather than containment in both directions: §4b's own rule is
    // "no other section promises more than these five lines", which a page that
    // quietly added a sixth would still satisfy under a subset check.
    expect(listed).toEqual(bullets(enBlock('4b')));
  });

  it('states the four §3 cards, in the order the doc lists them', () => {
    const section = sectionHtml(/<h2 id="why">[\s\S]*?<\/section>/);
    const rendered = [...section.matchAll(/<article class="card">([\s\S]*?)<\/article>/g)].map(
      (match) => ({
        title: text(/<h3>([\s\S]*?)<\/h3>/.exec(match[1])?.[1] ?? ''),
        body: text(/<p>([\s\S]*?)<\/p>/.exec(match[1])?.[1] ?? ''),
      }),
    );

    expect(rendered).toEqual(messagingCards());
  });

  it('carries every §5 caption in "See it running"', () => {
    const section = sectionHtml(/<section class="section" id="demos"[\s\S]*?<\/section>/);
    const captions = [...section.matchAll(/<figcaption>([\s\S]*?)<\/figcaption>/g)].map((match) =>
      text(match[1]),
    );
    const rendered = captions.join(' ');

    expect(captions).toHaveLength(DEMO_ORDER.length);
    expect(
      messagingCaptions().filter((caption) => !rendered.includes(caption)),
      'these §5 captions are not on the page',
    ).toEqual([]);
  });

  it('captions the lead run with what the recording shows', () => {
    // A literal, unlike the four below it: §5 covers the feature cuts, and this
    // clip is a recorded orchestrate run instead. Every count in the sentence
    // was read off the footage and the take's brief before it was written —
    // one message to a Command Code session, four issues (#19–#22), four
    // workers, four passing gate columns, and a UAT column in the closing
    // matrix. Nothing here is inferred from the run log.
    const section = sectionHtml(/<figure class="demo demo-lead">[\s\S]*?<\/figure>/);

    expect(text(/<figcaption>([\s\S]*?)<\/figcaption>/.exec(section)![1])).toBe(
      'One message to Command Code. Four issues, four workers, 4/4 gates, then UAT.',
    );
    expect(section).toContain(`src="assets/media/${LEAD_DEMO}"`);
  });

  it('leaves the retired H1 as the Philosophy heading and nowhere else', () => {
    const section = sectionHtml(/<section class="section philosophy"[\s\S]*?<\/section>/);

    // The failure #1812 was written against was the old wording surviving in a
    // corner nobody re-read. #2493 did not retire this sentence, it demoted it,
    // so "is it gone" is the wrong question and "is it in exactly one place" is
    // the right one.
    expect(readIndexHtml().split(axisName()).length - 1).toBe(1);
    expect(section.replace(/\s+/g, ' ')).toContain(
      `<h2 id="philosophy-h">${axisName()}</h2>`,
    );
    expect(text(section)).toContain(philosophyRows().find((row) => row.startsWith('We do not'))!);
  });

  it('keeps the Willison footnote with the sentence it is a footnote to', () => {
    const section = sectionHtml(/<section class="section philosophy"[\s\S]*?<\/section>/);

    expect(section).toContain('Simon Willison');
    expect(section).toContain('https://simonwillison.net/2025/Oct/7/vibe-engineering/');
  });

  it('makes none of the claims §11b puts outside what was measured', () => {
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

  it('still finds the two §11b rows a substring scan cannot be run for', () => {
    // Both are real rules, and neither can be a substring search on this page.
    // "loop" is the name of a section here — the cycle the page is about, which
    // §11b's own reason ("nothing runs forever") is not talking about, and which
    // §4b spells out as "Nothing loops forever". "the only …" is an ellipsis, a
    // shape rather than a string. (The page once said "the only network traffic
    // is the agent CLI's own API calls"; #2549 retracted that as an overclaim and
    // put public-messaging.md §14 in its place.) Pinned here so the exemption
    // cannot outlive the rows.
    expect(unmeasuredClaims()).toEqual(expect.arrayContaining(UNSCANNABLE_CLAIMS));
  });
});

/**
 * Issue #2553 — a FAQ directly under "What it does not do": what a gate is, what
 * happens after the agent says it is done, why this is not an IDE, and five more
 * a reader asks before installing.
 *
 * The answers are where the page is most specific — exit codes, what goes over
 * the network, when Auto Yes switches itself off — so a paraphrase here is a
 * promise the messaging doc never made. Every question and answer is read out of
 * §13 between its `<!-- faq:en -->` markers, the way definitionEn() reads
 * `def:en`, and compared with the page rather than restated.
 */
describe('Issue #2553: FAQ', () => {
  const CSS_BLOCK_START = '/* FAQ (#2553) */';
  const CSS_BLOCK_END = '/* /FAQ (#2553) */';

  interface Faq {
    question: string;
    answer: string;
    /** The answer's code spans, which the page has to render as `<code>`. */
    code: string[];
  }

  const codeSpans = (markdown: string): string[] =>
    Array.from(markdown.matchAll(/`([^`]+)`/g), ([, span]) => span);

  /** §13's en table as the doc fixes it: numbered rows, in order. */
  const faqEnRows = (): string[][] => {
    const doc = fs.readFileSync(MESSAGING_DOC, 'utf-8');
    const match = /<!-- faq:en -->([\s\S]*?)<!-- \/faq:en -->/.exec(doc);

    expect(
      match,
      'docs/design/public-messaging.md must delimit the en FAQ with <!-- faq:en --> … <!-- /faq:en -->',
    ).not.toBeNull();
    return tableRows(match![1]).filter((cells) => cells[0] !== '#');
  };

  const faqEn = (): Faq[] =>
    faqEnRows().map(([, question, answer]) => ({
      question: prose(question),
      answer: prose(answer),
      code: codeSpans(answer),
    }));

  const faqSection = (): string => {
    const found = /<section class="section" id="faq" aria-labelledby="faq-h">[\s\S]*?<\/section>/.exec(
      readIndexHtml(),
    );

    expect(found, 'no <section class="section" id="faq" aria-labelledby="faq-h"> in index.html').not.toBeNull();
    return found![0];
  };

  const detailsBlocks = (): string[] =>
    Array.from(faqSection().matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g), ([, inner]) => inner);

  const renderedFaq = (): Faq[] =>
    detailsBlocks().map((inner) => {
      const parts = /^\s*<summary>([\s\S]*?)<\/summary>([\s\S]*)$/.exec(inner);

      expect(parts, `a <details> must open on a bare <summary>:\n${inner}`).not.toBeNull();
      const [, summary, body] = parts!;
      return {
        question: text(summary),
        answer: text(body),
        code: Array.from(body.matchAll(/<code>([\s\S]*?)<\/code>/g), ([, span]) => text(span)),
      };
    });

  /** styles.css between the FAQ's own opening and closing comments. */
  const faqCss = (): string => {
    const css = fs.readFileSync(STYLES_CSS, 'utf-8');
    const start = css.indexOf(CSS_BLOCK_START);
    const end = css.indexOf(CSS_BLOCK_END);

    expect(start, `styles.css must open the FAQ rules with ${CSS_BLOCK_START}`).toBeGreaterThan(-1);
    expect(end, `styles.css must close the FAQ rules with ${CSS_BLOCK_END}`).toBeGreaterThan(start);
    return css.slice(start, end);
  };

  it('reads eight numbered questions out of the faq:en markers in §13', () => {
    // Without this, a marker that parses to nothing would compare an empty doc
    // against an empty page and pass.
    const rows = faqEnRows();

    expect(rows.map((cells) => cells[0])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(rows.every((cells) => cells.length === 3), 'a §13 row split on a stray |').toBe(true);
  });

  it('asks and answers the eight §13 questions verbatim, in the order the doc fixes', () => {
    // Equality in both directions, like §4b under "What it does not do": a ninth
    // question the doc does not have is as much a drift as a reworded one.
    expect(
      renderedFaq().map(({ question, answer }) => ({ question, answer })),
      'the FAQ must be copied from public-messaging.md §13, not paraphrased',
    ).toEqual(faqEn().map(({ question, answer }) => ({ question, answer })));
  });

  it("renders each answer's code spans as code", () => {
    expect(renderedFaq().map((faq) => faq.code)).toEqual(faqEn().map((faq) => faq.code));
  });

  it('sits directly after "What it does not do"', () => {
    const html = readIndexHtml();
    const limitsStart = html.indexOf('<section class="section" id="limits"');
    const limitsEnd = html.indexOf('</section>', limitsStart);
    const faqStart = html.indexOf('<section class="section" id="faq"');

    expect(limitsStart, 'no #limits section in index.html').toBeGreaterThan(-1);
    expect(faqStart).toBeGreaterThan(limitsEnd);
    expect(html.slice(limitsEnd + '</section>'.length, faqStart)).not.toMatch(/<section\b/);
    expect(text(/<h2 id="faq-h">([\s\S]*?)<\/h2>/.exec(faqSection())?.[1] ?? '')).toBe('FAQ');
  });

  it('opens and closes on the native summary alone, so the keyboard needs no script', () => {
    const section = faqSection();

    expect(detailsBlocks()).toHaveLength(faqEnRows().length);
    expect(section.match(/<summary\b/g) ?? []).toHaveLength(faqEnRows().length);
    // A role, a tabindex or a click handler on either element takes the toggle
    // away from the browser, and with it Enter / Space; so does a script that
    // reaches for them.
    expect(section).not.toMatch(/<(?:details|summary)\b[^>]*\b(?:role|tabindex|onclick)=/);
    expect(fs.readFileSync(path.join(WEBSITE_DIR, 'main.js'), 'utf-8')).not.toMatch(
      /faq|querySelector(?:All)?\(\s*['"`][^'"`]*\b(?:details|summary)\b/i,
    );
  });

  it('adds no anchor to the nav', () => {
    const header = /<header class="site-header">[\s\S]*?<\/header>/.exec(readIndexHtml());

    expect(header, 'the site header not found in index.html').not.toBeNull();
    expect(header![0]).not.toMatch(/href="#faq/);
  });

  it('says neither "loop" nor "the only", which §13 rules out and the page-wide scan cannot', () => {
    // UNSCANNABLE_CLAIMS exempts both from the §11b scan because the page has a
    // section called The loop. Inside this one section there is no such excuse.
    const said = text(faqSection()).toLowerCase();

    expect(said).not.toMatch(/\bloop/);
    expect(said).not.toMatch(/\bthe only\b/);
  });

  it('keeps every FAQ rule inside its one commented block in styles.css', () => {
    const css = fs.readFileSync(STYLES_CSS, 'utf-8');
    const outside = css.replace(faqCss(), '');

    expect(faqCss()).toMatch(/\.faq-item\b/);
    expect(outside, 'a FAQ rule outside the /* FAQ (#2553) */ block').not.toMatch(/\.faq\b|\.faq-|#faq\b/);
  });

  it('switches off, for reduced motion, every transition the FAQ block declares', () => {
    const css = faqCss().replace(/\/\*[\s\S]*?\*\//g, '');
    const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?\})\s*\}/.exec(css);
    const rules = (fragment: string): { selectors: string[]; transition?: string }[] =>
      Array.from(fragment.matchAll(/([^{}]+)\{([^{}]*)\}/g), ([, selector, body]) => ({
        selectors: selector.split(',').map((one) => one.trim()),
        transition: /\btransition(?:-[a-z]+)?\s*:\s*([^;]+)/.exec(body)?.[1].trim(),
      }));

    const animated = rules(media ? css.replace(media[0], '') : css)
      .filter((rule) => rule.transition !== undefined && !rule.transition.startsWith('none'))
      .flatMap((rule) => rule.selectors);
    const switchedOff = rules(media?.[1] ?? '')
      .filter((rule) => rule.transition?.startsWith('none'))
      .flatMap((rule) => rule.selectors);

    // The page-wide reduced-motion rule only shortens a transition to 0.01ms, so
    // the FAQ switches its own off: by name, or for everything inside #faq.
    const covered = (selector: string): boolean => {
      const pseudo = /::(?:before|after)$/.exec(selector)?.[0] ?? '';
      const inside = /^(?:\.faq\b|\.faq-|#faq\s*[\s>+~])/.test(selector.slice(0, selector.length - pseudo.length));

      return switchedOff.includes(selector) || (inside && switchedOff.includes(`#faq *${pseudo}`));
    };

    expect(
      animated.filter((selector) => !covered(selector)),
      'these FAQ rules still transition under prefers-reduced-motion: reduce',
    ).toEqual([]);
  });
});

/**
 * Issue #2550 — the H1 says one agent leads, and until this Issue the page only
 * showed that in a fifteen-second recording and one card. "See it running" now
 * carries the Measured table under that recording, a new "One agent leads"
 * section walks the lead's run, and The loop is cut down to one worker's turn
 * inside it.
 *
 * All of it is copied from `docs/design/public-messaging.md` §3b–§3e, so every
 * assertion here reads the doc rather than restating it. The Measured table is
 * the one that most needs it: its cells are numbers read off recorded runs, and
 * a number retyped by hand is the kind of drift nobody sees until someone
 * checks it against the recording.
 */
describe('Issue #2550: the lead run, measured and walked through', () => {
  const pageSection = (id: string): string => {
    const found = new RegExp(`<section class="section" id="${id}"[\\s\\S]*?</section>`).exec(
      readIndexHtml(),
    );

    expect(found, `no #${id} section in index.html`).not.toBeNull();
    return found![0];
  };

  const firstMatch = (html: string, pattern: RegExp, what: string): string => {
    const found = pattern.exec(html);

    expect(found, `${what} not found in index.html`).not.toBeNull();
    return found![1];
  };

  const allText = (html: string, pattern: RegExp): string[] =>
    [...html.matchAll(pattern)].map((match) => text(match[1]));

  /** One lettered part of §3e (`3e-1` … `3e-6`), with its en copy. */
  const part = (id: string): string => headingBody(sectionBody('3e'), `### ${id}.`);
  const partEn = (id: string): string => firstFence(headingBody(part(id), '#### en'));

  /** §3b's en table and the line under it. */
  const measuredEn = (): { header: string[]; rows: string[][]; under: string } => {
    const body = headingBody(sectionBody('3b'), '### en');
    const [header, ...rows] = tableRows(body);
    const under = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('|'))[0];

    // Guard against a parse that finds nothing and then compares nothing.
    expect(header, 'public-messaging.md §3b en has no table').toBeDefined();
    expect(rows.length, 'public-messaging.md §3b en table has no rows').toBeGreaterThan(0);
    return { header, rows, under };
  };

  /** The Measured block: after the recorded run, before the four feature demos. */
  const measuredHtml = (): string => {
    const demos = pageSection('demos');
    const start = demos.indexOf('<div class="measured">');
    const end = demos.indexOf('<div class="demos">');

    expect(start, 'no .measured block in #demos').toBeGreaterThan(-1);
    expect(start, 'the Measured table must sit under the recorded run').toBeGreaterThan(
      demos.indexOf('<figure class="demo demo-lead">'),
    );
    expect(end, 'the Measured table must sit above the four feature demos').toBeGreaterThan(start);
    return demos.slice(start, end);
  };

  it('copies the Measured table from §3b cell for cell', () => {
    const { header, rows } = measuredEn();
    const html = measuredHtml();
    const thead = firstMatch(html, /<thead>([\s\S]*?)<\/thead>/, 'Measured <thead>');
    const tbody = firstMatch(html, /<tbody>([\s\S]*?)<\/tbody>/, 'Measured <tbody>');

    // Every cell, not only the numbers: "4/4 gates passed" and "UAT go" are as
    // much a measured claim as "8 min 39 s", and §3b says the table is copied
    // verbatim. Order and row count are part of the equality.
    expect(allText(thead, /<th[^>]*>([\s\S]*?)<\/th>/g)).toEqual(header);
    expect(
      [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
        allText(row[1], /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g),
      ),
    ).toEqual(rows);
  });

  it('puts "as observed" directly under the table, then §3e-4', () => {
    const { under } = measuredEn();
    const html = measuredHtml();

    // §3b: the line goes directly under the table and the table is never shown
    // without it — so "somewhere in the block" is not enough.
    expect(under).toBe('as observed');
    expect(
      text(firstMatch(html, /<\/table>\s*<\/div>\s*<p[^>]*>([\s\S]*?)<\/p>/, 'the line under the table')),
    ).toBe(under);
    expect(text(html)).toContain(`${under} ${prose(partEn('3e-4'))}`);
  });

  it('scrolls the Measured table in its own box, as the With / Without table does', () => {
    expect(measuredHtml()).toMatch(/<div class="table-scroll" tabindex="0" role="region" aria-labelledby="measured-h">/);
    expect(measuredHtml()).toMatch(/<h3 id="measured-h">/);
  });

  it('orders the new section after "See it running" and before The loop', () => {
    const html = readIndexHtml();

    expect(html.indexOf('id="demos"')).toBeLessThan(html.indexOf('id="lead"'));
    expect(html.indexOf('id="lead"')).toBeLessThan(html.indexOf('id="loop"'));
  });

  it('heads the section with card 1 and opens it on §3e-2', () => {
    const section = pageSection('lead');

    expect(text(firstMatch(section, /<h2[^>]*>([\s\S]*?)<\/h2>/, '#lead heading'))).toBe(
      messagingCards()[0].title,
    );
    // §3e-2 ends on "Nothing mutates without an explicit approve, and a failed
    // gate stops the run." — the sentence the Issue asked for by name.
    expect(partEn('3e-2')).toContain('Nothing mutates without an explicit approve');
    expect(
      text(firstMatch(section, /<p class="section-lede">([\s\S]*?)<\/p>/, '#lead lede')),
    ).toBe(prose(partEn('3e-2')));
  });

  it('walks plan, dispatch, merge and uat in §3e-1 order and wording', () => {
    const lines = partEn('3e-1').split('\n');
    const bullets = lines.filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim());
    const closing = lines.filter((line) => line.trim() && !line.startsWith('- ')).join(' ');
    const section = pageSection('lead');
    const list = firstMatch(section, /<ol class="lead-steps">([\s\S]*?)<\/ol>/, '.lead-steps');

    // The doc writes "name — what it does"; the page sets the name as the
    // heading and the rest as the paragraph, so join them back to compare.
    const steps = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(
      (item) =>
        `${text(/<h3>([\s\S]*?)<\/h3>/.exec(item[1])?.[1] ?? '')} — ${text(/<p>([\s\S]*?)<\/p>/.exec(item[1])?.[1] ?? '')}`,
    );

    expect(bullets.map((bullet) => bullet.split(' — ')[0])).toEqual(['plan', 'dispatch', 'merge', 'uat']);
    expect(steps).toEqual(bullets);
    expect(
      text(firstMatch(section, /<\/ol>\s*<p class="note">([\s\S]*?)<\/p>/, 'the note under the steps')),
    ).toBe(prose(closing));
  });

  it('shows the §3e-3 contract byte for byte, captioned with its built-in gates', () => {
    const section = pageSection('lead');
    const figure = firstMatch(
      section,
      /<figure class="lead-contract">([\s\S]*?)<\/figure>/,
      '.lead-contract',
    );

    // Raw rather than text(): YAML indentation is meaning, so whitespace is not
    // collapsed here. Nothing in it needs escaping in HTML.
    expect(firstMatch(figure, /<pre class="snippet"><code>([\s\S]*?)<\/code><\/pre>/, 'the contract snippet')).toBe(
      firstFence(part('3e-3')),
    );
    expect(text(firstMatch(figure, /<figcaption>([\s\S]*?)<\/figcaption>/, 'the contract caption'))).toBe(
      prose(partEn('3e-3')),
    );
  });

  it('states §3e-5 whole under "Review by another agent"', () => {
    const section = pageSection('lead');
    const review = firstMatch(section, /<div class="lead-review">([\s\S]*?)<\/div>/, '.lead-review');
    const title = /^### 3e-5\. (.+?)（/m.exec(sectionBody('3e'))?.[1];

    expect(title, 'public-messaging.md §3e-5 has no title').toBe('Review by another agent');
    expect(text(firstMatch(review, /<h3>([\s\S]*?)<\/h3>/, 'the review heading'))).toBe(title);
    // Whole, never trimmed: the last sentence is what says the runner does not
    // run a cross-model review for you (§4b), and it is the easiest one to cut.
    expect(text(firstMatch(review, /<p>([\s\S]*?)<\/p>/, 'the review paragraph'))).toBe(
      prose(partEn('3e-5')),
    );
  });

  describe('the four cards', () => {
    const cards = (): string[] => {
      const section = /<h2 id="why">[\s\S]*?<\/section>/.exec(readIndexHtml());

      expect(section, 'the cards section is not in index.html').not.toBeNull();
      return [...section![0].matchAll(/<article class="card">([\s\S]*?)<\/article>/g)].map(
        (match) => match[1],
      );
    };

    it('puts §3c directly under the sentence of card 1', () => {
      const card = cards()[0];
      const supported = firstFence(headingBody(sectionBody('3c'), '### en'));

      expect(text(firstMatch(card, /<h3>([\s\S]*?)<\/h3>/, 'card 1 title'))).toBe(messagingCards()[0].title);
      expect(
        text(firstMatch(card, /<\/p>\s*<p class="card-more">([\s\S]*?)<\/p>/, 'the paragraph under card 1')),
      ).toBe(prose(supported));
    });

    it('lists the §3d Catalog IDs as chips under card 4, in order', () => {
      const card = cards()[3];
      const idLine = sectionBody('3d')
        .split('\n')
        .find((line) => line.startsWith('`cmate-'));
      const ids = [...(idLine ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      const label = messagingTable('3d').find((cells) => cells[0] === 'en')?.[1];

      expect(ids.length, 'public-messaging.md §3d lists no Catalog IDs').toBeGreaterThan(0);
      expect(text(firstMatch(card, /<h3>([\s\S]*?)<\/h3>/, 'card 4 title'))).toBe(messagingCards()[3].title);
      // The label is the <summary> the IDs fold under since #2555, which a
      // paragraph cannot be; the words compared with §3d are the same.
      expect(text(firstMatch(card, /<summary id="catalog-h">([\s\S]*?)<\/summary>/, 'the Catalog label'))).toBe(label);
      expect(
        allText(firstMatch(card, /<ul class="chips"[^>]*>([\s\S]*?)<\/ul>/, 'the Catalog chips'), /<li>([\s\S]*?)<\/li>/g),
      ).toEqual(ids);
    });
  });

  it('opens The loop on §3e-6 and keeps its four beats', () => {
    const section = pageSection('loop');

    expect(text(firstMatch(section, /<p class="section-lede">([\s\S]*?)<\/p>/, '#loop lede'))).toBe(
      prose(partEn('3e-6')),
    );
    // §3e-6 names four beats, so the section still has to show four.
    expect(allText(section, /<li class="beat">\s*<h3>([\s\S]*?)<\/h3>/g)).toEqual([
      'The requirement',
      'The contract',
      'The agent runs',
      'The verdict',
    ]);
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
      expect.arrayContaining(['#loop', '#quick-start', '#with-without']),
    );

    const dangling = Array.from(html.matchAll(/href="#([^"]+)"/g), ([, id]) => id).filter(
      (id) => !html.includes(`id="${id}"`),
    );
    expect(dangling, 'these in-page links scroll nowhere').toEqual([]);
  });

  it('links the footer to Discussions and Releases, and to no X account yet', () => {
    const links = anchors(footer()).map(({ text: label, href }) => [label, href]);

    expect(links).toEqual(
      expect.arrayContaining([
        ['Discussions', `${REPO_URL}/discussions`],
        ['Releases', `${REPO_URL}/releases`],
      ]),
    );
    // Which account it would be is undecided; a guessed handle is worse than none.
    expect(links.filter(([label, href]) => label === 'X' || /\/\/(www\.)?(x|twitter)\.com\b/.test(href))).toEqual([]);
  });

  it('points a feed reader at the GitHub releases feed', () => {
    const head = markup(/<head>[\s\S]*?<\/head>/, '<head>');

    expect(head).toContain(
      `<link rel="alternate" type="application/atom+xml" href="${REPO_URL}/releases.atom"`,
    );
  });

  it('states the version package.json ships, directly under the prerequisites', () => {
    const hero = markup(/<section class="hero">[\s\S]*?<\/section>/, 'the hero');

    expect(releaseLine().version).toBe(packageVersion());
    expect(hero.indexOf('class="release-line"')).toBeGreaterThan(hero.indexOf('class="prereq"'));
    expect(hero.indexOf('class="release-line"')).toBeLessThan(hero.indexOf('class="cta-row"'));
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
    // The banned-term and §11b scans walk textFiles(); a file they skip is a
    // file they cannot keep clean.
    expect(fs.existsSync(LLMS_TXT)).toBe(true);
    expect(textFiles().map((entry) => entry.file)).toContain('llms.txt');
  });

  it('opens llms.txt on the §1 H1, lede and fact row', () => {
    const lines = llmsTxt().split('\n');

    expect(lines[0]).toBe(`# CommandMate — ${heroRow('H1（en')}`);
    expect(lines).toContain(`> ${heroRow('lede（en')}`);
    expect(lines).toContain(heroRow('事実行（en'));
  });

  it('states the four §3 cards in llms.txt, in order and verbatim', () => {
    const cards = llmsTxt()
      .split('\n')
      .flatMap((line) => {
        const card = /^- \*\*([^*]+)\*\*: (.+)$/.exec(line);
        return card ? [{ title: card[1], body: card[2] }] : [];
      });

    expect(cards).toEqual(messagingCards());
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
