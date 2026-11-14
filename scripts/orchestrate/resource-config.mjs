/**
 * The reader of `~/.commandmate/resource.yaml` (Issue #4370 PR1a, docs/design/resource-4370.md §2.7).
 *
 * Reads only. The whole budget S = max(1, floor(ncpu × commandmate_share)) is split into the CI VM
 * (`ci_vm.cpus`), the standing reservation for the old `cpu.heavy` lock (`weights.cpu_heavy`) and the
 * host capacity C the semaphore counts: C = S − ci_vm.cpus − weights.cpu_heavy. With defaults only,
 * C ≥ 1 on any number of logical CPUs. A file that cannot be read, a wrong shape, a value out of range,
 * a different `version` or explicit values that leave C < 1 are an error — never folded back to the
 * defaults. An unknown key at the same version is a warning (one file per machine: a newer version may
 * add keys without stopping an older one).
 *
 * The place moves with `CM_RESOURCE_CONFIG` (tests/setup.ts pins it under the temp directory).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

export const RESOURCE_CONFIG_ENV = 'CM_RESOURCE_CONFIG';
export const RESOURCE_CONFIG_VERSION = 1;
export const DEFAULT_COMMANDMATE_SHARE = 0.4;
export const DEFAULT_LOAD_CEILING = 1.0;
export const DEFAULT_LOAD_RESUME = 0.85;
/** The most the default reservation for `cpu.heavy` takes (§2.7: `min(4, max(0, S − ci_vm.cpus − 1))`). */
export const DEFAULT_CPU_HEAVY_MAX = 4;

/** Keys PR1a reads or knows (later PRs validate runners / health / idle); anything else warns. */
const TOP_KEYS = new Set(['version', 'ncpu', 'commandmate_share', 'load_ceiling', 'load_resume', 'weights', 'ci_vm', 'runners', 'health', 'idle']);
const WEIGHTS_KEYS = new Set(['cpu_heavy']);
const CI_VM_KEYS = new Set(['cpus', 'memory_gib']);

/**
 * `CM_RESOURCE_CONFIG` when set, else `~/.commandmate/resource.yaml`.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function resourceConfigPath(env = process.env) {
  const override = env[RESOURCE_CONFIG_ENV];
  return override && override.trim() !== '' ? override : path.join(os.homedir(), '.commandmate', 'resource.yaml');
}

const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

/**
 * @param {{ path?: string, env?: Record<string, string | undefined>, availableParallelism?: () => number }} [options]
 * @returns {{ ncpu: number, S: number, C: number, loadCeiling: number, loadResume: number, ciVmCpus: number, cpuHeavy: number, configHash: string, warnings: string[], path: string } | { error: string, path: string }}
 */
export function loadResourceConfig(options = {}) {
  const env = options.env ?? process.env;
  const file = options.path ?? resourceConfigPath(env);
  const fail = (reason) => ({ error: `config ${file}: ${reason}`, path: file });

  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') return fail(`cannot read (${err?.code ?? 'EUNKNOWN'})`);
  }

  let doc = {};
  if (text !== null) {
    let parsed;
    try {
      parsed = YAML.parse(text);
    } catch (err) {
      return fail(`not YAML (${String(err?.message ?? err).split('\n')[0]})`);
    }
    if (parsed === null || parsed === undefined) parsed = {};
    if (!isMapping(parsed)) return fail('the top level is not a mapping');
    doc = parsed;
  }

  const warnings = [];
  for (const key of Object.keys(doc)) if (!TOP_KEYS.has(key)) warnings.push(`resource: warn unknown key ${key}`);

  const version = doc.version ?? RESOURCE_CONFIG_VERSION;
  if (version !== RESOURCE_CONFIG_VERSION) return fail(`version ${JSON.stringify(version)} is not ${RESOURCE_CONFIG_VERSION}`);

  let ncpu;
  if (doc.ncpu === undefined || doc.ncpu === 'auto') {
    ncpu = (options.availableParallelism ?? os.availableParallelism)();
    if (!Number.isInteger(ncpu) || ncpu < 1) return fail(`the logical CPU count ${ncpu} is not an integer ≥ 1`);
  } else if (Number.isInteger(doc.ncpu) && doc.ncpu >= 1) {
    ncpu = doc.ncpu;
  } else {
    return fail(`ncpu ${JSON.stringify(doc.ncpu)} is not an integer ≥ 1 or auto`);
  }

  const share = doc.commandmate_share ?? DEFAULT_COMMANDMATE_SHARE;
  if (typeof share !== 'number' || !(share > 0 && share <= 1)) return fail(`commandmate_share ${JSON.stringify(share)} is not in (0, 1]`);
  const loadCeiling = doc.load_ceiling ?? DEFAULT_LOAD_CEILING;
  if (typeof loadCeiling !== 'number' || !Number.isFinite(loadCeiling) || !(loadCeiling > 0)) return fail(`load_ceiling ${JSON.stringify(loadCeiling)} is not > 0`);
  const loadResume = doc.load_resume ?? DEFAULT_LOAD_RESUME;
  if (typeof loadResume !== 'number' || !(loadResume > 0 && loadResume < 1)) return fail(`load_resume ${JSON.stringify(loadResume)} is not in (0, 1)`);

  const section = (name, keys) => {
    const value = doc[name];
    if (value === undefined || value === null) return { value: {} };
    if (!isMapping(value)) return { error: `${name} is not a mapping` };
    for (const key of Object.keys(value)) if (!keys.has(key)) warnings.push(`resource: warn unknown key ${name}.${key}`);
    return { value };
  };
  const weights = section('weights', WEIGHTS_KEYS);
  if (weights.error) return fail(weights.error);
  const ciVm = section('ci_vm', CI_VM_KEYS);
  if (ciVm.error) return fail(ciVm.error);
  for (const name of ['runners', 'health', 'idle']) {
    if (doc[name] !== undefined && doc[name] !== null && !isMapping(doc[name])) return fail(`${name} is not a mapping`);
  }

  const ciVmCpus = ciVm.value.cpus ?? 0;
  if (!isNonNegInt(ciVmCpus)) return fail(`ci_vm.cpus ${JSON.stringify(ciVmCpus)} is not an integer ≥ 0`);
  const memoryGib = ciVm.value.memory_gib ?? 0;
  if (typeof memoryGib !== 'number' || !(memoryGib >= 0)) return fail(`ci_vm.memory_gib ${JSON.stringify(memoryGib)} is not a number ≥ 0`);

  const S = Math.max(1, Math.floor(ncpu * share));
  const explicitHeavy = weights.value.cpu_heavy !== undefined;
  const cpuHeavy = explicitHeavy ? weights.value.cpu_heavy : Math.min(DEFAULT_CPU_HEAVY_MAX, Math.max(0, S - ciVmCpus - 1));
  if (!isNonNegInt(cpuHeavy)) return fail(`weights.cpu_heavy ${JSON.stringify(cpuHeavy)} is not an integer ≥ 0`);
  const C = S - ciVmCpus - cpuHeavy;
  if (C < 1) return { error: `config C=${C} (S=${S} ci_vm.cpus=${ciVmCpus} weights.cpu_heavy=${cpuHeavy})`, path: file };

  if (ciVm.value.cpus === undefined) warnings.push('resource: warn ci_vm.cpus is not set (the CI VM allocation is unknown; write the Docker Desktop value)');
  if (!explicitHeavy && cpuHeavy < DEFAULT_CPU_HEAVY_MAX) {
    warnings.push(`resource: warn weights.cpu_heavy shrank to ${cpuHeavy} by default (S=${S}); cpu.heavy holders beyond it are outside the ledger`);
  }

  const normalized = {
    version: RESOURCE_CONFIG_VERSION,
    ncpu,
    commandmate_share: share,
    load_ceiling: loadCeiling,
    load_resume: loadResume,
    weights: { cpu_heavy: cpuHeavy },
    ci_vm: { cpus: ciVmCpus, memory_gib: memoryGib },
  };
  const configHash = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return { ncpu, S, C, loadCeiling, loadResume, ciVmCpus, cpuHeavy, configHash, warnings, path: file };
}
