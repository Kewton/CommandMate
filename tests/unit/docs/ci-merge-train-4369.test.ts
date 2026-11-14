/**
 * docs/orchestrate/ci-merge.md keeps the four rules of merge-train PR1 (Issue #4369, design §10 T-R X7):
 * the train's report is never a permission to merge, and merge-pr is called as without a train.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const doc = fs.readFileSync(path.resolve(__dirname, '../../../docs/orchestrate/ci-merge.md'), 'utf8');
const section = doc.slice(doc.indexOf('## 6-2 merge train の診断（merge-train.mjs）'), doc.indexOf('## 6-3 落ちたジョブの再実行と run の完走'));

describe('X7: ci-merge.md — merge train', () => {
  it('has the section', () => {
    expect(section.length).toBeGreaterThan(0);
  });

  it.each([
    ['① publishable: false', '報告は常に `publishable: false`'],
    ['② green is not a reason to merge or to skip merge-pr\'s checks (--last included)', '緑は `B0` の上の `T_N` の 1 回の CI の結果だけで、マージの根拠にも merge-pr の確認（取り込み・precheck・必須の CI・`--last`）を省く根拠にもならない'],
    ['③ the train ref never goes into the base, no PR from it', 'train の ref を base へ入れない・その ref から PR を作らない'],
    ['④ merge-pr with the same arguments as without a train', 'マージは train が無いときと同じ引数・同じ方法で merge-pr を回す（`--queue` の最後の entry の自動の `last` もそのまま）'],
    ['the not-red line of a green after a re-run', '赤ではない（再実行の後の緑。未確認）'],
    ['how a person deletes what is left', '--force-with-lease=refs/heads/train/<base>/<ID>:<SHA>'],
  ])('%s', (_name, sentence) => {
    expect(section).toContain(sentence);
  });
});
