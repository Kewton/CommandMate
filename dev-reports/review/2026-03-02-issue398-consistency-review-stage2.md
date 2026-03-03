# Architecture Review: Issue #398 - Stage 2 (整合性レビュー)

| 項目 | 値 |
|------|-----|
| Issue | #398 |
| Stage | 2 (整合性レビュー) |
| Focus | 整合性 (Consistency) |
| Status | conditionally_approved |
| Score | 4/5 |
| Date | 2026-03-02 |

---

## Executive Summary

Issue #398の設計方針書について、整合性の観点から11件の指摘を行った。Must Fix 2件、Should Fix 5件、Nice to Have 4件である。設計方針書は全体として品質が高く、既存コードの実態を正確に反映しており、Issue #398の要件も網羅的にカバーされている。Stage 1のレビュー指摘（S1-001/S1-003/S1-004/S1-006/S1-008）も適切に反映されている。

主要な課題は、(1) 既存コードのearly returnパターン全4箇所が設計書の問題点記述で1箇所のみ言及されている点、(2) 不採用の設計選択肢がモジュール構成図に残っている点、(3) Ollama 0件取得時の動作変更が明記されていない点である。いずれも設計の方向性自体は正しく、記述の補足で対応可能。

---

## Detailed Findings

### Must Fix (2件)

#### S2-001: 設計書セクション6-1の行番号参照「L163-210」が不安定

**Category**: コード整合性
**Location**: 設計方針書 セクション6-1 fetchOllamaModels() JSDoc

設計書セクション6-1の fetchOllamaModels() JSDoc に「既存ロジック抽出（L163-210の内容）」と記載されている。現在の `opencode-config.ts` のL163-210は確かにOllama API fetchブロックに対応する。

```
// opencode-config.ts 実際のコード位置確認
L163: // Fetch models from Ollama API
L164: const models: Record<string, { name: string }> = {};
L165-201: try { ... Ollama fetch logic ... }
L202-210: catch (error) { ... return; }
```

しかし、リファクタリング作業中に行番号は変動するため、実装者にとって不正確な参照となる。設計書のコードリファレンスとしては、コメントタグや関数名で参照する方が堅牢である。

**Recommendation**: 「L163-210の内容」を「`ensureOpencodeConfig()` 内の `// Fetch models from Ollama API` コメントから catch ブロック末尾 (`return;`) までの既存ロジック」のような記述に変更する。

---

#### S2-002: 既存コードのOllama失敗時 early return が設計書の記述と不整合

**Category**: コード整合性
**Location**: 設計方針書 セクション2-1 現在のアーキテクチャ

設計書セクション2-1の問題点は「Ollama API 失敗時に `catch` で即 `return` するため、後続の LM Studio 処理に到達不可能」とcatchブロックのみに言及している。しかし、実際のコードにはcatch以外にも3箇所のearly returnが存在する:

| 箇所 | 行番号 | 条件 | 動作 |
|------|--------|------|------|
| 1 | L174-177 | `!response.ok` (非200応答) | `return;` |
| 2 | L181-184 | `text.length > MAX_OLLAMA_RESPONSE_SIZE` | `return;` |
| 3 | L188-191 | `!Array.isArray(data.models)` (構造不正) | `return;` |
| 4 | L202-210 | 例外発生 (catch) | `return;` |

全4箇所で `ensureOpencodeConfig()` 自体が終了するため、fetchOllamaModels() への抽出時には全てを `return {};` に変換する必要がある。設計書がcatchのみに言及していると、実装者が箇所1-3のearly returnを見落とすリスクがある。

**Recommendation**: セクション2-1の問題点を「Ollama API処理の各段階（非200応答、サイズ超過、構造不正、例外発生）のいずれでも早期returnするため」と修正する。セクション6-1に「既存の全early return（4箇所）を空オブジェクト返却に変換する」旨を明記する。

---

### Should Fix (5件)

#### S2-003: Ollama 0件取得時の動作変更が未記載

**Category**: コード整合性
**Location**: 設計方針書 セクション3 D2、セクション7-3

**現在の動作**: Ollama API成功時にバリデーション通過モデルが0件でも、空の `models: {}` を含む opencode.json が生成される。

```typescript
// 現行コード: models = {} のまま writeFileSync に到達
const models: Record<string, { name: string }> = {};
// ... (全モデルがバリデーション不合格の場合、modelsは空のまま)
const config = {
  provider: { ollama: { ... models } },  // 空modelsでもconfig生成
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), ...);
```

**新設計の動作**: `if (Object.keys(provider).length === 0) return;` により、0件時はopencode.json自体が生成されない。

この動作変更が設計書に明記されていない。既存テストに0件ケースがないため問題化しにくいが、OpenCodeの挙動に影響する可能性がある。

**Recommendation**: セクション2-1またはD2に「既存動作からの変更: Ollama API成功/モデル0件でも空modelsのopencode.jsonが生成されていたが、新設計ではプロバイダー0件の場合ファイル生成をスキップする」と明記する。

---

#### S2-004: モジュール構成図に不採用の設計選択肢が残留

**Category**: 設計書内部
**Location**: 設計方針書 セクション2-3 モジュール構成（変更後）

セクション2-3のHelpers項目:

```
├── Helpers
│   ├── formatModelDisplayName()（既存、Ollama専用）
│   ├── validateWorktreePath()（既存）
│   └── fetchWithTimeout()（新規、共通HTTPヘルパー）← 設計選択A
```

セクション3 D1で選択肢Bが採用されており、fetchWithTimeout()は導入しないことが決定済み。モジュール構成図が最終決定を反映していない。

**Recommendation**: `fetchWithTimeout()` の行を削除する。

---

#### S2-005: Issue本文のテストファイルパスが実際のパスと不一致

**Category**: Issue整合性
**Location**: Issue #398 影響範囲テーブル

| Issue記載 | 実際のパス |
|-----------|-----------|
| `tests/unit/opencode-config.test.ts` | `tests/unit/cli-tools/opencode-config.test.ts` |

`cli-tools/` ディレクトリ階層が欠落している。設計方針書にはテストファイルパスの明示的な記載がないため、設計書への影響は間接的だが、Issue記載パスに基づいて作業する実装者が混乱する可能性がある。

**Recommendation**: Issue #398の影響範囲テーブルを修正するか、設計書セクション7-1に正しいテストファイルパスを追記する。

---

#### S2-006: 既存定数テーブルにexport/非exportの区別がない

**Category**: 設計書内部
**Location**: 設計方針書 セクション4-2 既存定数テーブル

セクション4-2のテーブルにはexport定数と非export定数が区別なく同列に並んでいる:

| 定数 | 実際のexport状態 |
|------|----------------|
| `OLLAMA_API_URL` | export (`opencode-config.ts` L22) |
| `OLLAMA_BASE_URL` | export (`opencode-config.ts` L28) |
| `MAX_OLLAMA_MODELS` | export (`opencode-config.ts` L31) |
| `OLLAMA_MODEL_PATTERN` | export (`opencode-config.ts` L46) |
| `OLLAMA_API_TIMEOUT_MS` | 非export (`opencode-config.ts` L49) |
| `MAX_OLLAMA_RESPONSE_SIZE` | 非export (`opencode-config.ts` L52) |
| `CONFIG_FILE_NAME` | 非export (`opencode-config.ts` L55) |

セクション4-1では新規定数について「Internal constants (non-export)」を分離記載しているため、セクション4-2も同じ形式が望ましい。

**Recommendation**: セクション4-2にもexport/非exportの区別を追加する。

---

#### S2-010: claude-executor.ts のスコープ外記載が不完全

**Category**: コード整合性
**Location**: 設計方針書 セクション9 スコープ外の明確化

`claude-executor.ts` L110-115:

```typescript
case 'opencode':
  if (options?.model) {
    return ['run', '-m', `ollama/${options.model}`, message];
  }
  return ['run', message];
```

`ollama/` プレフィックスがハードコードされており、LM Studio モデルのスケジュール実行には不適切。設計書セクション9では「TUIモードで十分、スケジュール実行は別途」と記載しているが、具体的な制約（`ollama/` プレフィックスがLM Studioモデルに適用不可）への言及がない。

**Recommendation**: セクション9のスコープ外テーブルに「現在の `ollama/` プレフィックスはLM Studioモデルには適用できないため、プロバイダー識別子の動的切替が将来必要」と補記する。

---

### Nice to Have (4件)

#### S2-007: LM_STUDIO_MODEL_PATTERNの文字クラスに@が含まれる理由が未記載

**Location**: 設計方針書 セクション4-1

設計書の `LM_STUDIO_MODEL_PATTERN = /^[a-zA-Z0-9._:/@-]{1,200}$/` には `@` が含まれるが、`OLLAMA_MODEL_PATTERN = /^[a-zA-Z0-9._:/-]{1,100}$/` には `@` がない。パターンの差異が意図的であることの根拠が記載されていない。

---

#### S2-008: テストケース数の見積もり差異

**Location**: 設計方針書 セクション7-1

設計書では fetchOllamaModels() テスト「8件」としているが、既存テストから移行すべきケースをカウントすると9件（正常取得、タイムアウト、ネットワーク失敗、非200応答、サイズ超過、構造不正、モデル数上限、名前バリデーション、表示名フォーマット）となる。テスト移行マッピングの明示を推奨。

---

#### S2-009: opencode.json の provider 構造変更によるOpenCode側の動作影響

**Location**: 設計方針書 セクション3 D2

動的プロバイダー構成への変更により、providerキーが可変になる。OpenCode が provider キーの不在をどう扱うか（エラー/フォールバック）の確認が設計書に記載されていない。

---

#### S2-011: S1-005のスキップとS1-001対応の関係が不明確

**Location**: 設計方針書 セクション12

S1-005（TODOコメント記載）はNice to Haveとしてスキップされたが、同一内容がS1-001の実装チェックリスト項目に包含されている。この関係が不明確。

---

## Consistency Check Matrix

### 設計書 vs 既存コード

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| OLLAMA_API_URL | `http://localhost:11434/api/tags` | L22: 同一 | なし |
| OLLAMA_BASE_URL | `http://localhost:11434/v1` | L28: 同一 | なし |
| MAX_OLLAMA_MODELS | 100 | L31: 同一 | なし |
| OLLAMA_MODEL_PATTERN | `/^[a-zA-Z0-9._:/-]{1,100}$/` | L46: 同一 | なし |
| OLLAMA_API_TIMEOUT_MS | 3000 | L49: 同一 | なし |
| MAX_OLLAMA_RESPONSE_SIZE | 1MB | L52: 同一 | なし |
| CONFIG_FILE_NAME | `opencode.json` | L55: 同一 | なし |
| validateWorktreePath() | 3層防御 | L117-138: 同一 | なし |
| formatModelDisplayName() | Ollama専用 | L80-98: 同一 | なし |
| ensureOpencodeConfig() | async/Promise<void> | L152: 同一 | なし |
| 失敗時の挙動 | 空オブジェクト返却 | L176,183,189,209: early return | **差異あり (S2-002)** |
| 0件時の挙動 | opencode.jsonスキップ | 0件でもopencode.json生成 | **差異あり (S2-003)** |

### 設計書内部整合性

| セクション間 | 整合状況 | 備考 |
|------------|---------|------|
| セクション2-3 vs セクション3 D1 | **不整合 (S2-004)** | モジュール構成に不採用のfetchWithTimeout()が残留 |
| セクション6-3 vs セクション8-1 | 整合 | Stage 1のS1-008反映済み（Promise.all統一） |
| セクション3 D1 vs セクション13 チェックリスト | 整合 | S1-001のTODOコメント記載が含まれる |
| セクション3 D2 vs セクション6-3 | 整合 | 0件スキップロジック一致 |
| セクション4-1 vs セクション5 | 整合 | SEC定数が対応 |

### Issue vs 設計書

| Issue要件 | 設計書カバー | 備考 |
|-----------|------------|------|
| LM Studio API モデル取得 | カバー済み (セクション6-2) | |
| opencode.json に lmstudio 反映 | カバー済み (セクション6-3) | |
| LM Studio 未起動時の非致命的動作 | カバー済み (セクション6-2) | |
| Ollama 未起動時の非致命的動作 | カバー済み (セクション6-1) | |
| 両方未起動時の非致命的動作 | カバー済み (セクション6-3) | |
| SEC-001 SSRF防止 | カバー済み (セクション5) | |
| DoS防御 | カバー済み (セクション5) | |
| ユニットテスト | カバー済み (セクション7-2) | テストファイルパス不正確 (S2-005) |
| 結合テスト | カバー済み (セクション7-3) | |
| 既存動作への影響なし | **部分的** | 0件時の動作変更が未記載 (S2-003) |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | early return見落としによる部分的リファクタリング | Medium | Medium | P1 |
| 技術的リスク | 0件時の動作変更による予期せぬ影響 | Low | Low | P2 |
| 運用リスク | テストケース移行漏れ | Low | Medium | P2 |
| セキュリティ | (指摘なし: SEC-001/002/003/004は既存ポリシーと完全一致) | Low | Low | - |

---

## Reviewed Files

| ファイル | 役割 |
|---------|------|
| `dev-reports/design/issue-398-lmstudio-opencode-design-policy.md` | 設計方針書（レビュー対象） |
| `src/lib/cli-tools/opencode-config.ts` | 現在の実装（変更対象） |
| `src/lib/cli-tools/opencode.ts` | 呼び出し元 |
| `src/lib/cli-tools/types.ts` | CLI型定義 |
| `src/lib/claude-executor.ts` | opencode buildCliArgs |
| `tests/unit/cli-tools/opencode-config.test.ts` | 既存テスト |
| `src/app/api/ollama/models/route.ts` | Ollama API定数の重複確認 |
| `dev-reports/issue/398/multi-stage-design-review/stage1-review-result.json` | Stage 1レビュー結果 |
| `dev-reports/issue/398/issue-review/original-issue.json` | Issue原文 |

---

## Approval

**Status**: Conditionally Approved

Must Fix 2件（S2-001/S2-002）の修正後に承認可能。いずれも設計書の記述補足であり、設計の方向性自体は正しい。実装に着手する前にこれらを反映することで、リファクタリング漏れリスクを低減できる。

---

*Generated by architecture-review-agent for Issue #398 Stage 2*
*Date: 2026-03-02*
