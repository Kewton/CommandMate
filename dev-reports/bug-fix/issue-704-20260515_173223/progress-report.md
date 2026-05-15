# Issue #704 バグ修正完了レポート

- **Issue**: [#704 fix: Claude Code v2.1.142「Use skill "X"?」プロンプトが Yes/No UI として検出されない](https://github.com/Kewton/CommandMate/issues/704)
- **Branch**: `feature/704-worktree` → `develop`
- **Bug ID**: `issue-704-20260515_173223`
- **報告日**: 2026-05-15
- **総合判定**: **PASS**（品質ゲート全通過・回帰ゼロ・API 伝播確認済み）

---

## 1. 概要 / TL;DR

Claude Code v2.1.142 で表示される `Use skill "X"?` 承認プロンプトが、CommandMate の `prompt-detector` で multiple_choice として検出されず、UI に Yes/No ウィンドウが出ない / Auto-Yes も発火しない、という重大な False Negative 不具合を修正しました。

| 項目 | 内容 |
|------|------|
| 真因 | `NORMAL_OPTION_PATTERN` が末尾の `… +1 pending` サマリ行を option(1)=`pending` と誤マッチ → `isValidPrecedingOption()` 連鎖で本物の `1/2/3` を全棄却 → `options.length<2` で `no_prompt` 返却 |
| 修正方針 | ユーザー選択により **S1+S2+S3 三層を全て実装**（即座対策 + 恒久対策 + 回帰防御） |
| S1 | `SUMMARY_LINE_PATTERN` を Pass 2 ループ内で early-continue（行クラス除外） |
| S2 | `CLAUDE_PROMPT_FOOTER_PATTERN` で `effectiveEnd` を Claude フッター直前に切り詰め（構造的境界） |
| S3 | prompt-detector / status-detector / auto-yes-resolver の 3 層に Issue #704 fixture テストを追加 |
| 結果 | lint=0 / tsc=0 / test:unit=6486 passed(7 skipped, +5 new) / coverage=96.95% / 回帰ゼロ |
| 残作業 | UI 実機検証（`/uat` 推奨）/ コミット & PR 作成 / Claude 上流フッター文言の監視（optional） |

修正は **2 層の独立した防御**（S1 と S2 はそれぞれ単独でも Issue #704 fixture を Green にできる）を構成しており、将来 Claude 側のフッター文言またはサマリ行表記が変わっても、どちらか片方が機能している限り回帰しません。

---

## 2. 不具合の根本原因

`src/lib/detection/prompt-detect-multiple-choice.ts` の Pass 2 逆走査で、末尾サマリ行 `… +1 pending` が **option 行として誤マッチ** することが起点です。

```
[誤マッチの流れ]
1. Pass 2 は effectiveEnd-1 から上向きに走査
2. 末尾の "… +1 pending" → NORMAL_OPTION_PATTERN にマッチ
   ([^\d]{0,3} が "… +" を吸収、\d+ が "1"、(.+) が "pending" を捕捉)
   → collectedOptions = [{ number:1, label:"pending" }]
3. その上にある本物の "❯ 1. Yes" / "  2. Yes, ..." / "  3. No" を逆走査
4. isValidPrecedingOption(n, [{n:1}]) は n < firstNumber(=1) を要求
   → 1/2/3 すべて「先行 option として不正」で棄却
5. collectedOptions.length === 1 → Layer 4 (count<2) で noPromptResult
6. detectPrompt が isPrompt=false を返す → status-detector が priority 2 へ
   進み Claude の "Esc to cancel · Tab to amend → · Herding…" を
   CLAUDE_THINKING_PATTERN にヒットさせ status='running' を返す
7. /current-output API は isPromptWaiting=false / promptData=null を返却
8. Auto-Yes も同じ detectPrompt 結果を見ているため発火しない
```

つまり「サマリ行 1 行の誤マッチ」が `isValidPrecedingOption` のアンカー機構を経由して **本物の全 option を巻き添えで棄却** させる、構造的増幅バグでした。

> 詳細根拠: [`investigation-result.json`](./investigation-result.json) `confirmed_root_cause.mechanism`

---

## 3. 修正内容

### S1: `SUMMARY_LINE_PATTERN` による Pass 2 早期スキップ（即座対策）

`prompt-detect-multiple-choice.ts` に新規パターンを追加し、`COLLAPSED_OUTPUT_PATTERN` の早期 continue と同じ位置で除外します。`(.+)` を含まず行頭の `数字 + (pending|more)\b` のみに限定することで、option label に `pending` を含む正当ケース（例: `2. Postpone (will remain pending)`）を巻き込まない設計です。

```ts
// regression-guard:
//   - 行頭アンカー (^) で mid-sentence の "pending" / "more" を保護
//   - \b で語境界限定（"pendingfoo" は弾かない）
//   - (.+) を採用せず、ラベル全体捕捉を行わないので FP 余地が小さい
//   - ReDoS safe (S4-001): ネスト量化子なし・リニア
const SUMMARY_LINE_PATTERN =
  /^\s*[…]?\s*[+\-↑↓⏵⏷]?\s*\d+\s+(?:pending|more)\b/i;
```

Pass 2 ループ内では `COLLAPSED_OUTPUT_PATTERN` の直後に `continuationLineCount++; continue;` を入れるだけの最小変更です。

### S2: `CLAUDE_PROMPT_FOOTER_PATTERN` による `effectiveEnd` 切り詰め（恒久対策）

Claude 承認プロンプトの options 直下には必ず `Esc to cancel · Tab to amend` フッターが描画されます。`scanWindow` 構築前に **逆走査でこのフッター行を検出し、見つかればその index を新しい `effectiveEnd` に採用** することで、サマリ行を含む下流ノイズを構造的にスキャン対象から除外します。

```ts
const CLAUDE_PROMPT_FOOTER_PATTERN =
  /Esc\s+to\s+cancel\s*[·•]\s*Tab\s+to\s+amend/i;

// scanWindow 構築前に逆走査で footer を検索
//   - 見つかれば effectiveEnd を footer 行の直前へ
//   - 見つからなければ no-op（既存挙動を完全保持）
```

フッター不検出時は **完全に既存挙動へフォールバック** するため、Codex/Gemini/OpenCode/Copilot 等への副作用はありません。

### S3: 3 層回帰テスト（予防策）

| 層 | テストファイル | 検証 |
|----|---------------|------|
| Layer 1 | `tests/unit/prompt-detector.test.ts` | `detectPrompt` が `multiple_choice` / options=[Yes, Yes2nd, No] / default=Yes / numbers=[1,2,3] を返す。サマリ行単独で FP を起こさない。`pending` を含む正当 label が棄却されない（過剰除外の検出ペアテスト）。|
| Layer 2 | `tests/unit/lib/status-detector.test.ts` | `detectSessionStatus` が `status='waiting'` / `reason='prompt_detected'` / `hasActivePrompt=true` / `promptDetection.promptData.type='multiple_choice'` を返す。|
| Layer 3 | `tests/unit/lib/auto-yes-resolver.test.ts` | `resolveAutoAnswer` が `'1'`（Yes/default）を返す。|

Layer 2 と API 層（`src/app/api/worktrees/[id]/current-output/route.ts`）の関係はコードレビューで確認済みで、`isPromptWaiting=statusResult.hasActivePrompt` / `promptData=statusResult.promptDetection.promptData` を素通しするため、Layer 2 の Green が API レスポンスの `isPromptWaiting=true / promptData!=null` を保証します。

### 二重防御（Defense-in-Depth）の根拠

実装フェーズで **S1 を一時的に `if (false && ...)` で無効化しても、S2 単体で Issue #704 fixture テスト 3/3 が緑** になることを内部検証済みです（[`tdd-fix-result.json` `defense_in_depth_verification`](./tdd-fix-result.json)）。S1 はフッター文言が将来変わった場合の保険、S2 はサマリ行表記が今後増殖した場合の保険となります。

---

## 4. 修正ファイル一覧

| ファイル | 追加行数 | 概要 |
|---------|---------|------|
| [`src/lib/detection/prompt-detect-multiple-choice.ts`](../../../src/lib/detection/prompt-detect-multiple-choice.ts) | +83 | `SUMMARY_LINE_PATTERN` / `CLAUDE_PROMPT_FOOTER_PATTERN` 定数追加、Pass 2 early-continue、scanWindow 構築前 effectiveEnd 切詰、JSDoc に Issue #704 タグ・ReDoS safe 根拠・FP 抑止理由を明記 |
| [`tests/unit/prompt-detector.test.ts`](../../../tests/unit/prompt-detector.test.ts) | +94 | `describe('Issue #704: Claude v2.1.142 skill approval prompt with trailing summary line')` 配下 3 ケース（fixture / FP 防御 / pending label 保護） |
| [`tests/unit/lib/status-detector.test.ts`](../../../tests/unit/lib/status-detector.test.ts) | +38 | `describe('Issue #704: Claude v2.1.142 Use skill approval prompt')` 1 ケース（API 伝播担保） |
| [`tests/unit/lib/auto-yes-resolver.test.ts`](../../../tests/unit/lib/auto-yes-resolver.test.ts) | +24 | `describe('Issue #704: Use skill approval prompt')` 1 ケース（'1' 自動応答担保） |
| **合計** | **+239 / 4 ファイル** | コア 1 + テスト 3 |

> なお、`status-detector.ts` / `auto-yes-poller.ts` / `current-output/route.ts` は **無変更**。`detectPrompt` 内部実装の修正だけで全層が自動的に正しい結果を返す設計です。

---

## 5. 品質ゲート結果

### コード品質

| ゲート | コマンド | 結果 |
|-------|---------|------|
| ESLint | `npm run lint` | **0 errors / 0 warnings** |
| TypeScript | `npx tsc --noEmit` | **0 errors** |
| Unit Test | `npm run test:unit` | **343 files / 6486 passed / 7 skipped / 0 failed**（13.66s）|

ベースライン 6481 件 + 新規 5 件 = 期待値 6486 件と完全一致。

### Issue #704 ターゲットテスト

| テスト | 件数 | 結果 | エビデンス |
|-------|-----|------|-----------|
| `prompt-detector.test.ts -t "Issue #704"` | 3/3 | PASSED | [`evidence/test-issue704-prompt-detector.log`](./evidence/test-issue704-prompt-detector.log) |
| `status-detector.test.ts -t "Issue #704"` | 1/1 | PASSED | [`evidence/test-issue704-status-detector.log`](./evidence/test-issue704-status-detector.log) |
| `auto-yes-resolver.test.ts -t "Issue #704"` | 1/1 | PASSED | [`evidence/test-issue704-auto-yes-resolver.log`](./evidence/test-issue704-auto-yes-resolver.log) |

### カバレッジ

`src/lib/detection/prompt-detect-multiple-choice.ts`:

| 指標 | 値 | 目標 |
|------|-----|------|
| Statements | 95.6% | 80% |
| Branches | 90.66% | 80% |
| Functions | 100% | 80% |
| Lines | **96.95%** | 80% |

すべて目標を大幅に上回っています。

---

## 6. 受入条件チェック

Issue #704 本文の受入条件 5 項目すべて充足。

| # | 受入条件 | 判定 | 根拠 |
|---|---------|------|------|
| 1 | `Use skill "X"?` を含む実出力 fixture で prompt-detector が `multiple_choice` を返す | PASS | `prompt-detector.test.ts` 3/3 で type/options/default/numbers を厳密検証 |
| 2 | Worktree 詳細画面で Yes/No ウィンドウが表示される（API: `isPromptWaiting=true` / `promptData!=null`） | PASS（ロジック層・API 層）| status-detector unit test + `current-output/route.ts` L106/L137 コードレビューで素通し伝播を確認。UI レイヤーの実機検証のみ `/uat` で別途実施推奨 |
| 3 | Auto-Yes 有効時に自動応答が発火する | PASS | `auto-yes-resolver.test.ts` で `resolveAutoAnswer(promptData) === '1'` を担保 |
| 4 | 既存の Bash/Edit 承認プロンプト検出が壊れていない | PASS | 後述「回帰防御」参照 |
| 5 | 単体テスト追加 & `npm run test:unit` パス | PASS | +5 件 / 全 6486 件パス |

> 受入条件 2 は「UI の DOM レンダリング」までを文字通りに取ると本フェーズの単体テスト範囲を超えるため、`route.ts` のコードレビューで API 伝播を担保し、最終確認は `/uat` 推奨に分離しています。

---

## 7. 回帰防御

### 既存テストへの影響

| カテゴリ | 件数 | 結果 |
|---------|------|------|
| `prompt-detector.test.ts` 全件 | 203/203 | PASS |
| `status-detector.test.ts` 全件 | 28/28 | PASS |
| `auto-yes-resolver.test.ts` 全件 | 9/9 | PASS |
| Codex CLI 関連（`-t "Codex"`、Issue #372/#616/#622 含む） | 13/13 | PASS |
| Gemini CLI 関連（`-t "Gemini"`、● プロンプト含む） | 6/6 | PASS |
| Bash 承認プロンプト関連（`-t "Bash"`） | 5/5 | PASS |
| 全 unit suite | 6486/6486 | PASS |

OpenCode / Copilot は `-t` フィルタで明示的にヒットする describe 名がありませんが、selection-list / generic multiple_choice ロジックを共有しているため、`prompt-detector.test.ts` 全 203 件 Green であることで間接的に担保されています。

### 設計上の回帰耐性

- **S1**: 行頭アンカー `^` + `(?:pending|more)\b` 限定で、option label 中の `pending`（例: `2. Postpone (will remain pending)`）を巻き込まない（FP 抑止テストで明示的に固定済み）。
- **S2**: フッター未検出時は `effectiveEnd` 無変更 → 既存パスへ完全 fallback。Claude 以外の CLI には一切影響しない。
- **ReDoS safe (S4-001)**: 両 RegExp ともリニア、ネスト量化子なし。
- **`isValidPrecedingOption` 等の Layer 3/4/5 ガードは touch せず**: 既存の False Positive 抑止は維持される。

---

## 8. 残課題・フォローアップ

| 項目 | 優先度 | 担当 | 方法 |
|------|--------|------|------|
| UI 実機検証（Yes/No ウィンドウの DOM レンダリング、キー入力反映） | 推奨 | user | `/uat` スキルで Claude Code v2.1.142 実セッションを用いて確認 |
| PR 作成（`feature/704-worktree` → `develop`） | 次ステップ | user | `/create-pr` または手動 |
| Claude Code 上流フッター文言（`Esc to cancel · Tab to amend`）のリリースノート監視 | optional | user | tracking issue として残す（`·` の文字種変更、i18n 化等の早期検知） |
| 関連メタ行（`↑/↓ N more`、`⏵ N line above` 等）の実観測ログ収集 | optional | user | 別 Issue 化（本修正には含めない） |

> 既知の **副症状**（"Esc to cancel · Tab to amend → · Herding…" が `CLAUDE_THINKING_PATTERN` にヒットして status='running'/reason='thinking_indicator' を返す件）は、本修正で priority 1（プロンプト検出）が成功するため自然解消されます。`CLAUDE_THINKING_PATTERN` 自体への変更は不要です。

---

## 9. 次のアクション（推奨手順）

```text
1. git diff の最終確認（4 ファイル / +239 行）
     git diff --stat
     git diff src/lib/detection/prompt-detect-multiple-choice.ts

2. feature/704-worktree でコミット
     git add src/lib/detection/prompt-detect-multiple-choice.ts \
             tests/unit/prompt-detector.test.ts \
             tests/unit/lib/status-detector.test.ts \
             tests/unit/lib/auto-yes-resolver.test.ts
     git commit -m "fix(detection): handle Claude v2.1.142 skill approval prompt summary line (#704)"

3. /uat で UI 実機検証（任意・推奨）
     - Claude Code v2.1.142 セッションを起動し Use skill 承認プロンプトを誘発
     - Yes/No ウィンドウ表示・Auto-Yes 発火を実機確認

4. /create-pr で develop 向け PR を作成
     - タイトル: "fix: Claude v2.1.142 Use skill approval prompt detection (#704)"
     - 本文に S1/S2/S3 の三層防御と回帰ゼロを明記

5. CI（lint/tsc/test:unit/build）パス確認 → develop マージ
```

---

## エビデンスファイル

- 進捗コンテキスト: [`progress-context.json`](./progress-context.json)
- 調査結果: [`investigation-result.json`](./investigation-result.json)
- TDD 実装結果: [`tdd-fix-result.json`](./tdd-fix-result.json)
- 受入テスト結果: [`acceptance-result.json`](./acceptance-result.json)
- 全 unit テストログ: [`evidence/test-unit-full.log`](./evidence/test-unit-full.log)
- Issue #704 ターゲットテストログ:
  - [`evidence/test-issue704-prompt-detector.log`](./evidence/test-issue704-prompt-detector.log)
  - [`evidence/test-issue704-status-detector.log`](./evidence/test-issue704-status-detector.log)
  - [`evidence/test-issue704-auto-yes-resolver.log`](./evidence/test-issue704-auto-yes-resolver.log)
