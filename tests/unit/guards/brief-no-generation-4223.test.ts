/**
 * I9 (Issue #4223, design §7): the brief calls no model and no generator, and reaches
 * neither tmux, the relay service nor the WebSocket server — read off the import graph
 * (dynamic imports included) of `src/lib/brief/**` and the brief's route, and of each
 * module a source reads from.
 *
 * The positive controls are files written under `os.tmpdir()` that import what the
 * brief must not: a report generator, tmux, and `relay-service`'s `readSessionRelays`
 * (whose closure reaches tmux through `user-turn-recorder`, the reason S3 reads the
 * ledger from `lib/db/relay-db`).
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createModuleGraph, REPO_ROOT, repoRelative, type ModuleGraph } from './route-tmux-reach';

const BRIEF_DIR = path.join(REPO_ROOT, 'src', 'lib', 'brief');
const ROUTE = path.join(REPO_ROOT, 'src', 'app', 'api', 'worktrees', '[id]', 'mem', 'brief', 'route.ts');

/** The modules S1〜S9 read from (design §1.2). Each is held to the same rule. */
const SOURCE_MODULES = [
  'src/lib/session/agent-instances-resolver.ts',
  'src/lib/session/waiting-episode-state-store.ts',
  'src/lib/session/status-evidence.ts',
  'src/lib/auto-yes-state.ts',
  'src/lib/polling/auto-yes-suppression-state.ts',
  'src/lib/polling/auto-yes-policy.ts',
  'src/lib/db/relay-db.ts',
  'src/lib/db/tasks-db.ts',
  'src/lib/db/verification-db.ts',
  'src/lib/db/mem-db.ts',
  'src/lib/mem/notices.ts',
  'src/lib/mem/present.ts',
  'src/lib/mem/evaluate.ts',
  'src/lib/mem/target.ts',
  'src/lib/db/chat-db.ts',
  'src/cli/utils/reply-ledger.ts',
  'src/lib/db/session-brief-db.ts',
];

/** `child_process` is allowed only where git (#4221/#4222's queries) and the DB's ABI recovery run it. */
const CHILD_PROCESS_ALLOWED = new Set(['src/lib/mem/query-plan.ts', 'src/lib/git/git-exec.ts', 'src/lib/db/abi-recovery.ts']);
const GENERATOR_PACKAGES = /^(@anthropic-ai\/|openai$|@google\/generative-ai|@google\/genai|ollama$|@mistralai\/|cohere-ai$)/;

interface Violation {
  module: string;
  why: string;
}

function violations(graph: ModuleGraph, entry: string): Violation[] {
  const out: Violation[] = [];
  for (const file of graph.closure(entry)) {
    const module = repoRelative(file);
    const facts = graph.facts(file);
    if (facts.runsTmux) out.push({ module, why: 'runs tmux' });
    if (/^src\/lib\/report\//.test(module)) out.push({ module, why: 'report generator' });
    if (/^src\/lib\/relay\//.test(module) && module !== 'src/lib/relay/types.ts') out.push({ module, why: 'relay service' });
    if (/(^|\/)ws-server\.ts$/.test(module)) out.push({ module, why: 'WebSocket server' });
    for (const specifier of facts.specifiers) {
      if (GENERATOR_PACKAGES.test(specifier)) out.push({ module, why: `generator ${specifier}` });
      if ((specifier === 'child_process' || specifier === 'node:child_process') && !CHILD_PROCESS_ALLOWED.has(module)) {
        out.push({ module, why: 'child_process' });
      }
    }
  }
  return out;
}

const briefFiles = (): string[] => readdirSync(BRIEF_DIR).filter((name) => name.endsWith('.ts')).map((name) => path.join(BRIEF_DIR, name));

let scratch: string | null = null;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

function fixture(text: string): string {
  scratch = mkdtempSync(path.join(tmpdir(), 'brief-guard-4223-'));
  const file = path.join(scratch, 'careless-brief.ts');
  writeFileSync(file, text);
  return file;
}

describe('I9 the brief generates nothing and reaches no tmux', () => {
  it('src/lib/brief/** and the route', () => {
    const graph = createModuleGraph();
    expect(briefFiles().length).toBeGreaterThanOrEqual(8);
    for (const entry of [...briefFiles(), ROUTE]) expect(violations(graph, entry)).toEqual([]);
    expect(graph.unresolved().filter((edge) => edge.includes('lib/brief'))).toEqual([]);
  });

  it.each(SOURCE_MODULES)('the source module %s (negative control: what S1〜S9 really import)', (module) => {
    expect(violations(createModuleGraph(), path.join(REPO_ROOT, module))).toEqual([]);
  });

  it('every source module is imported by the brief (the list above is the real one)', () => {
    const graph = createModuleGraph();
    const reach = new Set([...graph.closure(path.join(BRIEF_DIR, 'sources.ts')), ...graph.closure(path.join(BRIEF_DIR, 'build.ts'))].map(repoRelative));
    for (const module of SOURCE_MODULES) expect(reach.has(module)).toBe(true);
  });

  it.each([
    ['relay-service’s readSessionRelays', "import { readSessionRelays } from '@/lib/relay/relay-service';\nexport const x = readSessionRelays;\n", 'runs tmux'],
    ['tmux itself, loaded late', "export async function x() { return import('@/lib/tmux/tmux'); }\n", 'runs tmux'],
    ['a generator package', "import Anthropic from '@anthropic-ai/sdk';\nexport const x = Anthropic;\n", 'generator @anthropic-ai/sdk'],
  ])('positive control: a brief importing %s fails', (_name, text, why) => {
    const file = fixture(text);
    expect(violations(createModuleGraph(), file).map((violation) => violation.why)).toContain(why);
  });
});
