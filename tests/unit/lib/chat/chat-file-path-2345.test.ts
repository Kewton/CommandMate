/**
 * Turning what a reply CLAIMS into what the file API can serve (Issue #2345).
 *
 * The defect had two halves and this file pins the one that is a pure function:
 * an absolute path inside the worktree — the shape codex writes, both as a
 * Markdown destination and as bare prose — has to become the worktree-RELATIVE
 * path, because `files/` + `encodePathForUrl('/Users/…')` is `files//Users/…`,
 * which Next 308-normalizes to `files/Users/…` and the route then reads as the
 * relative path `Users/…` (404). Measured 2026-09-05 on the running server; the
 * same file asked for relatively answers 200.
 *
 * Every row here is a string in and a string out, so the table IS the contract:
 * the renderer tests next door assert that both click paths reach this function,
 * not what it decides.
 */

import { describe, it, expect } from 'vitest';
import { classifyChatLink, normalizeChatFilePath } from '@/lib/chat/chat-file-path';

/** The worktree from the Issue's live capture. */
const WORKTREE = '/Users/maenokota/share/work/github_kewton/CommandAgent-develop';
/** The file the reporter could not open. */
const INSIDE = `${WORKTREE}/workspace/tmp/0905/commandagent-nextjs-validation-cause-and-countermeasures.md`;
const INSIDE_RELATIVE =
  'workspace/tmp/0905/commandagent-nextjs-validation-cause-and-countermeasures.md';

describe('[#2345] classifyChatLink', () => {
  it.each([
    ['#heading', 'anchor'],
    ['#L12', 'anchor'],
    ['http://127.0.0.1:60302/', 'external'],
    ['https://example.com/a/b', 'external'],
    ['mailto:a@example.com', 'external'],
    ['tel:+81312345678', 'external'],
    ['/Users/a/b.md', 'file'],
    ['docs/a.md', 'file'],
    ['./a.md', 'file'],
    ['../a.md', 'file'],
    ['file:///Users/a/b.md', 'file'],
    ['file://localhost/Users/a/b.md', 'file'],
  ])('calls %j a %s', (href, expected) => {
    expect(classifyChatLink(href)).toBe(expected);
  });

  it.each([
    ['', 'nothing to act on'],
    ['   ', 'whitespace only'],
    ['javascript:alert(1)', 'an unknown scheme is never a path'],
    ['data:text/html,<script>', 'a data URL is never a path'],
    ['vscode://file/x', 'an editor deep link is not this app’s to open'],
    ['/ab.md', 'a control character (sanitizeHref)'],
  ])('refuses %j (%s)', (href) => {
    expect(classifyChatLink(href)).toBeNull();
  });

  it('refuses an href longer than sanitizeHref allows', () => {
    expect(classifyChatLink(`/${'a'.repeat(2100)}.md`)).toBeNull();
  });
});

describe('[#2345] normalizeChatFilePath rewrites an in-worktree absolute path', () => {
  it('returns the path relative to the worktree root', () => {
    expect(normalizeChatFilePath(INSIDE, WORKTREE)).toBe(INSIDE_RELATIVE);
  });

  it('tolerates a worktree root written with a trailing slash', () => {
    expect(normalizeChatFilePath(INSIDE, `${WORKTREE}/`)).toBe(INSIDE_RELATIVE);
  });

  it('does not treat a sibling worktree with the same prefix as inside', () => {
    // `…/CommandAgent-develop-2/x.md` starts with the root as a STRING but is a
    // different directory. The separator is what makes containment containment.
    const sibling = `${WORKTREE}-2/workspace/notes.md`;
    expect(normalizeChatFilePath(sibling, WORKTREE)).toBe(sibling);
  });

  it('opens nothing for the worktree root itself', () => {
    // "" would ask the file API for a directory listing, not a file.
    expect(normalizeChatFilePath(WORKTREE, WORKTREE)).toBeNull();
    expect(normalizeChatFilePath(`${WORKTREE}/`, WORKTREE)).toBeNull();
  });
});

describe('[#2345] normalizeChatFilePath leaves an outside path alone', () => {
  it('returns an absolute path from another repository unchanged', () => {
    // #2274 answers this one: the probe gets a 400 and the toast says the file
    // is not here. Rewriting it would hide which file the reply actually named.
    const other = '/Users/maenokota/localwork/other/build.log';
    expect(normalizeChatFilePath(other, WORKTREE)).toBe(other);
  });

  it('returns an absolute path unchanged when no worktree root is known', () => {
    expect(normalizeChatFilePath(INSIDE)).toBe(INSIDE);
    expect(normalizeChatFilePath(INSIDE, undefined)).toBe(INSIDE);
    expect(normalizeChatFilePath(INSIDE, '')).toBe(INSIDE);
  });

  it('ignores a worktree root that is not itself absolute', () => {
    expect(normalizeChatFilePath(INSIDE, 'relative/root')).toBe(INSIDE);
  });
});

describe('[#2345] normalizeChatFilePath reads a relative destination against the root', () => {
  it.each([
    ['docs/a.md', 'docs/a.md'],
    ['./docs/a.md', 'docs/a.md'],
    ['./a.md', 'a.md'],
    ['docs/./a.md', 'docs/a.md'],
    ['docs/sub/../a.md', 'docs/a.md'],
    ['docs//a.md', 'docs/a.md'],
    // No base directory exists above the worktree root, so a climb collapses
    // rather than escaping — the server never sees a traversal from here.
    ['../a.md', 'a.md'],
    ['../../a.md', 'a.md'],
  ])('resolves %j to %j', (href, expected) => {
    expect(normalizeChatFilePath(href, WORKTREE)).toBe(expected);
  });

  it('opens nothing when a relative path collapses to empty', () => {
    expect(normalizeChatFilePath('./', WORKTREE)).toBeNull();
    expect(normalizeChatFilePath('..', WORKTREE)).toBeNull();
  });
});

describe('[#2345] normalizeChatFilePath strips what is not part of the path', () => {
  it('drops a `file://` scheme, with or without an authority', () => {
    expect(normalizeChatFilePath(`file://${INSIDE}`, WORKTREE)).toBe(INSIDE_RELATIVE);
    expect(normalizeChatFilePath(`file://localhost${INSIDE}`, WORKTREE)).toBe(INSIDE_RELATIVE);
  });

  it.each([
    [`${WORKTREE}/src/app/page.tsx:12`, 'src/app/page.tsx'],
    [`${WORKTREE}/src/app/page.tsx:12:34`, 'src/app/page.tsx'],
    [`${WORKTREE}/docs/a.md#L12`, 'docs/a.md'],
    [`${WORKTREE}/docs/a.md#heading`, 'docs/a.md'],
  ])('drops the line / fragment suffix of %j', (href, expected) => {
    // Out of scope for this Issue: the file opens, the caret does not move.
    expect(normalizeChatFilePath(href, WORKTREE)).toBe(expected);
  });

  it('keeps a colon that is not a line number', () => {
    expect(normalizeChatFilePath(`${WORKTREE}/docs/a:b.md`, WORKTREE)).toBe('docs/a:b.md');
  });

  it('percent-decodes a destination remark encoded', () => {
    // remark encodes any non-ASCII destination, so a Japanese filename arrives
    // escaped and the file API would be asked for the escaped name twice over.
    expect(
      normalizeChatFilePath(`${WORKTREE}/docs/%E6%97%A5%E6%9C%AC%E8%AA%9E.md`, WORKTREE),
    ).toBe('docs/日本語.md');
    expect(normalizeChatFilePath(`${WORKTREE}/docs/a%20b.md`, WORKTREE)).toBe('docs/a b.md');
  });

  it('keeps a filename whose `%` is not an escape sequence', () => {
    // `decodeURIComponent` throws on this; the file is still openable verbatim.
    expect(normalizeChatFilePath(`${WORKTREE}/docs/100%.md`, WORKTREE)).toBe('docs/100%.md');
  });

  it('cuts the fragment before decoding, so an escaped `#` stays content', () => {
    expect(normalizeChatFilePath(`${WORKTREE}/docs/a%23b.md`, WORKTREE)).toBe('docs/a#b.md');
  });
});

describe('[#2345] normalizeChatFilePath opens nothing that is not a file', () => {
  it.each([
    ['#heading', 'an in-document anchor'],
    ['http://127.0.0.1:60302/', 'an external URL'],
    ['https://example.com/a/b.js', 'an external URL'],
    ['mailto:a@example.com', 'a mail link'],
    ['javascript:alert(1)', 'a scheme rehype-sanitize already strips'],
    ['', 'an empty href'],
  ])('returns null for %j (%s)', (href) => {
    expect(normalizeChatFilePath(href, WORKTREE)).toBeNull();
  });
});
