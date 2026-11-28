/**
 * The flow settings and the scope they name (Issue #4367 PR1a, docs/design/flow-metrics-4367.md
 * §2.1・§6.1). `.commandmate/flow.yaml` is optional; the scope is `repo` + `base`.
 *
 * Only identification git is called, through the shared runner (V3). A key that no caller
 * reads is refused (P-11): `alerts` / `train` / `ledger` / `intervalSec` belong to later PRs or
 * to the other children of Epic #4371 and are named as such.
 *
 * `wip` (Issue #4368 PR1, docs/design/flow-wip-4368.md §7, X9) is read by
 * scripts/orchestrate/flow-wip.mjs: only `wip.total` (an integer 1..1000) is accepted;
 * `wip.active` is named as a key PR2a adds, and any other key under `wip` is refused.
 *
 * `relayWatch` (Issue #4418, docs/design/flow-relay-watch-4418.md §2) is read by `tick`: the PM's
 * session, the sessions only the PM sends to, the server URL (localhost only) and the two
 * thresholds, and whether check 1 is told (`notifyNoRelay`, off until #4420). Without the section `tick` reads and writes exactly what it did before.
 *
 * `milestone` (Issue #4642 PR-1, docs/design/milestone-check-4642.md §4) is read by
 * scripts/orchestrate/milestone-check.mjs: the current Sprint's name (`current`, required — the
 * check never infers it), the roadmap Issue whose last comment records moves (`roadmapIssue`,
 * optional) and how many days of merged PRs count as "just merged" (`mergedWindowDays`, optional,
 * default 14). Any other key under `milestone` is refused.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const CONFIG_FILE = path.join('.commandmate', 'flow.yaml');
export const CONFIG_MAX_BYTES = 64 * 1024;
export const EXCLUDE_MAX = 64;
export const GIT_CAP_MS = 10_000;
export const ALLOWED_KEYS = ['version', 'repo', 'base', 'exclude', 'tz', 'wip', 'relayWatch', 'milestone'];
/** Keys that exist in the design but not in PR1a: refused, with who adds them. */
export const LATER_KEYS = {
  alerts: 'a later PR of #4367 (PR-A)',
  train: '#4369 adds it',
  ledger: 'a later PR of #4367 (PR-L)',
  intervalSec: 'a later PR of #4367 (PR-S)',
};
const ALWAYS_EXCLUDED = ['main', 'master'];
/** The limit section (#4368 PR1). Not exported: no module of scripts/flow/ exports a WIP reader (cli-4367). */
const LIMIT_TOTAL_MAX = 1000;
const LIMIT_LATER_KEYS = { active: 'PR2a of #4368 adds it' };
/** The merged-PR window of the milestone section (#4642 PR-1): 1..365 days, default 14. */
const MILESTONE_WINDOW_MAX = 365;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
/** The relay watch section (#4418). The id patterns mirror the CLI's (`src/cli/utils/api-client.ts`). */
const WATCH_KEYS = ['url', 'pm', 'receivers', 'pendingMinutes', 'screenMinutes', 'notifyNoRelay'];
/**
 * Check 1 (a PM request with no relay) is recorded but not told until #4420 (the relay fix) lands:
 * the PM sends plain `send` for now, so telling it would be a false alarm every time. The switch
 * back is `relayWatch.notifyNoRelay: true` in .commandmate/flow.yaml (design §5.1).
 */
export const NO_RELAY_TOLD_BY_DEFAULT = false;
const WATCH_RECEIVERS_MAX = 32;
const WORKTREE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const INSTANCE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
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
  if ('wip' in doc) {
    const problem = limitSectionProblem(doc.wip);
    if (problem) return { error: `${CONFIG_FILE}: ${problem}` };
  }
  if ('relayWatch' in doc) {
    const problem = watchSectionProblem(doc.relayWatch);
    if (problem) return { error: `${CONFIG_FILE}: ${problem}` };
  }
  if ('milestone' in doc) {
    const problem = milestoneSectionProblem(doc.milestone);
    if (problem) return { error: `${CONFIG_FILE}: ${problem}` };
  }
  return { settings: doc };
}

/**
 * What is wrong with the `wip` section, or null (#4368 PR1, design §7).
 * @param {unknown} section
 * @returns {string | null}
 */
function limitSectionProblem(section) {
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    return 'wip must be a mapping like { total: 8 } (#4368)';
  }
  for (const key of Object.keys(section)) {
    if (Object.prototype.hasOwnProperty.call(LIMIT_LATER_KEYS, key)) {
      return `key "wip.${key}" is not accepted by this version (${LIMIT_LATER_KEYS[key]})`;
    }
    if (key !== 'total') return `unknown key "wip.${key}"`;
  }
  const total = /** @type {{ total?: unknown }} */ (section).total;
  if (!Number.isInteger(total) || /** @type {number} */ (total) < 1 || /** @type {number} */ (total) > LIMIT_TOTAL_MAX) {
    return `wip.total must be an integer from 1 to ${LIMIT_TOTAL_MAX}`;
  }
  return null;
}

/**
 * What is wrong with the `milestone` section, or null (#4642 PR-1, docs/design/milestone-check-4642.md §4).
 * `current` is required (the check never infers it, I4); `roadmapIssue` and `mergedWindowDays` are
 * optional, and no other key is accepted.
 * @param {unknown} section
 * @returns {string | null}
 */
function milestoneSectionProblem(section) {
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    return 'milestone must be a mapping like { current: "Sprint 13" } (#4642)';
  }
  for (const key of Object.keys(section)) {
    if (key !== 'current' && key !== 'roadmapIssue' && key !== 'mergedWindowDays') return `unknown key "milestone.${key}"`;
  }
  const s = /** @type {Record<string, any>} */ (section);
  if (typeof s.current !== 'string' || s.current.trim() === '' || /[\r\n]/.test(s.current)) {
    return 'milestone.current must be the Milestone title (a non-empty single line)';
  }
  if ('roadmapIssue' in s && (!Number.isInteger(s.roadmapIssue) || s.roadmapIssue < 1)) {
    return 'milestone.roadmapIssue must be an Issue number';
  }
  if ('mergedWindowDays' in s && (!Number.isInteger(s.mergedWindowDays) || s.mergedWindowDays < 1 || s.mergedWindowDays > MILESTONE_WINDOW_MAX)) {
    return `milestone.mergedWindowDays must be an integer from 1 to ${MILESTONE_WINDOW_MAX}`;
  }
  return null;
}

function sessionProblem(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${name} must be { worktreeId, instanceId }`;
  for (const key of Object.keys(value)) if (key !== 'worktreeId' && key !== 'instanceId') return `unknown key "${name}.${key}"`;
  if (typeof value.worktreeId !== 'string' || !WORKTREE_ID.test(value.worktreeId)) return `${name}.worktreeId is not a worktree id`;
  if (typeof value.instanceId !== 'string' || !INSTANCE_ID.test(value.instanceId)) return `${name}.instanceId is not an instance id`;
  return null;
}

/**
 * What is wrong with the `relayWatch` section, or null (#4418, docs/design/flow-relay-watch-4418.md §2).
 * @param {unknown} section
 * @returns {string | null}
 */
function watchSectionProblem(section) {
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return 'relayWatch must be a mapping (#4418)';
  for (const key of Object.keys(section)) if (!WATCH_KEYS.includes(key)) return `unknown key "relayWatch.${key}"`;
  const s = /** @type {Record<string, any>} */ (section);
  const pm = sessionProblem(s.pm, 'relayWatch.pm');
  if (pm) return pm;
  if (!Array.isArray(s.receivers) || s.receivers.length < 1 || s.receivers.length > WATCH_RECEIVERS_MAX) {
    return `relayWatch.receivers must be a list of 1 to ${WATCH_RECEIVERS_MAX} sessions`;
  }
  const seen = new Set();
  for (const [i, r] of s.receivers.entries()) {
    const problem = sessionProblem(r, `relayWatch.receivers[${i}]`);
    if (problem) return problem;
    const key = `${r.worktreeId}/${r.instanceId}`;
    if (key === `${s.pm.worktreeId}/${s.pm.instanceId}`) return `relayWatch.receivers[${i}] is the PM itself`;
    if (seen.has(key)) return `relayWatch.receivers[${i}] is listed twice`;
    seen.add(key);
  }
  if ('url' in s) {
    let url = null;
    try {
      url = typeof s.url === 'string' ? new URL(s.url) : null;
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !LOCAL_HOSTS.has(url.hostname) || url.pathname !== '/' || url.search || url.username) {
      return 'relayWatch.url must be http(s)://localhost:<port> (the token is sent to it)';
    }
  }
  for (const key of ['pendingMinutes', 'screenMinutes']) {
    if (key in s && (!Number.isInteger(s[key]) || s[key] < 1 || s[key] > 1440)) return `relayWatch.${key} must be an integer from 1 to 1440`;
  }
  if ('notifyNoRelay' in s && typeof s.notifyNoRelay !== 'boolean') return 'relayWatch.notifyNoRelay must be true or false';
  return null;
}

/**
 * The settings file only — YAML and the `wip` section checked, no git, no GitHub (#4368 P6).
 * `{ settings, wip }` (wip: `{ total }` or null when the section is absent) or `{ error }`.
 * @param {string} repoRoot
 * @param {{ fs?: typeof fs }} [options]
 */
export function readRawFlowConfig(repoRoot, options = {}) {
  const read = readSettingsFile(repoRoot, options);
  if ('error' in read) return { error: read.error };
  const section = read.settings.wip;
  return { settings: read.settings, wip: section ? { total: section.total } : null };
}

/**
 * The scope and settings: `{ repo, slug, base, exclude, tz }` (plus `wip: { total }` when
 * flow.yaml has the section, #4368) or `{ error }`.
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
  const scope = { repo, slug: repoSlug(repo), base, exclude, tz };
  // Only when the section is there, so a #4367-only flow.yaml reads exactly as before (F1).
  const withLimit = settings.wip ? { ...scope, wip: { total: settings.wip.total } } : scope;
  if (!settings.relayWatch) return withLimit;
  const w = settings.relayWatch;
  return {
    ...withLimit,
    relayWatch: {
      url: w.url ?? null,
      pm: { worktreeId: w.pm.worktreeId, instanceId: w.pm.instanceId },
      receivers: w.receivers.map((r) => ({ worktreeId: r.worktreeId, instanceId: r.instanceId })),
      pendingMinutes: w.pendingMinutes ?? 60,
      screenMinutes: w.screenMinutes ?? 20,
      notifyNoRelay: w.notifyNoRelay ?? NO_RELAY_TOLD_BY_DEFAULT,
    },
  };
}
