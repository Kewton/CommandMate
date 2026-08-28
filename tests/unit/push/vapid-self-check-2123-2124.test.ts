/**
 * The ONE startup check both Issues report through (#2123 and #2124).
 *
 * #2123 is "VAPID unset disables push in silence"; #2124 is "the default subject
 * is rejected by APNs and iOS alone goes quiet". The task that merged them asked
 * for one check reporting two facts rather than two checks, and this file pins
 * that shape: `inspectVapidConfig` is the single verdict, `formatVapidReportLines`
 * is the single wording, and both `server.ts` and `commandmate status` consume
 * exactly those.
 *
 * The **negative control** is the load-bearing half of both acceptance
 * conditions: a healthy configuration must print NOTHING, because the value of
 * the line is that its presence means something. A check that warned on healthy
 * installs would be turned off within a week.
 *
 * What is NOT claimed here: nothing in this file measures APNs or FCM. That
 * `mailto:commandmate@localhost` draws a 403 from Apple and that
 * `https://github.com/Kewton/CommandMate` is delivered are the orchestrator's
 * device measurements from the Epic #2002 UAT (2026-08-27); this author has no
 * hardware and did not reproduce them. What the tests pin is the pure part —
 * which subjects the classifier accepts, and that the shipped default is one of
 * the accepted ones.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  VAPID_DEFAULT_SUBJECT,
  VAPID_ENV_KEYS,
  classifyVapidSubject,
  extractVapidSubjectHost,
  formatVapidReportLines,
  inspectVapidConfig,
  runVapidSelfCheck,
} from '@/lib/push/vapid';

const KEYS = {
  [VAPID_ENV_KEYS.publicKey]: 'BPublicKeyPlaceholder',
  [VAPID_ENV_KEYS.privateKey]: 'PrivateKeyPlaceholder',
};

describe('the default subject (Issue #2124)', () => {
  it('is no longer the localhost mailto that APNs rejected', () => {
    // The literal is spelled out because this is the value the Issue is about:
    // a regression to it would silence every iPhone again, and the UAT that
    // caught it cost two devices and an afternoon.
    expect(VAPID_DEFAULT_SUBJECT).not.toBe('mailto:commandmate@localhost');
    expect(VAPID_DEFAULT_SUBJECT).toBe('https://github.com/Kewton/CommandMate');
  });

  it('passes its own classifier, so the shipped default never warns', () => {
    expect(classifyVapidSubject(VAPID_DEFAULT_SUBJECT)).toBeNull();
  });

  it('is used when CM_VAPID_SUBJECT is unset or blank', () => {
    expect(inspectVapidConfig({ ...KEYS }).subject).toBe(VAPID_DEFAULT_SUBJECT);
    expect(inspectVapidConfig({ ...KEYS }).subjectSource).toBe('default');
    expect(inspectVapidConfig({ ...KEYS, [VAPID_ENV_KEYS.subject]: '   ' }).subject).toBe(
      VAPID_DEFAULT_SUBJECT
    );
  });
});

describe('classifyVapidSubject (Issue #2124)', () => {
  it.each([
    'https://github.com/Kewton/CommandMate',
    'https://commandmate.example.com/contact',
    'mailto:ops@example.com',
    'mailto:ops@sub.domain.co.jp',
    // Case is not part of the verdict: schemes and hosts are case-insensitive.
    'MAILTO:Ops@Example.Com',
  ])('accepts %s', (subject) => {
    expect(classifyVapidSubject(subject)).toBeNull();
  });

  it.each([
    // The exact value that failed on hardware.
    ['mailto:commandmate@localhost', 'non-routable-host'],
    ['mailto:ops@mac-mini', 'non-routable-host'],
    ['mailto:ops@commandmate.local', 'non-routable-host'],
    ['mailto:ops@box.internal', 'non-routable-host'],
    ['https://localhost:3000/', 'non-routable-host'],
    ['https://127.0.0.1:3000/', 'non-routable-host'],
    ['https://[::1]:3000/', 'non-routable-host'],
    ['mailto:not-an-address', 'missing-host'],
    // RFC 8292 allows exactly two schemes; anything else is rejected outright.
    ['http://example.com', 'unsupported-scheme'],
    ['https:/example.com', 'unsupported-scheme'],
    ['example.com', 'unsupported-scheme'],
    ['', 'unsupported-scheme'],
  ])('rejects %s as %s', (subject, issue) => {
    expect(classifyVapidSubject(subject)).toBe(issue);
  });

  it('extracts the host after the LAST @, so a quoted local part cannot fool it', () => {
    expect(extractVapidSubjectHost('mailto:"a@b"@example.com')).toBe('example.com');
    expect(extractVapidSubjectHost('mailto:ops@example.com?subject=hi')).toBe('example.com');
  });

  it('does not reject example.com, the placeholder every tutorial uses', () => {
    // `.example` is a reserved TLD; `example.com` is an ordinary resolvable
    // domain. Conflating the two would warn on a large share of real installs.
    expect(classifyVapidSubject('mailto:ops@example.com')).toBeNull();
    expect(classifyVapidSubject('https://ops.example')).toBe('non-routable-host');
  });
});

describe('inspectVapidConfig (Issues #2123 / #2124)', () => {
  it('reports "unconfigured" when neither key is set', () => {
    const inspection = inspectVapidConfig({});
    expect(inspection.status).toBe('unconfigured');
    expect(inspection.configured).toBe(false);
    expect(inspection.missingKeys).toEqual([
      VAPID_ENV_KEYS.publicKey,
      VAPID_ENV_KEYS.privateKey,
    ]);
  });

  it('reports "partial" when exactly one key is set, naming the missing one', () => {
    const inspection = inspectVapidConfig({ [VAPID_ENV_KEYS.publicKey]: 'BPub' });
    expect(inspection.status).toBe('partial');
    expect(inspection.configured).toBe(false);
    expect(inspection.missingKeys).toEqual([VAPID_ENV_KEYS.privateKey]);
  });

  it('reports "invalid-subject" when both keys are present but the subject cannot resolve', () => {
    const inspection = inspectVapidConfig({
      ...KEYS,
      [VAPID_ENV_KEYS.subject]: 'mailto:commandmate@localhost',
    });
    expect(inspection.status).toBe('invalid-subject');
    // Push IS configured — the keys are fine. Only Apple will refuse it.
    expect(inspection.configured).toBe(true);
    expect(inspection.subjectIssue).toBe('non-routable-host');
  });

  it('reports "ok" for a healthy configuration', () => {
    const inspection = inspectVapidConfig({
      ...KEYS,
      [VAPID_ENV_KEYS.subject]: 'mailto:ops@example.com',
    });
    expect(inspection.status).toBe('ok');
    expect(inspection.configured).toBe(true);
    expect(inspection.subjectIssue).toBeNull();
    expect(inspection.subjectSource).toBe('env');
  });

  it('never puts a key value into the verdict', () => {
    const inspection = inspectVapidConfig({ ...KEYS });
    expect(JSON.stringify(inspection)).not.toContain(KEYS[VAPID_ENV_KEYS.privateKey]);
    expect(JSON.stringify(inspection)).not.toContain(KEYS[VAPID_ENV_KEYS.publicKey]);
  });

  it('keeps an invalid subject rather than substituting the default', () => {
    // Substituting would make the warning describe a value the server does not
    // send, and would make `commandmate status` disagree with the wire.
    const inspection = inspectVapidConfig({
      ...KEYS,
      [VAPID_ENV_KEYS.subject]: 'mailto:commandmate@localhost',
    });
    expect(inspection.subject).toBe('mailto:commandmate@localhost');
  });
});

describe('formatVapidReportLines (Issues #2123 / #2124)', () => {
  it('says NOTHING for a healthy configuration (the negative control)', () => {
    expect(
      formatVapidReportLines(
        inspectVapidConfig({ ...KEYS, [VAPID_ENV_KEYS.subject]: 'mailto:ops@example.com' })
      )
    ).toEqual([]);
    // …including when the subject is left to the default.
    expect(formatVapidReportLines(inspectVapidConfig({ ...KEYS }))).toEqual([]);
  });

  it('names push, both variables and the way to get keys when unconfigured', () => {
    const lines = formatVapidReportLines(inspectVapidConfig({}));
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.join('\n');
    expect(text).toContain('Push notifications are disabled');
    expect(text).toContain(VAPID_ENV_KEYS.publicKey);
    expect(text).toContain(VAPID_ENV_KEYS.privateKey);
    // The Issue's acceptance condition is that the reader can act on the line.
    expect(text).toContain('commandmate init');
    expect(text).toContain('docs/user-guide/webapp-guide.md');
  });

  it('names Apple and the iOS-only symptom for an invalid subject', () => {
    const lines = formatVapidReportLines(
      inspectVapidConfig({ ...KEYS, [VAPID_ENV_KEYS.subject]: 'mailto:commandmate@localhost' })
    );
    const text = lines.join('\n');
    expect(text).toContain(VAPID_ENV_KEYS.subject);
    expect(text).toContain('mailto:commandmate@localhost');
    expect(text).toContain('APNs');
    // Without this the reader has no way to connect "iPhone silent, Android fine".
    expect(text).toContain('Android');
    expect(text).toContain(VAPID_DEFAULT_SUBJECT);
  });

  it('never prints a key value', () => {
    for (const env of [{}, { [VAPID_ENV_KEYS.publicKey]: KEYS[VAPID_ENV_KEYS.publicKey] }]) {
      const text = formatVapidReportLines(inspectVapidConfig(env)).join('\n');
      expect(text).not.toContain(KEYS[VAPID_ENV_KEYS.publicKey]);
      expect(text).not.toContain(KEYS[VAPID_ENV_KEYS.privateKey]);
    }
  });
});

describe('runVapidSelfCheck (Issues #2123 / #2124)', () => {
  it('emits every report line through the injected warn', () => {
    const warned: string[] = [];
    const inspection = runVapidSelfCheck({ env: {}, warn: (m) => warned.push(m) });
    expect(inspection?.status).toBe('unconfigured');
    expect(warned).toEqual(formatVapidReportLines(inspectVapidConfig({})));
  });

  it('emits nothing at all on a healthy server', () => {
    const warned: string[] = [];
    const inspection = runVapidSelfCheck({ env: { ...KEYS }, warn: (m) => warned.push(m) });
    expect(inspection?.status).toBe('ok');
    // Exactly zero lines, not "zero lines that look like a complaint": a
    // self-check that announced success would be scrolled past within a week,
    // and the presence of a line is the whole signal.
    expect(warned).toHaveLength(0);
  });

  it('is fail-open: a throwing sink returns null instead of propagating', () => {
    // The caller in server.ts does not await this and must never be able to lose
    // a `listen` to a diagnostic.
    expect(
      runVapidSelfCheck({
        env: {},
        warn: () => {
          throw new Error('log sink is gone');
        },
      })
    ).toBeNull();
  });
});
