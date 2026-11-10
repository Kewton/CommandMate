/**
 * The hand-off calls no model and no generator and runs no tmux (Issue #4227 G-PR2, design
 * `mem-ui-4227.md` §4.2・§7.3 `handoff-no-generation-4227`): its request text is a fixed
 * template, and nothing of `src/lib/handoff/**` reaches a module that runs the tmux binary,
 * a report generator or a model's SDK — read off the import graph (dynamic imports included),
 * the same judgement as the brief's I9 (`brief-no-generation-4223`).
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createModuleGraph, REPO_ROOT, repoRelative, type ModuleGraph } from './route-tmux-reach';

const HANDOFF_DIR = path.join(REPO_ROOT, 'src', 'lib', 'handoff');
const GENERATOR_PACKAGES = /^(@anthropic-ai\/|openai$|@google\/generative-ai|@google\/genai|ollama$|@mistralai\/|cohere-ai$)/;

export function generationViolations(graph: ModuleGraph, entry: string): string[] {
  const out: string[] = [];
  for (const file of graph.closure(entry)) {
    const module = repoRelative(file);
    const facts = graph.facts(file);
    if (facts.runsTmux) out.push(`${module}: runs tmux`);
    if (/^src\/lib\/report\//.test(module)) out.push(`${module}: report generator`);
    for (const specifier of facts.specifiers) if (GENERATOR_PACKAGES.test(specifier)) out.push(`${module}: generator ${specifier}`);
  }
  return out;
}

const handoffFiles = () => readdirSync(HANDOFF_DIR).filter((name) => name.endsWith('.ts')).map((name) => path.join(HANDOFF_DIR, name));

let scratch: string | null = null;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});
function fixture(text: string): string {
  scratch = mkdtempSync(path.join(tmpdir(), 'handoff-generation-4227-'));
  const file = path.join(scratch, 'careless-handoff.ts');
  writeFileSync(file, text);
  return file;
}

describe('the hand-off generates nothing and runs no tmux (Issue #4227)', () => {
  it('src/lib/handoff/** (every file)', () => {
    const graph = createModuleGraph();
    expect(handoffFiles().length).toBeGreaterThanOrEqual(8);
    for (const entry of handoffFiles()) expect(generationViolations(graph, entry)).toEqual([]);
    expect(graph.unresolved().filter((edge) => edge.includes('lib/handoff'))).toEqual([]);
  });

  it.each([
    ['tmux itself', "import { killSession } from '@/lib/tmux/tmux';\nexport const x = killSession;\n", 'runs tmux'],
    ['tmux, loaded late', "export async function x() { return import('@/lib/tmux/tmux'); }\n", 'runs tmux'],
    ['a model SDK', "import Anthropic from '@anthropic-ai/sdk';\nexport const x = Anthropic;\n", 'generator @anthropic-ai/sdk'],
  ])('positive control: a hand-off importing %s fails', (_name, text, why) => {
    const found = generationViolations(createModuleGraph(), fixture(text));
    expect(found.some((line) => line.includes(why))).toBe(true);
  });
});
