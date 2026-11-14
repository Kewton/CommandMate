/**
 * The flow settings and the scope they name (Issue #4367 PR1a, docs/design/flow-metrics-4367.md
 * §2.1・§6.1). `.commandmate/flow.yaml` is optional; the scope is `repo` + `base`.
 *
 * Only identification git is called, through the shared runner (V3). A key that no caller
 * reads is refused (P-11): `alerts` / `wip` / `train` / `ledger` / `intervalSec` belong to
 * later PRs or to the other children of Epic #4371 and are named as such.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const CONFIG_FILE = path.join('.commandmate', 'flow.yaml');
export const CONFIG_MAX_BYTES = 64 * 1024;
export const EXCLUDE_MAX = 64;
export const GIT_CAP_MS = 10_000;
export const ALLOWED_KEYS = ['version', 'repo', 'base', 'exclude', 'tz'];
/** Keys that exist in the design but not in PR1a: refused, with who adds them. */
export const LATER_KEYS = {
  alerts: 'a later PR of #4367 (PR-A)',
  wip: '#4368 adds it',
  train: '#4369 adds it',
  ledger: 'a later PR of #4367 (PR-L)',
  intervalSec: 'a later PR of #4367 (PR-S)',
};
const ALWAYS_EXCLUDED = ['main', 'master'];
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Whether `Intl` accepts `tz` as a time zone name. */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The process's own zone (the default when neither `--tz` nor `tz:` names one). */
export function processTimeZone(env = process.env) {
  const fromEnv = env.TZ;
  if (fromEnv && isValidTimeZone(fromEnv)) return fromEnv;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * `owner/name` from a GitHub remote URL, or null for anything that is not github.com.
 * @param {string} url
 * @returns {string | null}
 */
export function parseGithubRemote(url) {
  const text = String(url ?? '').trim();
  const patterns = [
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
    /^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      const repo = `${m[1]}/${m[2]}`;
      return REPO_NAME.test(repo) ? repo : null;
    }
  }
  return null;
}

/**
 * The record dir name of a repo: `<owner>.<name>` lower-cased, `[a-z0-9_.-]` kept, the rest `_`;
 * over 64 characters, the first 51 + `.` + 12 hex of sha1 (the shape of merge-pr's lock name, F5).
 * @param {string} repo
 */
export function repoSlug(repo) {
  const name = String(repo).replace(/\//g, '.').toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
  if (name.length <= 64) return name;
  return `${name.slice(0, 51)}.${crypto.createHash('sha1').update(name).digest('hex').slice(0, 12)}`;
}

/**
 * Reads and checks `.commandmate/flow.yaml` (no git). `{ settings }` or `{ error }`.
 * @param {string} repoRoot
 * @param {{ fs?: typeof fs }} [options]
 */
export function readSettingsFile(repoRoot, options = {}) {
  const fsImpl = options.fs ?? fs;
  const file = path.join(repoRoot, CONFIG_FILE);
  let text;
  try {
    const stat = fsImpl.statSync(file);
    if (!stat.isFile()) return { error: `${CONFIG_FILE} is not a file` };
    if (stat.size > CONFIG_MAX_BYTES) return { error: `${CONFIG_FILE} is over ${CONFIG_MAX_BYTES} bytes` };
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    const code = /** @type {{ code?: string }} */ (err).code;
    if (code === 'ENOENT') return { settings: {} };
    return { error: `${CONFIG_FILE} cannot be read (${code ?? String(err)})` };
  }
  if (Buffer.byteLength(text, 'utf8') > CONFIG_MAX_BYTES) return { error: `${CONFIG_FILE} is over ${CONFIG_MAX_BYTES} bytes` };
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    return { error: `${CONFIG_FILE} is not valid YAML (${err instanceof Error ? err.message.split('\n')[0] : String(err)})` };
  }
  if (doc === null || doc === undefined) return { settings: {} };
  if (typeof doc !== 'object' || Array.isArray(doc)) return { error: `${CONFIG_FILE} must be a mapping` };
  for (const key of Object.keys(doc)) {
    if (Object.prototype.hasOwnProperty.call(LATER_KEYS, key)) {
      return { error: `${CONFIG_FILE}: key "${key}" is not accepted by this version (${LATER_KEYS[key]})` };
    }
    if (!ALLOWED_KEYS.includes(key)) return { error: `${CONFIG_FILE}: unknown key "${key}"` };
  }
  if ('version' in doc && doc.version !== 1) return { error: `${CONFIG_FILE}: version must be 1` };
  if ('repo' in doc && (typeof doc.repo !== 'string' || !REPO_NAME.test(doc.repo))) {
    return { error: `${CONFIG_FILE}: repo must be "owner/name"` };
  }
  if ('base' in doc && (typeof doc.base !== 'string' || !BRANCH.test(doc.base) || doc.base.includes('..'))) {
    return { error: `${CONFIG_FILE}: base must be a branch name` };
  }
  if ('exclude' in doc) {
    if (!Array.isArray(doc.exclude)) return { error: `${CONFIG_FILE}: exclude must be a list of branch names` };
    if (doc.exclude.length > EXCLUDE_MAX) return { error: `${CONFIG_FILE}: exclude has more than ${EXCLUDE_MAX} entries` };
    if (!doc.exclude.every((b) => typeof b === 'string' && BRANCH.test(b))) {
      return { error: `${CONFIG_FILE}: exclude must be a list of branch names` };
    }
  }
  if ('tz' in doc && !isValidTimeZone(doc.tz)) return { error: `${CONFIG_FILE}: tz is not a time zone Intl accepts` };
  return { settings: doc };
}

/**
 * The scope and settings: `{ repo, slug, base, exclude, tz }` or `{ error }`.
 * Calls only identification git, each through `runBounded` against `deadlineMono`.
 * @param {string} repoRoot
 * @param {{ runBounded: Function, env?: Record<string, string | undefined>, deadlineMono: number, tz?: string, fs?: typeof fs }} options
 */
export function readFlowConfig(repoRoot, options) {
  const { runBounded, deadlineMono } = options;
  const env = options.env ?? process.env;
  const read = readSettingsFile(repoRoot, { fs: options.fs });
  if ('error' in read) return { error: read.error };
  const settings = read.settings;
  const git = (args) => runBounded('git', args, { deadlineMono, capMs: GIT_CAP_MS, cwd: repoRoot });

  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.status === 'timeout') return { error: 'identification timed out (git rev-parse)' };
  if (common.status !== 'ok' || String(common.stdout ?? '').trim() === '') return { error: `${repoRoot} is not a git repository` };

  let repo = settings.repo;
  if (!repo) {
    const origin = git(['remote', 'get-url', 'origin']);
    if (origin.status === 'timeout') return { error: 'identification timed out (git remote)' };
    if (origin.status !== 'ok') return { error: 'origin is not set; flow needs a GitHub origin or repo: in flow.yaml' };
    repo = parseGithubRemote(origin.stdout);
    if (!repo) return { error: 'origin is not a github.com repository' };
  }

  let base = settings.base;
  if (!base) {
    const develop = git(['rev-parse', '--verify', 'refs/remotes/origin/develop']);
    if (develop.status === 'timeout') return { error: 'identification timed out (git rev-parse)' };
    if (develop.status === 'ok') {
      base = 'develop';
    } else {
      const head = git(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      if (head.status === 'timeout') return { error: 'identification timed out (git symbolic-ref)' };
      const ref = head.status === 'ok' ? String(head.stdout ?? '').trim() : '';
      const prefix = 'refs/remotes/origin/';
      if (!ref.startsWith(prefix) || !BRANCH.test(ref.slice(prefix.length))) {
        return { error: 'cannot decide the base: no origin/develop and no origin/HEAD' };
      }
      base = ref.slice(prefix.length);
    }
  }

  const tz = options.tz ?? settings.tz ?? processTimeZone(env);
  if (!isValidTimeZone(tz)) return { error: `tz "${tz}" is not a time zone Intl accepts` };
  const exclude = [...new Set([...(settings.exclude ?? []), base, ...ALWAYS_EXCLUDED])];
  return { repo, slug: repoSlug(repo), base, exclude, tz };
}
