# Issue #193 影響範囲レビューレポート

**レビュー日**: 2026-02-08
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**ステージ**: 3

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 3 |

---

## Must Fix（必須対応）

### MF-1: status-detector.ts 経由の間接依存が影響範囲テーブルに未記載

**カテゴリ**: 影響ファイル
**場所**: `src/lib/status-detector.ts` L87, `src/app/api/worktrees/route.ts` L58, `src/app/api/worktrees/[id]/route.ts` L58

**問題**:
`status-detector.ts` の `detectSessionStatus()` は内部で `detectPrompt()` を呼び出す中間モジュールである。`detectPrompt()` のシグネチャが `options` を受け取るように変更された場合、`detectSessionStatus()` 内部でどのように `cliToolId` を `DetectPromptOptions` に変換するかが設計されていない。

`detectSessionStatus()` は既に `cliToolId` を引数として受け取っている（L77）ため、内部で `DetectPromptOptions` を構築可能だが、Issueにはこのロジックの記載がない。

さらに、`detectSessionStatus()` の呼び出し元である以下の2ファイルが影響範囲テーブルに記載されていない:
- `src/app/api/worktrees/route.ts` L58（サイドバーのステータス一覧取得）
- `src/app/api/worktrees/[id]/route.ts` L58（個別ワークツリーのステータス取得）

これらのファイル自体の修正は不要だが、`detectPrompt()` の検出精度向上による間接影響を受ける。

**証拠**:
```typescript
// status-detector.ts L75-87
export function detectSessionStatus(
  output: string,
  cliToolId: CLIToolType,  // cliToolId は受け取っている
  lastOutputTimestamp?: Date
): StatusDetectionResult {
  // ...
  const promptDetection = detectPrompt(lastLines);  // L87: options 引数なし
```

```typescript
// worktrees/route.ts L58, [id]/route.ts L58
const statusResult = detectSessionStatus(output, cliToolId);  // 間接依存
```

**推奨対応**:
1. `detectSessionStatus()` が内部で `detectPrompt()` を呼ぶ際に `cliToolId` を活用して `DetectPromptOptions` を構築する設計を Phase 3 に明記する
2. `detectSessionStatus()` のシグネチャ自体は変更不要（内部ロジックの修正のみ）
3. 影響範囲テーブルに `worktrees/route.ts` と `[id]/route.ts` を間接影響として追加する

---

### MF-2: 既存テストのモック定義とシグネチャ変更の具体的な修正方針が不明確

**カテゴリ**: 破壊的変更
**場所**: `tests/unit/api/prompt-response-verification.test.ts` L49-51, L112-147; `tests/unit/lib/auto-yes-manager.test.ts` L431

**問題**:
Issue の既存テストファイル更新テーブルではこれら2ファイルを記載しているが、具体的にどの行をどう修正するかが不明確である。

現行のモック定義:
```typescript
// prompt-response-verification.test.ts L49-51
vi.mock('@/lib/prompt-detector', () => ({
  detectPrompt: vi.fn().mockReturnValue({ isPrompt: false, cleanContent: '' }),
}));
```

`vi.fn()` は任意の引数を受け入れるため、モック定義自体はシグネチャ変更の影響を受けない。しかし、テスト内で `vi.mocked(detectPrompt)` の呼び出し引数を検証している箇所（L112, L141 の `vi.mocked(detectPrompt).mockReturnValue(...)` 等）では、第2引数 `options` が渡されるようになると期待値の不一致が発生する可能性がある。

また、`tests/unit/prompt-detector.test.ts` の既存テストは `detectPrompt()` を直接呼んでおり、`options` 未指定のデフォルト動作テストとして正しく機能することを確認する必要がある。

**推奨対応**:
1. 既存テストのモック定義は `vi.fn()` を使用しているため定義自体の変更は不要
2. テスト内の `toHaveBeenCalledWith()` アサーションがある場合は、第2引数を `expect.anything()` または具体的な `options` 値に更新する
3. `tests/unit/prompt-detector.test.ts` の全テストが `options` 未指定でパスすることを Phase 4 で確認する

---

## Should Fix（推奨対応）

### SF-1: claude-poller.ts の到達不能コードと修正工数のトレードオフ

**カテゴリ**: 依存関係
**場所**: `src/lib/claude-poller.ts` L164, L232

**問題**:
Issue #180 のレビュー（stage8-issue-body.md L141）で、claude-poller.ts の `startPolling()` は呼び出されておらず、`detectPrompt()` 呼び出し（L164, L232）はポーリングが開始されない限り到達しないコードと判定されている。

本 Issue で claude-poller.ts を変更対象に含めているが、到達不能コードの修正は工数対効果が低い。

**証拠**:
```
dev-reports/issue/180/issue-review/stage8-issue-body.md L141:
「startPolling は呼び出されておらず、ポーリングのメインパスでは response-poller.ts が使用されている。
detectPrompt() の呼び出し（行164, 行232）はポーリングが開始されない限り到達しないため、修正の優先度は低い。」
```

**推奨対応**:
- 変更対象から除外するか、「到達不能コードだが一貫性のために修正する」旨を明記する
- 代替案として claude-poller.ts 自体の廃止（response-poller.ts への統合）を別 Issue として提案する

---

### SF-2: auto-yes-resolver.test.ts が影響範囲に未記載

**カテゴリ**: テスト範囲
**場所**: `src/lib/auto-yes-resolver.ts` L23-36, `tests/unit/lib/auto-yes-resolver.test.ts`

**問題**:
`resolveAutoAnswer()` は `promptData.options[].isDefault` フラグに依存している。ケースB（`requireDefaultIndicator: false`）で全選択肢が `isDefault: false` になった場合、`defaultOpt` が `undefined` となり `options[0]` にフォールバックする。

```typescript
// auto-yes-resolver.ts L24-25
const defaultOpt = promptData.options.find(o => o.isDefault);
const target = defaultOpt ?? promptData.options[0];
```

このフォールバック動作が期待通りであることをテストで保証すべきだが、`tests/unit/lib/auto-yes-resolver.test.ts` が影響範囲に記載されていない。

**推奨対応**:
- Phase 4 のテスト更新対象に `auto-yes-resolver.test.ts` を追加する
- 「全選択肢が `isDefault: false` の場合は最初の選択肢を選択する」テストケースの存在を確認し、なければ追加する

---

### SF-3: インテグレーションテストが影響範囲に未記載

**カテゴリ**: テスト範囲
**場所**: `tests/integration/api-prompt-handling.test.ts`, `tests/integration/auto-yes-persistence.test.ts`

**問題**:
これら2つのインテグレーションテストファイルが影響範囲に記載されていない。`detectPrompt()` のモック使用状況を確認し、シグネチャ変更の影響を受けるか判定する必要がある。

**推奨対応**:
- Phase 4 の前にこれらのテストファイルで `detectPrompt` のモック使用状況を確認する
- 影響がある場合はテスト更新対象に含める

---

### SF-4: CLAUDE.md の更新が影響範囲に未記載

**カテゴリ**: ドキュメント更新
**場所**: CLAUDE.md

**問題**:
CLAUDE.md の Issue #161 セクションに「prompt-detector.ts の CLIツール非依存性」原則が記載されている。ケースBの `DetectPromptOptions` は CLIツール固有のパラメータを直接含まず、汎用的な `requireDefaultIndicator` フラグとして設計されているため非依存性原則を維持しているが、その設計判断を CLAUDE.md に反映する更新が Issue の影響範囲に含まれていない。

**推奨対応**:
- Issue #193 の変更対象ファイルテーブルに CLAUDE.md の更新を追加する
- 「最近の実装機能」セクションに Issue #193 の概要を追加する必要がある

---

## Nice to Have（あれば良い）

### NTH-1: UIコンポーネントの isDefault フラグ表示への影響

**カテゴリ**: 影響ファイル
**場所**: `src/components/worktree/PromptPanel.tsx`, `src/components/mobile/MobilePromptSheet.tsx`, `src/components/worktree/PromptMessage.tsx`

**問題**:
これらのUIコンポーネントは `detectPrompt()` を直接呼び出していないが、`current-output/route.ts` のAPIレスポンスの `promptData` フィールドを消費している。ケースBで新しい形式の選択肢が検出されるようになると、全選択肢が `isDefault: false` になるケースが発生し、UIのデフォルトハイライト表示が消える可能性がある。

**推奨対応**:
Phase 5 の動作検証項目に、全選択肢が `isDefault: false` の場合のUI表現を含める。

---

### NTH-2: Codex / Gemini への影響分析

**カテゴリ**: 影響ファイル
**場所**: `src/lib/response-poller.ts` L442, L556

**問題**:
`detectPrompt()` はCLIツール非依存関数だが、`response-poller.ts` L442 は全CLIツール共通パスにあるため、Codex / Gemini のプロンプト検出にも影響する。ケースBで `requireDefaultIndicator` オプションを渡す場合、Codex / Gemini のコンテキストでどの値を渡すべきかの明示的な分析がない。

**推奨対応**:
Phase 3 で、Codex / Gemini のコンテキストでは `requireDefaultIndicator` のデフォルト値（`true`）を維持し、Claude Code のコンテキストでのみ `false` を渡す設計を明記する。`response-poller.ts` L498 の `checkForResponse()` は `cliToolId` を引数として受け取っているため、条件分岐は容易。

---

### NTH-3: ドキュメント内コード例の旧シグネチャ

**カテゴリ**: 移行考慮
**場所**: `docs/internal/PROMPT_HANDLING_IMPLEMENTATION_PLAN.md` L459, L964

**問題**:
ドキュメント内の `detectPrompt()` コード例が旧シグネチャのままになる。ランタイムの後方互換性は保たれるため機能的な問題はないが、ドキュメントの整合性が損なわれる。

**推奨対応**:
Phase 4 完了後にドキュメント内のコード例を新シグネチャに更新するか、別のフォローアップ Issue で対応する。

---

## 影響範囲サマリー

### 変更が必要なファイル（直接影響）

| ファイル | 変更種別 | 後方互換 |
|---------|---------|---------|
| `src/lib/prompt-detector.ts` | シグネチャ変更・ロジック修正 | Yes |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | detectPrompt() 呼び出し修正 | Yes |
| `src/lib/auto-yes-manager.ts` | detectPrompt() 呼び出し修正 | Yes |
| `src/lib/response-poller.ts` | stripAnsi() 追加 + detectPrompt() 修正 | Yes |
| `src/lib/claude-poller.ts` | stripAnsi() 追加 + detectPrompt() 修正 (到達不能コード) | Yes |
| `src/lib/status-detector.ts` | detectPrompt() 呼び出し修正 | Yes |
| `src/app/api/worktrees/[id]/current-output/route.ts` | detectPrompt() 呼び出し修正 | Yes |
| `tests/unit/prompt-detector.test.ts` | 新規テスト追加 | - |

### 間接影響を受けるファイル（変更不要だが動作確認必要）

| ファイル | 影響内容 |
|---------|---------|
| `src/app/api/worktrees/route.ts` | detectSessionStatus() 経由の間接影響（サイドバーステータス） |
| `src/app/api/worktrees/[id]/route.ts` | detectSessionStatus() 経由の間接影響（詳細ステータス） |
| `src/lib/auto-yes-resolver.ts` | isDefault フラグ依存の自動応答判定 |
| `src/app/api/worktrees/[id]/respond/route.ts` | 間接フローの動作確認 |
| `src/components/worktree/PromptPanel.tsx` | isDefault フラグの UI 表現 |
| `src/components/mobile/MobilePromptSheet.tsx` | モバイル版 UI |
| `src/components/worktree/PromptMessage.tsx` | 既回答プロンプト表示 |
| `src/hooks/useAutoYes.ts` | クライアント側 Auto-Yes |

### テスト影響

| テストファイル | 影響内容 | 要修正 |
|-------------|---------|--------|
| `tests/unit/prompt-detector.test.ts` | 新規テスト追加、既存テスト pass 確認 | Yes |
| `tests/unit/api/prompt-response-verification.test.ts` | detectPrompt モック更新の可能性 | Yes |
| `tests/unit/lib/auto-yes-manager.test.ts` | detectPrompt モック更新の可能性 | Yes |
| `tests/unit/lib/auto-yes-resolver.test.ts` | isDefault: false フォールバック確認 | 要確認 |
| `tests/integration/api-prompt-handling.test.ts` | detectPrompt モック使用状況確認 | 要確認 |
| `tests/integration/auto-yes-persistence.test.ts` | detectPrompt モック使用状況確認 | 要確認 |
| `src/lib/__tests__/status-detector.test.ts` | detectSessionStatus() 統合テスト | 要確認 |

### CLIツール別影響

| CLIツール | 影響レベル | 詳細 |
|----------|----------|------|
| Claude Code | 直接影響 | 検出精度向上、新形式選択肢対応 |
| Codex CLI | 間接影響 | stripAnsi() 追加による品質向上、既存動作に影響なし |
| Gemini CLI | 間接影響 | Codex と同様 |

### 破壊的変更

**なし**。`detectPrompt()` のシグネチャ変更は optional パラメータの追加であり、TypeScript の型互換性は完全に保持される。

---

## 参照ファイル

### コード（直接変更対象）
- `src/lib/prompt-detector.ts`: DetectPromptOptions 定義、detectPrompt() シグネチャ変更、detectMultipleChoicePrompt() の Pass 1/Layer 4 修正
- `src/lib/status-detector.ts`: detectPrompt() への cliToolId 伝搬ロジック追加
- `src/lib/auto-yes-manager.ts`: detectPrompt() 呼び出しの options 引数追加
- `src/lib/response-poller.ts`: stripAnsi() 適用追加 + detectPrompt() options 引数追加
- `src/lib/claude-poller.ts`: stripAnsi() 適用追加 + detectPrompt() options 引数追加（到達不能コード）
- `src/app/api/worktrees/[id]/prompt-response/route.ts`: detectPrompt() options 引数追加
- `src/app/api/worktrees/[id]/current-output/route.ts`: detectPrompt() options 引数追加

### コード（間接影響）
- `src/app/api/worktrees/route.ts`: detectSessionStatus() 経由の間接影響
- `src/app/api/worktrees/[id]/route.ts`: detectSessionStatus() 経由の間接影響
- `src/lib/auto-yes-resolver.ts`: isDefault フラグ依存の自動応答判定
- `src/components/worktree/PromptPanel.tsx`: PromptData UI 描画
- `src/components/mobile/MobilePromptSheet.tsx`: モバイル版 UI
- `src/hooks/useAutoYes.ts`: クライアント側 Auto-Yes

### ドキュメント
- `CLAUDE.md`: Issue #193 概要追加、prompt-detector.ts の設計変更記載
- `dev-reports/issue/180/issue-review/stage8-issue-body.md`: claude-poller.ts の到達不能コード判定根拠
- `dev-reports/design/issue-161-auto-yes-false-positive-design-policy.md`: 多層防御設計の参照元
