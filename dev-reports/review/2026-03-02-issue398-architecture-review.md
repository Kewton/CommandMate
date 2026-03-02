# Architecture Review: Issue #398 - LM Studio モデル選択対応

| 項目 | 値 |
|------|-----|
| Issue | #398 |
| Stage | 1 (通常レビュー) |
| Focus | 設計原則 (SOLID/KISS/YAGNI/DRY) |
| Status | conditionally_approved |
| Score | 4/5 |
| Date | 2026-03-02 |

---

## Executive Summary

設計方針書全体として高品質である。SRP、YAGNI、KISSのバランスが適切に取れており、セキュリティ設計（SEC-001 SSRF防止、SEC-002 DoS防御、SEC-003 JSONインジェクション防止）も堅実。`fetchOllamaModels()`と`fetchLmStudioModels()`への責務分離は明確で、失敗隔離パターン（例外を投げず空オブジェクトを返す）も実用的。

主要な課題は1点: 設計書がOCP（開放閉鎖原則）を設計原則として掲げているにもかかわらず、実装設計がインラインif分岐に依存しており、新プロバイダー追加時にensureOpencodeConfig()本体の修正が必要となる矛盾がある。

---

## Detailed Findings

### Must Fix (1件)

#### S1-003: ensureOpencodeConfig() 内のプロバイダー構成組み立てロジックの肥大化リスク

**Category**: SRP / OCP
**Location**: 設計方針書 セクション2-2、セクション6-3

設計書セクション2-2で `[D1-002 OCP] 新プロバイダー追加時に既存関数を変更せず拡張可能` を設計原則として明示しているが、セクション6-3の`ensureOpencodeConfig()`実装では各プロバイダーのconfigオブジェクト組み立てがインラインで行われている。

```typescript
// 現在の設計 - 新プロバイダーごとにif分岐が増加
if (Object.keys(ollamaModels).length > 0) {
  provider.ollama = { npm: '...', name: 'Ollama (local)', options: { baseURL: OLLAMA_BASE_URL }, models: ollamaModels };
}
if (Object.keys(lmStudioModels).length > 0) {
  provider.lmstudio = { npm: '...', name: 'LM Studio (local)', options: { baseURL: LM_STUDIO_BASE_URL }, models: lmStudioModels };
}
```

新プロバイダー追加時にensureOpencodeConfig()本体を修正する必要があり、OCPに違反する。

**Recommendation**: 以下のいずれかを選択すること。

(A) OCP準拠設計に改修:
```typescript
// プロバイダー定義をデータとして外部化
const PROVIDER_DEFINITIONS = [
  { key: 'ollama', fetch: fetchOllamaModels, npm: '@ai-sdk/openai-compatible', name: 'Ollama (local)', baseURL: OLLAMA_BASE_URL },
  { key: 'lmstudio', fetch: fetchLmStudioModels, npm: '@ai-sdk/openai-compatible', name: 'LM Studio (local)', baseURL: LM_STUDIO_BASE_URL },
];
```

(B) OCP主張を取り下げ、設計書を正直に記述:
- `[D1-002]`を「2プロバイダー限定のKISS設計。3プロバイダー目追加時にデータ駆動方式へリファクタリング」に修正。

---

### Should Fix (4件)

#### S1-001: タイムアウト/AbortController/レスポンスサイズチェックの重複コード

**Category**: DRY
**Location**: 設計方針書 セクション3 D1

`fetchOllamaModels()`と`fetchLmStudioModels()`の間で以下の4つの同一パターンが完全に重複する:

1. `new AbortController()` + `setTimeout(() => controller.abort(), TIMEOUT_MS)`
2. `response.text()` 後の `.length > MAX_RESPONSE_SIZE` チェック
3. `catch (error)` 内の `error.name === 'AbortError'` 分岐
4. `console.warn()` + `return {}` のフォールバック

設計書のYAGNI判断（選択肢B採用）は理解できるが、APIレスポンス解析ロジック（JSON構造の違い）とHTTP通信の共通基盤は明確に分離可能である。

**Recommendation**: テキストレスポンスを返すだけの最小限ヘルパーを検討。

```typescript
async function fetchLocalApiText(url: string, timeoutMs: number, maxSize: number): Promise<string | null> {
  // AbortController, timeout, size check の共通処理
  // 失敗時は null を返す
}
```

レスポンスのJSON解析は各fetch関数固有に維持するため、API応答形式の違いは問題にならない。

---

#### S1-004: Promise.allのエラーハンドリング記述の不足

**Category**: KISS
**Location**: 設計方針書 セクション8-1

Promise.allの採用自体は適切（各関数が例外を投げない設計のため拒否されない）だが、設計書にその安全性の根拠が明記されていない。

**Recommendation**: セクション8-1に以下の注記を追加: 「各fetchXxxModels()は内部で全例外を捕捉し空オブジェクトを返すため、Promise.allが拒否されることはない。ただし、防御的にtry-catchで囲むことを推奨する。」

---

#### S1-006: ProviderModels型の設計意図の明記不足

**Category**: 型設計
**Location**: 設計方針書 セクション3 D4

`ProviderModels = Record<string, { name: string }>` はopencode.jsonのmodels構造に合致しており実用的だが、Ollama固有のdetails情報（parameter_size等）がformatModelDisplayName()でname文字列に折りたたまれる設計意図が明記されていない。

**Recommendation**: 設計書D4に「ProviderModelsはopencode.jsonのmodels構造に直接マッピングするミニマル型。Ollama APIのdetails情報はformatModelDisplayName()でname文字列に統合済み。UI層で追加情報が必要な場合は/api/ollama/modelsを使用」と記載。

---

#### S1-008: セクション6-3とセクション8-1のコード例不整合

**Category**: その他
**Location**: 設計方針書 セクション6-3 vs セクション8-1

セクション6-3のensureOpencodeConfig()コード例:
```typescript
const ollamaModels = await fetchOllamaModels();       // 直列
const lmStudioModels = await fetchLmStudioModels();    // 直列
```

セクション8-1:
```typescript
const [ollamaModels, lmStudioModels] = await Promise.all([  // 並列
  fetchOllamaModels(),
  fetchLmStudioModels(),
]);
```

設計書内で採用方式が不一致。

**Recommendation**: セクション6-3のコード例をPromise.all形式に統一する。

---

### Nice to Have (4件)

#### S1-002: 定数の対称的重複

**Category**: DRY
**Location**: セクション4

TIMEOUT_MS=3000、MAX_RESPONSE_SIZE=1MB、MAX_MODELS=100がOllama/LM Studioで同一値で重複定義される。共通定数化も可能だが、将来プロバイダー固有値になる可能性を考慮すると現状維持でも問題ない。

---

#### S1-005: リファクタリングポイントのTODOコメント記載

**Category**: YAGNI
**Location**: セクション3 D1

3プロバイダー目追加時の共通化検討ポイントをコードコメントとして残すことを推奨。

---

#### S1-007: LM_STUDIO_MODEL_PATTERN長さ上限の根拠記載

**Category**: OCP
**Location**: セクション4-1

OLLAMA=100文字、LM_STUDIO=200文字の差異の根拠（LM Studioのorganization/model-name形式が長い）を設計書に明記すること。

---

#### S1-009: OLLAMA定数の既存重複

**Category**: DRY
**Location**: セクション4-2、`/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/app/api/ollama/models/route.ts`

`/api/ollama/models/route.ts`にもOLLAMA_API_URL/OLLAMA_TIMEOUT_MSが独立定義されている。Issue #398スコープ外とするのが妥当だが、設計書セクション9に明記を推奨。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | OCP設計原則と実装の矛盾による3プロバイダー目追加時の大規模リファクタリング | Medium | Low | P2 |
| 技術的リスク | Promise.allの予期せぬ拒否（各fetch関数の例外漏れ） | Low | Low | P3 |
| セキュリティ | SEC-001/SEC-002/SEC-003/SEC-004は適切に設計されている | Low | Low | - |
| 運用リスク | LM Studio未起動時のUX（console.warnのみ、ユーザー通知なし） | Low | Medium | P3 |

---

## Design Principles Compliance Checklist

| 原則 | 評価 | 備考 |
|------|------|------|
| SRP (Single Responsibility) | PASS | fetchOllamaModels()/fetchLmStudioModels()の責務分離は適切 |
| OCP (Open/Closed) | CONDITIONAL | 設計原則として掲げているが実装がインラインif分岐（S1-003） |
| LSP (Liskov Substitution) | N/A | クラス継承なし |
| ISP (Interface Segregation) | PASS | ProviderModels型はミニマルで適切 |
| DIP (Dependency Inversion) | N/A | モジュール内部の設計のため該当なし |
| KISS | PASS | Promise.all並列化は適切。fetch関数の独立性も理解しやすい |
| YAGNI | PASS | 汎用ヘルパー化の先送り判断は妥当 |
| DRY | CONDITIONAL | タイムアウト/AbortControllerの重複は意図的だがトレードオフあり（S1-001） |

---

## Reviewed Files

| ファイル | 役割 |
|---------|------|
| `dev-reports/design/issue-398-lmstudio-opencode-design-policy.md` | 設計方針書（レビュー対象） |
| `src/lib/cli-tools/opencode-config.ts` | 現在の実装（変更対象） |
| `src/lib/cli-tools/opencode.ts` | 呼び出し元 |
| `src/lib/cli-tools/types.ts` | CLI型定義 |
| `src/lib/cli-tools/base.ts` | BaseCLITool基底クラス |
| `tests/unit/cli-tools/opencode-config.test.ts` | 既存テスト |
| `src/app/api/ollama/models/route.ts` | Ollama API定数の重複確認 |

---

## Approval

**Status**: Conditionally Approved

S1-003（OCP矛盾の解消）を対応した上で実装に進むことを推奨。S1-003は設計書の記述修正のみで対応可能（選択肢B: OCP主張を取り下げてKISS設計と明記）であり、コード変更は不要。その他のshould_fix項目は実装フェーズで対応可能。

---

*Generated by architecture-review-agent for Issue #398*
*Date: 2026-03-02*
