#!/usr/bin/env node
/**
 * Check a `/orchestrate` plan before any worker is started (Issue #3884).
 *
 * Phase 1-3 / 1-4 used to judge dependencies by file only: two PRs that
 * changed different lines of the same shared state (the poller's tick, the
 * prompt-push grace, the current-output publication, wait's human hold) were
 * "weakly dependent" and ran in the same wave, and the conflict and the missed
 * reader showed up in the independent review instead. The plan now carries a
 * machine-readable state file next to plan-<issues>.md, and this script reads
 * it with the contract configs it names (contract.mjs):
 *
 *   version: 1
 *   heavyGateLimit: 1                  # optional (HEAVY_GATE_LIMIT)
 *   waves: [{ id: "1", items: ["3880-a1", "3882"] }, { id: "2", items: ["3880-a2"] }]
 *   items:
 *     - { id: "3880-a1", contract: contract-3880-a1.yaml }   # contract.mjs config, relative to this file
 *     - { id: "3882", gates: [lint, typecheck, unit-related] } # no contract: gates (default DEFAULT_GATES)
 *   sharedState:
 *     - state: auto-yes-confirmation-key
 *       writers: [{ item: "3880-a1", code: "src/lib/polling/auto-yes-decision-state.ts recordDecision" }]
 *       published: ["autoYesConfirmationKey (current-output)"]
 *       readers: [{ route: poller, code: "…" }, { route: current-output, code: "…" }]
 *       invariant: "record, compare and publish use the same key"
 *
 * Rules (each violation is one line `plan-check: <rule>: …`):
 *   plan            the file's own shape (unknown item, an item in no wave or in two, a state named twice, …)
 *   shared-writer   two items of one wave write the same shared state
 *   routes-missing  an item writes a shared state but its contract has no routes table (or no contract)
 *   routes-contract the contract config does not generate (an incomplete routes table is here)
 *   routes-reader   a reader route of a state the item writes has no tested cell in its routes table
 *   heavy-gates     a wave starts more items with a heavy gate (HEAVY_GATES) than the limit
 *
 * A run without a state file is checked as before: `check` says it skipped
 * and exits 0, so calling this from the runbook changes nothing for such a run.
 *
 * `routes` prints, for one item, the shared states it writes, their readers
 * and invariants, and its routes table — the input of the pre-review
 * (docs/orchestrate/trials.md) and of consistency-review.mjs `--routes`.
 *
 * Exit code: 0 no violation (or no state file); 1 violations; 2 usage error.
 *
 * Usage:
 *   node scripts/orchestrate/plan-check.mjs check --plan <state file> [--json]
 *   node scripts/orchestrate/plan-check.mjs routes --plan <state file> --item <id>
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { DEFAULT_GATES, ROUTE_COLUMNS, loadConfig, routesSection, testedColumns } from './contract.mjs';

/**
 * Gates that take the machine: unit / integration share the `cpu.heavy` mutex
 * (.commandmate/verify.yaml), build is minutes of CPU, e2e starts a browser.
 * `unit-related` is the default of every contract and is not counted.
 */
export const HEAVY_GATES = ['unit', 'integration', 'build', 'e2e'];
/**
 * Items with a heavy gate one wave may start. One, because `cpu.heavy` runs
 * one unit / integration at a time and a second waits holding one of the two
 * verification slots, which stops a third run's light checks too (#3884 H-11).
 */
export const HEAVY_GATE_LIMIT = 1;

const ITEM_ID = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

/** @typedef {{ rule: string, message: string }} Violation */

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check a parsed state file. `baseDir` is where `contract` paths are resolved
 * from; `load` reads a contract config (contract.mjs loadConfig).
 *
 * @param {unknown} plan
 * @param {{ baseDir?: string, load?: (file: string) => any }} [options]
 * @returns {{ violations: Violation[], items: Map<string, { wave: string | null, gates: string[], config: any }> }}
 */
export function checkPlan(plan, { baseDir = process.cwd(), load = loadConfig } = {}) {
  /** @type {Violation[]} */
  const violations = [];
  const add = (rule, message) => violations.push({ rule, message });
  /** @type {Map<string, { wave: string | null, gates: string[], config: any }>} */
  const items = new Map();
  if (!isMapping(plan)) {
    add('plan', 'the state file must be a mapping (version / waves / items / sharedState)');
    return { violations, items };
  }
  if (plan.version !== 1) add('plan', `version: must be 1 (got ${plan.version})`);
  let limit = HEAVY_GATE_LIMIT;
  if (plan.heavyGateLimit !== undefined) {
    if (!Number.isInteger(plan.heavyGateLimit) || plan.heavyGateLimit < 1) add('plan', `heavyGateLimit: must be a positive integer (got ${plan.heavyGateLimit})`);
    else limit = plan.heavyGateLimit;
  }

  // Items and the gates each one will run.
  const rawItems = Array.isArray(plan.items) ? plan.items : [];
  if (!Array.isArray(plan.items) || rawItems.length === 0) add('plan', 'items: at least one item is required');
  rawItems.forEach((raw, index) => {
    const id = isMapping(raw) ? String(raw.id ?? '') : '';
    if (!ITEM_ID.test(id)) return add('plan', `items[${index}]: id must be a file-name-safe token (got ${isMapping(raw) ? raw.id : raw})`);
    if (items.has(id)) return add('plan', `items[${index}]: duplicate id "${id}"`);
    let config = null;
    let gates = [...DEFAULT_GATES];
    if (raw.contract !== undefined && raw.gates !== undefined) {
      add('plan', `${id}: give contract or gates, not both (the contract's gates are what runs)`);
    }
    if (raw.contract !== undefined) {
      const file = path.resolve(baseDir, String(raw.contract));
      try {
        config = load(file);
        gates = config.gates;
      } catch (error) {
        add('routes-contract', `${id}: ${file}: ${String(error.message).replace(/\n\s*/g, ' ')}`);
      }
    } else if (raw.gates !== undefined) {
      if (!Array.isArray(raw.gates) || raw.gates.some((gate) => typeof gate !== 'string')) add('plan', `${id}: gates must be a list of gate ids`);
      else gates = raw.gates;
    }
    items.set(id, { wave: null, gates, config, hasContract: raw.contract !== undefined });
  });

  // Waves: every item in exactly one.
  const waves = Array.isArray(plan.waves) ? plan.waves : [];
  if (!Array.isArray(plan.waves) || waves.length === 0) add('plan', 'waves: at least one wave is required');
  waves.forEach((wave, index) => {
    const waveId = isMapping(wave) && wave.id !== undefined ? String(wave.id) : String(index + 1);
    const members = isMapping(wave) && Array.isArray(wave.items) ? wave.items.map(String) : null;
    if (!members) return add('plan', `waves[${index}]: items must be a list of item ids`);
    for (const id of members) {
      const item = items.get(id);
      if (!item) add('plan', `wave ${waveId}: unknown item "${id}"`);
      else if (item.wave !== null) add('plan', `wave ${waveId}: "${id}" is already in wave ${item.wave}`);
      else item.wave = waveId;
    }
  });
  for (const [id, item] of items) if (item.wave === null) add('plan', `${id}: in no wave`);

  // Shared state: one writer per wave, and every writer carries the routes its readers use.
  const states = plan.sharedState === undefined ? [] : plan.sharedState;
  if (!Array.isArray(states)) add('plan', 'sharedState: must be a list');
  // One record per state: the writers of one wave and the readers a writer covers are judged per
  // record, so a state split over two records would hide two writers in one wave (#3884 review N1).
  /** @type {Map<string, number>} */
  const stateIndex = new Map();
  (Array.isArray(states) ? states : []).forEach((state, index) => {
    const at = `sharedState[${index}]`;
    if (!isMapping(state) || typeof state.state !== 'string' || state.state.trim() === '') {
      return add('plan', `${at}: state (its name) is required`);
    }
    const name = state.state.trim();
    const key = stateKey(name);
    if (stateIndex.has(key)) {
      return add('plan', `${at}: state "${name}" is already sharedState[${stateIndex.get(key)}] — write its writers and readers in one record`);
    }
    stateIndex.set(key, index);
    if (typeof state.invariant !== 'string' || state.invariant.trim() === '') add('plan', `${name}: invariant (what must not break) is required`);
    const writers = Array.isArray(state.writers) ? state.writers : [];
    if (writers.length === 0) add('plan', `${name}: writers: at least one { item, code } is required`);
    const readers = Array.isArray(state.readers) ? state.readers : [];
    if (readers.length === 0) add('plan', `${name}: readers: at least one { route, code } is required`);
    const readerRoutes = [];
    readers.forEach((reader, r) => {
      if (!isMapping(reader) || typeof reader.route !== 'string' || typeof reader.code !== 'string') {
        add('plan', `${name}: readers[${r}] must be { route, code }`);
      } else readerRoutes.push(reader.route);
    });

    /** @type {Map<string, string[]>} wave → writer items */
    const byWave = new Map();
    const writerItems = new Set();
    writers.forEach((writer, w) => {
      if (!isMapping(writer) || typeof writer.item !== 'string' || typeof writer.code !== 'string') {
        return add('plan', `${name}: writers[${w}] must be { item, code }`);
      }
      const item = items.get(writer.item);
      if (!item) return add('plan', `${name}: writer "${writer.item}" is not an item`);
      if (writerItems.has(writer.item)) return;
      writerItems.add(writer.item);
      if (item.wave !== null) byWave.set(item.wave, [...(byWave.get(item.wave) ?? []), writer.item]);
    });
    for (const [wave, ids] of byWave) {
      if (ids.length > 1) add('shared-writer', `${name}: ${ids.join(' and ')} write it in the same wave ${wave} — put the writers in order (one wave each)`);
    }

    for (const id of writerItems) {
      const item = items.get(id);
      if (!item.hasContract) {
        add('routes-missing', `${id} writes ${name} but has no contract config — its routes table cannot be checked`);
        continue;
      }
      if (!item.config) continue; // reported as routes-contract
      if (!item.config.routes) {
        add('routes-missing', `${id} writes ${name} but its contract has no routes table`);
        continue;
      }
      const tested = testedColumns(item.config.routes);
      for (const route of readerRoutes) {
        if (!item.config.routes.columns.includes(route)) {
          add('routes-reader', `${id}: reader route "${route}" of ${name} is not a column of its routes table (columns: ${item.config.routes.columns.join(' / ')}; add it with extraColumns)`);
        } else if (!tested.has(route)) {
          add('routes-reader', `${id}: reader route "${route}" of ${name} has no cell tied to a test (excluded or untested)`);
        }
      }
    }
  });

  // Heavy gates per wave.
  /** @type {Map<string, string[]>} */
  const heavyByWave = new Map();
  for (const [id, item] of items) {
    if (item.wave === null || !item.gates.some((gate) => HEAVY_GATES.includes(gate))) continue;
    heavyByWave.set(item.wave, [...(heavyByWave.get(item.wave) ?? []), id]);
  }
  for (const [wave, ids] of heavyByWave) {
    if (ids.length > limit) {
      add('heavy-gates', `wave ${wave}: ${ids.length} items with a heavy gate (${HEAVY_GATES.join(' / ')}): ${ids.join(', ')} — at most ${limit}; move one to unit-related or a later wave`);
    }
  }
  return { violations, items };
}

/** The name a state is matched by: NFKC, inner whitespace folded to one space, case-insensitive. */
export function stateKey(name) {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** Read a state file (YAML or JSON) and check it. */
export function checkPlanFile(file, options = {}) {
  const plan = YAML.parse(fs.readFileSync(file, 'utf8'));
  return checkPlan(plan, { baseDir: path.dirname(path.resolve(file)), ...options });
}

/**
 * The pre-review / consistency-review input for one item: the shared states it
 * writes (with every reader and the invariant) and its routes table.
 */
export function routesBrief(file, itemId, options = {}) {
  const plan = YAML.parse(fs.readFileSync(file, 'utf8'));
  const { items, violations } = checkPlan(plan, { baseDir: path.dirname(path.resolve(file)), ...options });
  if (violations.length > 0) {
    const error = new Error(`${violations.length} violation(s) — fix the plan first (plan-check check)`);
    error.violations = violations;
    throw error;
  }
  const item = items.get(itemId);
  if (!item) throw new Error(`${file}: no item "${itemId}"`);
  const lines = [`## 割込み順序と読者の一覧（plan-check.mjs routes、item ${itemId}）`, '', '### この item が書く共有状態'];
  const states = (Array.isArray(plan.sharedState) ? plan.sharedState : []).filter(
    (state) => isMapping(state) && Array.isArray(state.writers) && state.writers.some((w) => isMapping(w) && w.item === itemId),
  );
  if (states.length === 0) lines.push('- なし（plan の sharedState に、この item を書き手とする状態は無い）');
  for (const state of states) {
    lines.push(`- ${state.state}: 不変条件「${state.invariant ?? '未記入'}」`);
    for (const writer of state.writers.filter(isMapping)) lines.push(`  - 書き手: ${writer.item} — ${writer.code}`);
    for (const value of Array.isArray(state.published) ? state.published : []) lines.push(`  - 公開値: ${value}`);
    for (const reader of (Array.isArray(state.readers) ? state.readers : []).filter(isMapping)) {
      lines.push(`  - 読む経路: ${ROUTE_COLUMNS[reader.route] ?? reader.route} — ${reader.code}`);
    }
  }
  const routes = item.config?.routes;
  if (routes) lines.push(routesSection(routes, '### 経路表と割込み表（契約の routes。行＝割込み、列＝経路）'));
  else lines.push('', '### 経路表と割込み表', '- 契約に routes が無い');
  return `${lines.join('\n')}\n`;
}

const USAGE = `Usage:
  node scripts/orchestrate/plan-check.mjs check --plan <state file> [--json]
  node scripts/orchestrate/plan-check.mjs routes --plan <state file> --item <id>`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'check' && command !== 'routes') return { error: USAGE };
  const options = { command, json: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--plan' && i + 1 < rest.length) options.plan = rest[++i];
    else if (arg === '--item' && i + 1 < rest.length && command === 'routes') options.item = rest[++i];
    else if (arg === '--json' && command === 'check') options.json = true;
    else return { error: `unknown or incomplete argument: ${arg}\n${USAGE}` };
  }
  if (!options.plan) return { error: `--plan is required\n${USAGE}` };
  if (command === 'routes' && !options.item) return { error: `--item is required\n${USAGE}` };
  return { options };
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const o = parsed.options;
  if (!fs.existsSync(o.plan)) {
    if (o.command === 'routes') {
      stderr.write(`plan-check: no state file ${o.plan}\n`);
      return 2;
    }
    // A run planned before #3884 has no state file: nothing to check, the run goes on as before.
    if (o.json) stdout.write(`${JSON.stringify({ skipped: true, plan: o.plan, violations: [] })}\n`);
    stderr.write(`plan-check: skipped — no state file ${o.plan}\n`);
    return 0;
  }
  try {
    if (o.command === 'routes') {
      stdout.write(routesBrief(o.plan, o.item));
      return 0;
    }
    const { violations, items } = checkPlanFile(o.plan);
    if (o.json) stdout.write(`${JSON.stringify({ skipped: false, plan: o.plan, items: items.size, violations })}\n`);
    for (const v of violations) stderr.write(`plan-check: ${v.rule}: ${v.message}\n`);
    if (violations.length > 0) return 1;
    if (!o.json) stdout.write(`plan-check: ok (${items.size} items)\n`);
    return 0;
  } catch (error) {
    if (error.violations) {
      for (const v of error.violations) stderr.write(`plan-check: ${v.rule}: ${v.message}\n`);
      return 1;
    }
    stderr.write(`plan-check: ${error.message}\n`);
    return o.command === 'routes' ? 2 : 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
