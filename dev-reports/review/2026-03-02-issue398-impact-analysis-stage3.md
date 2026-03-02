# Architecture Review: Issue #398 - Stage 3 影響分析レビュー

**Issue**: #398 LM Studio モデル選択対応
**Focus**: 影響範囲（Impact Scope）
**Stage**: 3（影響分析レビュー）
**Date**: 2026-03-02
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

設計方針書のスコープ設定は適切であり、変更の影響範囲は `opencode-config.ts` 内部に十分に局所化されている。`ensureOpencodeConfig()` の関数シグネチャ `(worktreePath: string) => Promise<void>` が不変であるため、呼び出し元である `opencode.ts`、および間接的に関連する `schedule-manager.ts`、`claude-executor.ts` への直接的な破壊的変更は発生しない。

主要な改善ポイントは以下の4点である:
1. 既存テスト移行の影響見積もり不足（must_fix 1件）
2. `schedule-manager.ts` の opencode モデル選択パスの考慮不足
3. 既存 `opencode.json` ユーザーへの移行パス記載不足
4. `claude-executor.ts` の `ollama/` プレフィックス問題の具体性不足

---

## 影響範囲マトリクス

### 直接変更ファイル

| ファイル | 変更内容 | リスク |
|---------|---------|-------|
| `src/lib/cli-tools/opencode-config.ts` | fetchOllamaModels()/fetchLmStudioModels() 独立関数化、ensureOpencodeConfig() リファクタリング、LM Studio 定数/型追加 | **中**: 既存ロジック抽出のため回帰リスクあり |
| `tests/unit/cli-tools/opencode-config.test.ts` | 既存テスト分割移行 + LM Studio テスト追加、mockFetch URL分岐化 | **中**: 13件のテストケースの期待値が変更される |
| `CLAUDE.md` | opencode-config.ts モジュール説明更新 | **低**: ドキュメントのみ |

### 間接影響ファイル（変更不要だが確認が必要）

| ファイル | 関連箇所 | 影響度 | 根拠 |
|---------|---------|--------|------|
| `src/lib/cli-tools/opencode.ts` | L99: `ensureOpencodeConfig(worktreePath)` 呼び出し | **なし** | シグネチャ不変。実行時間が最大3秒増加するが OPENCODE_INIT_WAIT_MS(15s) 内 |
| `tests/unit/cli-tools/opencode.test.ts` | L19-21: `vi.mock('@/lib/cli-tools/opencode-config')` | **なし** | ensureOpencodeConfig のみ mock。新規 export は opencode.ts で import されない |
| `src/lib/claude-executor.ts` | L110-115: `ollama/${options.model}` ハードコード | **スコープ外** | LM Studio モデルにはマッチしない。将来 Issue で対応 |
| `src/lib/schedule-manager.ts` | L328-331: options 構築が vibe-local 専用 | **スコープ外** | opencode の model 選択パスが未実装。将来 Issue で対応 |
| `src/app/api/ollama/models/route.ts` | L14: 独自の OLLAMA_API_URL 定数 | **なし** | SEC-001 による意図的な分離。opencode-config.ts とは独立 |
| `src/lib/cli-tools/types.ts` | L183: OLLAMA_MODEL_PATTERN（API/DB層用） | **なし** | opencode-config.ts の同名定数とは独立（用途/パターンが異なる） |
| `src/lib/cli-tools/vibe-local.ts` | L94: types.ts の OLLAMA_MODEL_PATTERN を使用 | **なし** | opencode-config.ts の変更の影響なし |
| `tests/unit/lib/claude-executor.test.ts` | L143-156: opencode buildCliArgs テスト | **なし** | claude-executor.ts はスコープ外のため変更なし |

---

## Detailed Findings

### S3-001 [Should Fix] schedule-manager.ts の opencode スケジュール実行で model オプション未対応

**カテゴリ**: 直接影響
**場所**: 設計方針書 セクション9

`schedule-manager.ts` L318-339 では、`cliToolId === 'vibe-local'` の場合のみ `worktree.vibe_local_model` を取得して `options.model` に渡している。opencode の場合は `options` が `undefined` のままとなる。

```typescript
// schedule-manager.ts L327-331 (現在のコード)
const options: ExecuteCommandOptions | undefined =
  state.entry.cliToolId === 'vibe-local' && worktree.vibe_local_model
    ? { model: worktree.vibe_local_model }
    : undefined;
```

設計書セクション9で `schedule-manager.ts` をスコープ外としているが、この具体的な制限（DB スキーマに opencode_model カラムが存在しないこと、options 構築が vibe-local 限定であること）を明記すべき。

**推奨**: セクション9のスコープ外テーブルに `schedule-manager.ts` の具体的な制約を追記する。

---

### S3-002 [Should Fix] 既存 opencode.json ユーザーへの移行パス未記載

**カテゴリ**: 後方互換性
**場所**: 設計方針書 セクション3 D2 および セクション9

`ensureOpencodeConfig()` は `existsSync()` で opencode.json の存在をチェックし、存在すれば何もしない。これは設計書でも維持されている。しかし、以下のシナリオが未記載:

1. Ollama のみで生成された既存 `opencode.json` を持つユーザーが LM Studio を後から導入した場合 -- LM Studio モデルは自動追加されない
2. ユーザーが `opencode.json` を手動削除して再生成する必要がある

**推奨**: 後方互換性と移行パスを設計書に追記する。

---

### S3-003 [Must Fix] 既存テスト移行の影響見積もりが不足

**カテゴリ**: テスト影響
**場所**: 設計方針書 セクション7

既存テスト (`opencode-config.test.ts` 298行) の主要な影響ポイント:

**1. mockFetch の URL 分岐化**
現在の mockFetch は単一のグローバル fetch モックだが、リファクタリング後は fetchOllamaModels() と fetchLmStudioModels() が Promise.all で並列呼び出しされるため、URL ベースの分岐が必要。設計書セクション7-4 にサンプルコードはあるが、既存テストへの適用方法が不明確。

**2. 動作変更によるテスト期待値の変化**
以下の既存テスト群は、Ollama API 失敗時に `writeFileSync` が呼ばれないことを検証している:

| テストケース (行番号) | 現在の期待値 | リファクタリング後の期待値 |
|---|---|---|
| L135-143: Ollama API タイムアウト | `writeFileSync` 未呼出 | LM Studio も失敗する mock が必要 |
| L145-149: Ollama API ネットワーク障害 | `writeFileSync` 未呼出 | 同上 |
| L152-159: 非200レスポンス | `writeFileSync` 未呼出 | 同上 |
| L162-171: レスポンスサイズ超過 | `writeFileSync` 未呼出 | 同上 |
| L173-181: 不正レスポンス構造 | `writeFileSync` 未呼出 | 同上 |

これらのテストは `ensureOpencodeConfig()` の統合テストとして書かれており、fetchOllamaModels() 個別テストに移行する必要がある。

**3. テスト分割の対応表が必要**
設計書セクション7-1 で「fetchOllamaModels(): 8件」「fetchLmStudioModels(): 8件」「ensureOpencodeConfig(): 8件」と概算しているが、既存テスト13件からの移行対応表が示されていない。

**推奨**: セクション7に既存テスト移行の対応表を追加し、各テストが移行先のどの関数テストに対応するかを明示する。

---

### S3-004 [Nice to Have] /api/ollama/models/route.ts の OLLAMA_API_URL 重複は意図的分離

**カテゴリ**: 直接影響
**場所**: 設計方針書 セクション9

`src/app/api/ollama/models/route.ts` L14 にも `OLLAMA_API_URL = 'http://localhost:11434/api/tags'` がローカル定数として定義されている。SEC-001 SSRF 防止ポリシーにより各モジュールでのハードコードが正当化される。将来 `/api/lmstudio/models` エンドポイント追加時にも同様のパターンを踏襲する必要がある。

---

### S3-005 [Nice to Have] startSession() 全体のタイムライン概算

**カテゴリ**: 間接影響
**場所**: 設計方針書 セクション8

`ensureOpencodeConfig()` の最悪実行時間は max(3s, 3s) = 3s。`startSession()` 全体の概算:

```
validatePath (~0ms) + ensureOpencodeConfig (max 3s) + createSession (~100ms)
+ resize (~100ms) + sendKeys (~0ms) + INIT_WAIT (15s) = max ~18.2s
```

ユーザー体感への影響は INIT_WAIT に隠蔽されるため実質的に無視できる。設計書にタイムライン概算を追記するとよい。

---

### S3-006 [Should Fix] claude-executor.ts の ollama/ プレフィックス問題の具体性不足

**カテゴリ**: スコープ
**場所**: 設計方針書 セクション9

`claude-executor.ts` L113 のコード:

```typescript
case 'opencode':
  if (options?.model) {
    return ['run', '-m', `ollama/${options.model}`, message];
  }
  return ['run', message];
```

LM Studio モデル ID（例: `lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF`）に `ollama/` プレフィックスが付加されると `ollama/lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF` となり、OpenCode が認識できない。設計書にはこの具体的な失敗シナリオの記載が不足している。

**推奨**: セクション9に具体的な失敗シナリオ、失敗時の挙動、将来 Issue の優先度を追記する。

---

### S3-007 [Nice to Have] 0件時動作変更の後方互換性影響

**カテゴリ**: 後方互換性
**場所**: 設計方針書 セクション3 D2

Ollama API 成功/モデル0件時に `opencode.json` が生成されなくなる動作変更は、実質的に改善である。OpenCode TUI は `opencode.json` 不在時にデフォルト設定で起動するため、空 models の config が存在する場合よりも望ましい動作となる。

---

### S3-008 [Should Fix] opencode.test.ts への影響ゼロの確認記録

**カテゴリ**: テスト影響
**場所**: 設計方針書 セクション7

`opencode.test.ts` L19-21:

```typescript
vi.mock('@/lib/cli-tools/opencode-config', () => ({
  ensureOpencodeConfig: vi.fn(),
}));
```

新規 export（LM_STUDIO_API_URL 等）は `opencode.ts` で import されないため、この mock 定義は変更不要。設計書にこの確認結果を明記しておくと実装者が安心できる。

---

### S3-009 [Nice to Have] LM_STUDIO_MODEL_PATTERN の @ 文字許可の根拠

**カテゴリ**: 直接影響
**場所**: 設計方針書 セクション4-1

`LM_STUDIO_MODEL_PATTERN = /^[a-zA-Z0-9._:/@-]{1,200}$/` は Ollama パターンと比較して `@` が追加、長さ上限が 200 に拡張されている。HuggingFace のモデル ID 形式（`org/model@revision`）への対応と推測されるが、設計書に根拠が記載されていない。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 既存テスト移行時の期待値変更漏れ | Low | Medium | P2 |
| 技術的リスク | mockFetch URL 分岐の実装ミス | Low | Low | P3 |
| 運用リスク | 既存 opencode.json ユーザーが LM Studio モデルを利用できない | Medium | Medium | P2 |
| 運用リスク | スケジュール実行で LM Studio モデルが使用不可 | Medium | Low | P3 |
| セキュリティリスク | なし（SEC-001/SEC-002/SEC-003/SEC-004 全て維持） | Low | Low | - |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix) - 1件

| ID | タイトル | 推奨対応 |
|----|---------|---------|
| S3-003 | 既存テスト移行の影響見積もり不足 | セクション7に既存テスト13件の移行対応表を追加 |

### 推奨改善項目 (Should Fix) - 4件

| ID | タイトル | 推奨対応 |
|----|---------|---------|
| S3-001 | schedule-manager.ts の opencode model 未対応 | セクション9に具体的な制約を追記 |
| S3-002 | 既存 opencode.json ユーザーの移行パス | 後方互換性サブセクション追加 |
| S3-006 | claude-executor.ts ollama/ プレフィックス問題の具体性 | セクション9に失敗シナリオを追記 |
| S3-008 | opencode.test.ts 影響ゼロの確認記録 | セクション7に1行追加 |

### 検討事項 (Nice to Have) - 4件

| ID | タイトル |
|----|---------|
| S3-004 | /api/ollama/models/route.ts の OLLAMA_API_URL 重複への注記 |
| S3-005 | startSession() 全体のタイムライン概算 |
| S3-007 | 0件時動作変更の後方互換性補足 |
| S3-009 | LM_STUDIO_MODEL_PATTERN の @ 文字許可根拠 |

---

## Reviewed Files

- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/dev-reports/design/issue-398-lmstudio-opencode-design-policy.md`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/lib/cli-tools/opencode-config.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/lib/cli-tools/opencode.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/lib/claude-executor.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/lib/schedule-manager.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/app/api/ollama/models/route.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/src/lib/cli-tools/types.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/tests/unit/cli-tools/opencode-config.test.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/tests/unit/cli-tools/opencode.test.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/tests/unit/lib/claude-executor.test.ts`

---

*Generated by architecture-review-agent for Issue #398 Stage 3*
*Date: 2026-03-02*
