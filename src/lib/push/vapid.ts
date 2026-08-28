/**
 * VAPID configuration for Web Push, and the one startup check that reports on it
 * (Issue #1125; the check and the subject rules are Issues #2123 / #2124).
 *
 * Keys are supplied via environment variables and read lazily so tests can vary
 * them and so an unconfigured deployment simply disables push (never crashes).
 * The private key and subject are secrets — never log the returned config.
 *
 * ## Why the default subject is an https: URL (Issue #2124)
 *
 * The VAPID `sub` claim is the sender's contact, and **Apple validates it**. The
 * original default, `mailto:commandmate@localhost`, names a domain that cannot
 * exist, so APNs answered 403 and iOS/iPadOS received nothing while Android kept
 * working — FCM is permissive about `sub`, so testing on Android alone cannot
 * see it. Measured by the orchestrator during the Epic #2002 device UAT
 * (2026-08-27, develop e8d09989), fanning ONE waiting notification to two
 * devices:
 *
 *   Android 10 / Chrome 151 -> FCM   default subject: delivered
 *   iPad / iPadOS 18.7      -> APNs  default subject: 403, push-send-failed
 *                                    https://github.com/Kewton/CommandMate: delivered
 *
 * This file's author did NOT reproduce that on hardware; the APNs/FCM behaviour
 * above is quoted from that UAT and is not re-measured here. What IS pinned by
 * the unit suite is the pure part: which subjects this module accepts and which
 * it flags, and that the default is one of the accepted ones.
 *
 * RFC 8292 §2.1 allows both `mailto:` and `https:` for `sub`, so a project URL
 * is a conforming default that needs no per-install mailbox.
 *
 * ## Why an invalid subject is reported and NOT replaced
 *
 * {@link inspectVapidConfig} flags a bad `CM_VAPID_SUBJECT`; {@link getVapidConfig}
 * still returns it verbatim. Silently substituting the default would make the
 * warning describe a value the server does not actually send, and would make
 * `commandmate status` disagree with the wire. The operator set it; they are told
 * it will be rejected, and startup is never blocked (fail-open, exactly as
 * `lib/server/localhost-self-check` is).
 *
 * ## No `@/` imports here, ever
 *
 * `src/cli/commands/status.ts` imports this module so the CLI and the server run
 * the SAME check, and `tsconfig.cli.json` resets `paths` to `{}` — an alias
 * import here would break `npm run build:cli`. Same constraint as
 * `lib/server/localhost-self-check.ts` and `lib/detection/version-probes.ts`.
 * This module must also stay dependency-free for that reason.
 *
 * @module lib/push/vapid
 */

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Default `sub` claim when `CM_VAPID_SUBJECT` is unset.
 *
 * A real, resolvable https: URL — see the module header for the APNs measurement
 * that made `mailto:commandmate@localhost` the wrong answer (Issue #2124).
 */
export const VAPID_DEFAULT_SUBJECT = 'https://github.com/Kewton/CommandMate';

/** The three environment variables that configure Web Push. */
export const VAPID_ENV_KEYS = {
  publicKey: 'CM_VAPID_PUBLIC_KEY',
  privateKey: 'CM_VAPID_PRIVATE_KEY',
  subject: 'CM_VAPID_SUBJECT',
} as const;

/**
 * Host suffixes that never resolve on the public internet, so a push service can
 * never verify a `sub` that names one.
 *
 * `.example` is here as a *TLD*; `example.com` is an ordinary resolvable domain
 * and is deliberately NOT rejected (it is the conventional placeholder in every
 * VAPID tutorial and in this repository's own tests).
 */
const NON_ROUTABLE_TLDS: readonly string[] = [
  'local',
  'localhost',
  'localdomain',
  'internal',
  'intranet',
  'home',
  'lan',
  'test',
  'invalid',
  'example',
];

/** What is wrong with a `CM_VAPID_SUBJECT`, or `null` when nothing is. */
export type VapidSubjectIssue =
  /** Neither `mailto:` nor `https:` — RFC 8292 §2.1 allows only those two. */
  | 'unsupported-scheme'
  /** Parsed as a supported scheme but carries no host at all. */
  | 'missing-host'
  /** A host no push service can resolve: `localhost`, a bare name, a reserved TLD, a loopback literal. */
  | 'non-routable-host';

/** Loopback / unspecified literals, which are never a contact anyone can reach. */
function isLoopbackLiteral(host: string): boolean {
  if (host === '::1' || host === '0.0.0.0' || host === '::') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The host a subject names, lowercased, or `null` when it names none.
 *
 * `mailto:` takes everything after the LAST `@` (a local part may legally contain
 * one when quoted) up to the first `?` (RFC 6068 header separator). `https:` is
 * parsed by `URL`, whose `hostname` already strips the brackets off an IPv6
 * literal.
 */
export function extractVapidSubjectHost(subject: string): string | null {
  const trimmed = subject.trim();

  if (/^mailto:/i.test(trimmed)) {
    const address = trimmed.slice('mailto:'.length).split('?')[0];
    const at = address.lastIndexOf('@');
    if (at < 0) return null;
    const host = address.slice(at + 1).trim().toLowerCase();
    return host.length > 0 ? host : null;
  }

  try {
    const url = new URL(trimmed);
    return url.hostname.length > 0 ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a `sub` claim is one a push service can be expected to accept.
 *
 * Deliberately conservative: it rejects only hosts that provably cannot resolve.
 * A reachable-but-wrong contact (`mailto:nobody@example.com`) is the operator's
 * business, and a check that guessed at it would warn on healthy installs.
 *
 * @param subject - Raw `CM_VAPID_SUBJECT`, or the default.
 * @returns The problem, or `null` when the subject is usable.
 */
export function classifyVapidSubject(subject: string): VapidSubjectIssue | null {
  const trimmed = subject.trim();
  if (!/^(mailto:|https:\/\/)/i.test(trimmed)) return 'unsupported-scheme';

  const host = extractVapidSubjectHost(trimmed);
  if (host === null) return 'missing-host';

  if (isLoopbackLiteral(host)) return 'non-routable-host';
  // A bare name (`localhost`, `mac-mini`) has no public resolution path.
  if (!host.includes('.')) return 'non-routable-host';

  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (NON_ROUTABLE_TLDS.includes(tld)) return 'non-routable-host';

  return null;
}

/** How a deployment's Web Push configuration reads right now. */
export type VapidStatus =
  /** Neither key is set: push is off, and nothing was half-configured. */
  | 'unconfigured'
  /** Exactly one of the two keys is set — almost always a typo or a half-finished edit. */
  | 'partial'
  /** Both keys present, but `CM_VAPID_SUBJECT` will be rejected by at least APNs. */
  | 'invalid-subject'
  /** Both keys present and the subject is usable. Nothing to report. */
  | 'ok';

/** The single verdict {@link inspectVapidConfig} produces (Issues #2123 / #2124). */
export interface VapidInspection {
  status: VapidStatus;
  /** True when both keys are present, i.e. when push can send at all. */
  configured: boolean;
  /** The `sub` claim that will actually be sent. */
  subject: string;
  /** Whether {@link subject} came from the environment or from the built-in default. */
  subjectSource: 'env' | 'default';
  /** What is wrong with {@link subject}, or `null`. */
  subjectIssue: VapidSubjectIssue | null;
  /** Names of the VAPID variables that are set — never their values. */
  presentKeys: readonly string[];
  /** Names of the key variables that are missing. */
  missingKeys: readonly string[];
}

/** The slice of the environment this module reads. */
export type VapidEnv = Readonly<Record<string, string | undefined>>;

/**
 * Read the three variables and say, in one verdict, everything both Issues need
 * reported: whether push is on at all (#2123) and whether the subject will be
 * accepted (#2124).
 *
 * ONE check, two facts — deliberately not two checks. The startup log, the
 * `commandmate status` output and the unit suite all consume this one function,
 * so the two surfaces cannot drift apart.
 *
 * Pure: no I/O, no logging, never throws.
 *
 * @param env - Environment to read (default: `process.env`). `commandmate status`
 *   passes the env the *daemon* runs with, which is not this process's own.
 */
export function inspectVapidConfig(env: VapidEnv = process.env): VapidInspection {
  const publicKey = env[VAPID_ENV_KEYS.publicKey]?.trim() ?? '';
  const privateKey = env[VAPID_ENV_KEYS.privateKey]?.trim() ?? '';
  const rawSubject = env[VAPID_ENV_KEYS.subject]?.trim() ?? '';

  const presentKeys: string[] = [];
  const missingKeys: string[] = [];
  (publicKey ? presentKeys : missingKeys).push(VAPID_ENV_KEYS.publicKey);
  (privateKey ? presentKeys : missingKeys).push(VAPID_ENV_KEYS.privateKey);

  const subject = rawSubject || VAPID_DEFAULT_SUBJECT;
  const subjectSource: 'env' | 'default' = rawSubject ? 'env' : 'default';
  const subjectIssue = classifyVapidSubject(subject);
  if (rawSubject) presentKeys.push(VAPID_ENV_KEYS.subject);

  const configured = publicKey !== '' && privateKey !== '';
  const status: VapidStatus = configured
    ? subjectIssue === null
      ? 'ok'
      : 'invalid-subject'
    : publicKey || privateKey
      ? 'partial'
      : 'unconfigured';

  return {
    status,
    configured,
    subject,
    subjectSource,
    subjectIssue,
    presentKeys,
    missingKeys,
  };
}

/** Human-readable reason for a {@link VapidSubjectIssue}. */
function describeSubjectIssue(issue: VapidSubjectIssue): string {
  switch (issue) {
    case 'unsupported-scheme':
      return 'it is neither a "mailto:" address nor an "https://" URL (RFC 8292 allows only those two)';
    case 'missing-host':
      return 'it names no host at all';
    case 'non-routable-host':
      return 'its host cannot be resolved from the public internet (localhost, a bare name, or a reserved TLD)';
  }
}

/**
 * The startup / `status` report, as lines — shared by both surfaces so they can
 * never drift apart, exactly as `formatLocalhostConflictWarning` is (#2113).
 *
 * **Returns an empty array when the configuration is healthy.** That silence is
 * the negative control both Issues ask for: a correctly configured server prints
 * nothing about push, so the presence of a line is itself the signal.
 *
 * Never includes a key or a private value. `subject` is printed because it is the
 * value the operator has to fix, and it is a contact address rather than a
 * credential — the module header's "never log the config" rule is about the keys.
 */
export function formatVapidReportLines(inspection: VapidInspection): string[] {
  switch (inspection.status) {
    case 'ok':
      return [];

    case 'unconfigured':
      return [
        'Push notifications are disabled: no VAPID keys are configured.',
        `  Set ${VAPID_ENV_KEYS.publicKey} and ${VAPID_ENV_KEYS.privateKey} to enable them.`,
        '  "commandmate init" generates a key pair for you.',
        '  Setup: docs/user-guide/webapp-guide.md ("Phone notifications")',
      ];

    case 'partial':
      return [
        `Push notifications are disabled: ${inspection.missingKeys.join(' and ')} ${
          inspection.missingKeys.length > 1 ? 'are' : 'is'
        } not set.`,
        `  Both ${VAPID_ENV_KEYS.publicKey} and ${VAPID_ENV_KEYS.privateKey} are required;` +
          ' a key pair only works as a pair.',
        '  "commandmate init" generates a key pair for you.',
        '  Setup: docs/user-guide/webapp-guide.md ("Phone notifications")',
      ];

    case 'invalid-subject':
      return [
        `${VAPID_ENV_KEYS.subject}="${inspection.subject}" will be rejected by Apple (APNs):` +
          ` ${describeSubjectIssue(inspection.subjectIssue as VapidSubjectIssue)}.`,
        '  iPhone/iPad receive nothing while Android keeps working, because FCM does not check it.',
        `  Use a reachable contact, e.g. ${VAPID_DEFAULT_SUBJECT} or mailto:you@your-domain.example.org.`,
        `  Unset ${VAPID_ENV_KEYS.subject} to fall back to ${VAPID_DEFAULT_SUBJECT}.`,
      ];
  }
}

/** Options for {@link runVapidSelfCheck}. */
export interface RunVapidSelfCheckOptions {
  /** Environment to inspect (default: `process.env`). */
  env?: VapidEnv;
  /** Where the report goes (default: `console.warn`). */
  warn?: (message: string) => void;
}

/**
 * Run the startup self-check and print its verdict, or nothing when healthy.
 *
 * Fail-open by construction, the same contract `runLocalhostSelfCheck` carries:
 * it never throws, it never blocks `listen`, and a healthy install is silent.
 *
 * @returns The inspection, or `null` when the check itself could not be carried
 *   out (which is reported as nothing at all).
 */
export function runVapidSelfCheck(options: RunVapidSelfCheckOptions = {}): VapidInspection | null {
  const { env = process.env, warn = (message: string) => console.warn(message) } = options;

  try {
    const inspection = inspectVapidConfig(env);
    for (const line of formatVapidReportLines(inspection)) {
      warn(line);
    }
    return inspection;
  } catch {
    // A diagnostic must never be the reason a server fails to start.
    return null;
  }
}

/**
 * Returns the VAPID config, or null when push is not configured (both public
 * and private keys must be present). Read from env on every call.
 */
export function getVapidConfig(): VapidConfig | null {
  const publicKey = process.env[VAPID_ENV_KEYS.publicKey]?.trim();
  const privateKey = process.env[VAPID_ENV_KEYS.privateKey]?.trim();
  if (!publicKey || !privateKey) {
    return null;
  }
  const subject = process.env[VAPID_ENV_KEYS.subject]?.trim() || VAPID_DEFAULT_SUBJECT;
  return { publicKey, privateKey, subject };
}

/** True when both VAPID keys are configured. */
export function isPushConfigured(): boolean {
  return getVapidConfig() !== null;
}

/** The public (application server) key clients need to subscribe, or null. */
export function getVapidPublicKey(): string | null {
  return getVapidConfig()?.publicKey ?? null;
}
