/**
 * The user-facing setup for Web Push exists, and exists in both languages (#2123).
 *
 * Issue #2123 is a documentation defect, and a documentation defect has no other
 * guard: nothing else in this suite reads these files, so reverting the doc half
 * of the fix leaves the whole repository green. That is exactly the shape
 * `tests/unit/docs/guidance-url-matches-bind-2113.test.ts` was written for, and
 * this file is its sibling.
 *
 * ja and en are covered together because they are mirrors: fixing one while the
 * other still has no notification section leaves half the readers where #2123
 * found them. The Issue's full-text search for `VAPID` returned four files, all
 * developer-facing; that is the state this pins shut.
 *
 * The assertions are about the FACTS the device UAT needed and could not find,
 * not about prose. Each one cost the orchestrator time on 2026-08-27:
 * HTTPS/secure context, the iOS Home Screen requirement, that Android does not
 * need it, that the OS notification list stays empty until the in-app button is
 * pressed, and that the private key is a secret.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const GUIDES: ReadonlyArray<{ lang: 'ja' | 'en'; file: string }> = [
  { lang: 'ja', file: 'docs/user-guide/webapp-guide.md' },
  { lang: 'en', file: 'docs/en/user-guide/webapp-guide.md' },
];

function read(file: string): string {
  const abs = path.join(REPO_ROOT, file);
  expect(fs.existsSync(abs), `${file} is missing`).toBe(true);
  return fs.readFileSync(abs, 'utf-8');
}

describe('.env.example carries the three VAPID variables (Issue #2123)', () => {
  const env = read('.env.example');

  it.each(['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'])(
    'documents %s',
    (name) => {
      expect(env).toContain(name);
    }
  );

  it('names the command that produces the keys', () => {
    // Without this the reader is back to the `node -e` folklore the Issue is about.
    expect(env).toContain('commandmate init');
  });

  it('says the private key is a secret', () => {
    expect(env).toContain('SECRET');
  });

  it('states the APNs-safe default rather than the localhost mailto (Issue #2124)', () => {
    expect(env).toContain('https://github.com/Kewton/CommandMate');
    expect(env).not.toContain('mailto:commandmate@localhost');
  });
});

describe('the web app guide has a phone-notification section (Issue #2123)', () => {
  it.each(GUIDES)('$file ($lang) mentions notifications at all', ({ file }) => {
    // The Issue measured "the word 通知 appears 0 times" in the ja guide.
    const text = read(file);
    expect(text).toMatch(/通知|[Nn]otification/);
  });

  it.each(GUIDES)('$file ($lang) names all three variables', ({ file }) => {
    const text = read(file);
    for (const name of ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT']) {
      expect(text, `${file} must name ${name}`).toContain(name);
    }
  });

  it.each(GUIDES)('$file ($lang) walks keys -> restart -> verify', ({ file }) => {
    const text = read(file);
    expect(text).toContain('commandmate init');
    expect(text).toContain('commandmate stop && commandmate start');
    // The verification step, which is how the Issue itself diagnosed the install.
    expect(text).toContain('/api/push/vapid');
    expect(text).toContain('"configured":true');
  });

  it.each(GUIDES)('$file ($lang) states the HTTPS / secure-context requirement', ({ file }) => {
    const text = read(file);
    expect(text).toMatch(/Service Worker/);
    expect(text).toContain('https://');
  });

  it.each(GUIDES)('$file ($lang) states the iOS Home Screen requirement', ({ file }) => {
    const text = read(file);
    expect(text).toMatch(/iOS|iPadOS/);
    expect(text).toMatch(/ホーム画面に追加|Add to Home Screen/);
  });

  it.each(GUIDES)('$file ($lang) says Android needs no install', ({ file }) => {
    // Stated because the asymmetry is what makes the iOS rule confusing.
    expect(read(file)).toMatch(/Android/);
  });

  it.each(GUIDES)('$file ($lang) warns that the OS list is empty before subscribing', ({ file }) => {
    // The UAT looked at the OS notification settings first and concluded
    // "already allowed" from a site that was not in the list yet.
    const text = read(file);
    expect(text).toMatch(/購読前は一覧に存在しません|subscribing shows nothing/);
  });

  it.each(GUIDES)('$file ($lang) says the private key must not be committed', ({ file }) => {
    const text = read(file);
    expect(text).toContain('.gitignore');
    expect(text).toContain('CM_VAPID_PRIVATE_KEY');
  });

  it.each(GUIDES)('$file ($lang) explains the APNs subject trap (Issue #2124)', ({ file }) => {
    const text = read(file);
    expect(text).toContain('APNs');
    // The asymmetry is the whole diagnostic value: Android working proves nothing.
    expect(text).toMatch(/403/);
    expect(text).toContain('FCM');
  });

  it.each(GUIDES)('$file ($lang) tells the reader what to do when nothing arrives', ({ file }) => {
    const text = read(file);
    expect(text).toContain('push-send-failed');
    expect(text).toContain('push-fanout-complete');
  });
});

describe('the README points at the setup (Issue #2123)', () => {
  it.each([
    { lang: 'en', file: 'README.md' },
    { lang: 'ja', file: 'docs/ja/README.md' },
  ])('$file ($lang) names the variables and links the guide', ({ file }) => {
    // The Issue's table records "README.md: setup none, feature description none".
    const text = read(file);
    expect(text).toContain('CM_VAPID_PUBLIC_KEY');
    expect(text).toContain('commandmate init');
    expect(text).toContain('webapp-guide.md');
  });
});
