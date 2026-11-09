/**
 * The body a promote writes (Issue #4225, design §5.2・§5.5, T15・T22): every free field
 * is one code block, whatever it holds, and nothing typed becomes a heading, HTML or a
 * link. Parsed with remark (already a dependency), as a reader's Markdown would.
 */
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { fenceFor, renderPromoteBody, sha256, type PromoteRenderInput } from '@/lib/promote/render';

const base = (text: string, quote: PromoteRenderInput['quote'] = null): PromoteRenderInput => ({
  operationId: '11111111-2222-4333-8444-555555555555',
  itemId: 'item-1',
  itemVersion: 3,
  branch: 'feature/x',
  effect: 'spec',
  authorInstanceId: 'claude',
  authorCreatedAt: 0,
  createdAt: 1_000,
  text,
  quote,
});

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}
const nodes = (markdown: string): MdNode[] => {
  const out: MdNode[] = [];
  const walk = (node: MdNode) => {
    out.push(node);
    node.children?.forEach(walk);
  };
  walk(unified().use(remarkParse).parse(markdown) as unknown as MdNode);
  return out;
};

/** The legacy fence (2nd edition): "longest run + 1" only. */
const legacyFence = (content: string) => '`'.repeat(Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length)) + 1);

const HOSTILE = ['plain words, no backticks', 'line one\n\nline three', '# 見出し', '@someone please look', 'see #123', '<!-- hidden -->'];

describe('the body of a promote (T22・T15)', () => {
  it.each(HOSTILE)('the decision text %j is one code node and nothing else', (text) => {
    const rendered = renderPromoteBody(base(text));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const tree = nodes(rendered.body);
    const codes = tree.filter((node) => node.type === 'code');
    expect(codes).toHaveLength(1);
    expect(codes[0].value).toBe(text);
    // The mark is the one HTML node; nothing of the text is a heading, HTML or a link.
    expect(tree.filter((node) => node.type === 'heading')).toHaveLength(0);
    expect(tree.filter((node) => node.type === 'html')).toHaveLength(1);
    expect(tree.filter((node) => node.type === 'link')).toHaveLength(0);
  });

  it('a run of ten backticks inside gets a fence of eleven and cannot close it', () => {
    const text = 'before\n``````````\nafter';
    expect(fenceFor(text)).toBe('`'.repeat(11));
    const rendered = renderPromoteBody(base(text));
    if (!rendered.ok) throw new Error('refused');
    expect(nodes(rendered.body).filter((node) => node.type === 'code').map((node) => node.value)).toEqual([text]);
  });

  it('(positive control) the legacy fence of "longest + 1" is one backtick for a text without any, which is no code block', () => {
    expect(legacyFence('plain words')).toBe('`');
    const legacy = `x\n${legacyFence('plain words')}\nplain words\n${legacyFence('plain words')}\n`;
    expect(nodes(legacy).filter((node) => node.type === 'code')).toHaveLength(0);
    expect(fenceFor('plain words')).toBe('```');
  });

  it('the quote is its own block, headed by its origin', () => {
    const agent = renderPromoteBody(base('decided', { text: 'the original words', origin: 'agent', at: 0 }));
    const human = renderPromoteBody(base('decided', { text: 'the original words', origin: 'human', at: 0 }));
    if (!agent.ok || !human.ok) throw new Error('refused');
    expect(agent.body).toContain('Agent が記録した引用');
    expect(agent.body).toContain('未確認');
    expect(human.body).toContain('人が画面で確かめた引用');
    expect(nodes(agent.body).filter((node) => node.type === 'code').map((node) => node.value)).toEqual(['decided', 'the original words']);
  });

  it('T15: an invisible code point is shown as [U+XXXX] and said so; ordinary text is unchanged', () => {
    const rendered = renderPromoteBody(base('a​b'));
    if (!rendered.ok) throw new Error('refused');
    expect(rendered.body).toContain('a[U+200B]b');
    expect(rendered.invisibleReplaced).toBe(true);
    const plain = renderPromoteBody(base('普通の文 plain'));
    if (!plain.ok) throw new Error('refused');
    expect(plain.invisibleReplaced).toBe(false);
    expect(plain.body).toContain('普通の文 plain');
  });

  it('T15: a secret-like body is refused, with the rule and not the text', () => {
    const rendered = renderPromoteBody(base(`token: ghp_${'a'.repeat(36)}`));
    expect(rendered).toEqual({ ok: false, code: 'secret_like', rule: expect.any(String) });
  });

  it('the body names the operation in its mark and its digest is of the whole body', () => {
    const rendered = renderPromoteBody(base('x'));
    if (!rendered.ok) throw new Error('refused');
    expect(rendered.body.split('\n')[0]).toBe('<!-- commandmate-promote:op=11111111-2222-4333-8444-555555555555; item=item-1 -->');
    expect(rendered.bodySha256).toBe(sha256(rendered.body));
  });
});
