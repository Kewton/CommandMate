# Issue #398 レビューレポート

**レビュー日**: 2026-03-02
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目
**ステージ**: Stage 1

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 4 |
| Should Fix | 5 |
| Nice to Have | 3 |

**総評**: Issueの目的と背景は明確で、受入条件も基本的な網羅性がある。しかし、既存コードの制御フロー（Ollama失敗時の早期リターン）との整合性に重大な設計問題があり、そのままでは受入条件「Ollama未起動時にLM Studioのみで動作」を満たせない。また、LM Studio API（OpenAI互換）のレスポンス形式がOllamaと異なる点、`opencode.json`のlmstudioプロバイダースキーマ、`claude-executor.ts`への影響が未考慮である。これらの技術的詳細を実装タスクに反映することで、実装時の手戻りを防止できる。

---

## Must Fix（必須対応）

### MF-001: Ollama API失敗時の早期リターンによりLM Studioモデルが無視される設計問題

**カテゴリ**: 正確性
**場所**: Issue本文 > 実装タスク セクション / `src/lib/cli-tools/opencode-config.ts` L152-239

**問題**:
現在の `ensureOpencodeConfig()` はOllama API の呼び出しが失敗（タイムアウト、接続拒否、非200レスポンス等）した場合、L202-210の`catch`ブロックで`return`して即座に終了する。この設計のままLM Studio APIを追加すると、Ollamaが未起動の場合にLM Studioのモデル取得処理に到達できない。

```typescript
// opencode-config.ts L202-209（現在の実装）
} catch (error) {
  // Non-fatal: Ollama may not be running [D4-002]
  if (error instanceof Error && error.name === 'AbortError') {
    console.warn('Ollama API timeout, skipping opencode.json generation');
  } else {
    console.warn('Failed to fetch Ollama models, skipping opencode.json generation');
  }
  return; // <-- ここでLM Studio処理に到達せず終了
}
```

受入条件「Ollamaが未起動の場合、エラーにならずLM Studioのみで動作すること」を満たすには、制御フローの根本的なリファクタリングが必要。

**推奨対応**:
`ensureOpencodeConfig()`を以下のように再設計する:
1. `fetchOllamaModels()` と `fetchLmStudioModels()` を独立した関数として実装。各関数は失敗時に空の`Record`を返す。
2. 両関数の結果をマージした上で`opencode.json`を生成する。
3. 両方のモデルが0件の場合のみスキップする（または空のプロバイダーで生成する）。

Issue本文にこの制御フロー変更の設計を明記すべき。

---

### MF-002: LM Studio API レスポンス形式とOllama API レスポンス形式の違いが未明記

**カテゴリ**: 正確性
**場所**: Issue本文 > 実装タスク セクション

**問題**:
Ollama APIとLM Studio API（OpenAI互換）ではレスポンス形式が根本的に異なる:

| 項目 | Ollama API | LM Studio API (OpenAI互換) |
|------|-----------|--------------------------|
| エンドポイント | `localhost:11434/api/tags` | `localhost:1234/v1/models` |
| レスポンス構造 | `{ models: [...] }` | `{ data: [...] }` |
| モデル識別子 | `name` フィールド | `id` フィールド |
| 詳細情報 | `details.parameter_size`, `details.quantization_level` | 標準では提供なし |

Issue本文ではこの違いが明記されておらず、`fetchLmStudioModels()`に別途パーサーが必要であることが実装タスクから読み取れない。

**推奨対応**:
実装タスクに以下を追加: 「`fetchLmStudioModels()`ではOpenAI互換APIのレスポンス形式 `{ data: [{ id: string }] }` をパースする。モデル表示名はIDそのまま（`details`情報が取得できないため）」

---

### MF-003: opencode.json の lmstudio プロバイダーセクションの正確なスキーマが未定義

**カテゴリ**: 正確性
**場所**: Issue本文 > 実装タスク セクション

**問題**:
「opencode.json生成テンプレートに`lmstudio`プロバイダーセクションを追加」とあるが、具体的なスキーマが定義されていない。

現在のOllamaプロバイダー構造:
```json
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": { "modelName": { "name": "displayName" } }
    }
  }
}
```

LM Studioプロバイダーの`npm`パッケージ、`name`、`options.baseURL`、`models`の形式が不明。OpenCodeのconfigスキーマ（`https://opencode.ai/config.json`）を参照して正確な定義が必要。

**推奨対応**:
想定構造を実装タスクに追記:
```json
{
  "provider": {
    "ollama": { ... },
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio (local)",
      "options": { "baseURL": "http://localhost:1234/v1" },
      "models": { "modelId": { "name": "modelId" } }
    }
  }
}
```
OpenCode公式ドキュメントまたは実際の動作確認で検証すること。

---

### MF-004: claude-executor.ts の buildCliArgs() における LM Studio モデルのプレフィックス未考慮

**カテゴリ**: 整合性
**場所**: Issue本文 > 影響範囲 セクション / `src/lib/claude-executor.ts` L110-115

**問題**:
`claude-executor.ts`の`buildCliArgs()`ではOpenCodeのモデル指定時に`ollama/`プレフィックスをハードコードしている:

```typescript
// claude-executor.ts L110-115
case 'opencode':
  if (options?.model) {
    return ['run', '-m', `ollama/${options.model}`, message];
  }
  return ['run', message];
```

LM Studioモデルが追加された場合、スケジュール実行（非TUIモード）時に`lmstudio/`プレフィックスでモデルを指定する必要があるが、この変更がIssueの影響範囲テーブルに含まれていない。

**推奨対応**:
以下のいずれかを選択し、Issue本文に明記する:
- (A) 影響範囲に`claude-executor.ts`を追加し、`buildCliArgs()`でモデルプロバイダーに応じたプレフィックスを動的に設定する
- (B) LM StudioモデルはTUIモード（opencode.jsonのモデル選択）でのみ利用可能とし、スケジュール実行はスコープ外と明記する

---

## Should Fix（推奨対応）

### SF-001: テストファイルパスの誤記

**カテゴリ**: 完全性
**場所**: Issue本文 > 影響範囲 > 変更対象ファイル テーブル

**問題**:
テストファイルパスが `tests/unit/opencode-config.test.ts` と記載されているが、正しくは `tests/unit/cli-tools/opencode-config.test.ts`。`cli-tools/` ディレクトリが欠落。

**証拠**:
実際のファイルパス: `/Users/maenokota/share/work/github_kewton/commandmate-issue-398/tests/unit/cli-tools/opencode-config.test.ts`

**推奨対応**:
パスを `tests/unit/cli-tools/opencode-config.test.ts` に修正する。

---

### SF-002: LM Studio API の定数名とSSRF防止ポリシーの具体化

**カテゴリ**: 完全性
**場所**: Issue本文 > 実装タスク > SEC-001

**問題**:
「LM Studio APIのURLをハードコード定数として定義」のタスクはあるが、具体的な定数名と値が未定義。Ollamaでは2つの定数（`OLLAMA_API_URL`/`OLLAMA_BASE_URL`）がある。

**推奨対応**:
以下の定数を定義することを明記:
- `LM_STUDIO_API_URL = 'http://localhost:1234/v1/models' as const`
- `LM_STUDIO_BASE_URL = 'http://localhost:1234/v1' as const`

---

### SF-003: LM Studio モデル名のバリデーションパターン未定義

**カテゴリ**: 完全性
**場所**: Issue本文 > 実装タスク

**問題**:
Ollamaでは`OLLAMA_MODEL_PATTERN`（`/^[a-zA-Z0-9._:/-]{1,100}$/`）でモデル名をバリデーションしている。LM Studioモデルはパス形式を含む可能性がある（例: `lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf`）。`.gguf`拡張子やスラッシュ区切りの長い名前を許容する必要がある。

**推奨対応**:
LM Studio用のバリデーションパターン定数（`LM_STUDIO_MODEL_PATTERN`）を定義するタスクを追加する。

---

### SF-004: 両プロバイダーのモデルが0件の場合の振る舞いが未定義

**カテゴリ**: 明確性
**場所**: Issue本文 > 受入条件 セクション

**問題**:
受入条件「両方未起動の場合も、致命的エラーにならないこと」は記載されているが、`opencode.json`を生成するのかスキップするのかが不明。

**推奨対応**:
受入条件を追加: 「OllamaとLM Studioの両方が未起動の場合、opencode.jsonは生成しない」等の明確な定義。

---

### SF-005: LM Studio API のDoS防御定数が未具体化

**カテゴリ**: 完全性
**場所**: Issue本文 > 実装タスク > DoS防御

**問題**:
「既存のOllamaと同等」とのみ記載されており、具体値が不明。

**推奨対応**:
`LM_STUDIO_API_TIMEOUT_MS=3000`、`MAX_LM_STUDIO_RESPONSE_SIZE=1MB`、`MAX_LM_STUDIO_MODELS=100`を明記。または共通定数化を検討。

---

## Nice to Have（あれば良い）

### NTH-001: 関連Issue #379 へのリンク未記載

**カテゴリ**: 完全性
**場所**: Issue本文 > 背景・課題 セクション

OpenCode初期実装のIssue #379へのリンクを追加すると背景理解が容易になる。

---

### NTH-002: CLAUDE.mdモジュール一覧の更新タスク未記載

**カテゴリ**: 完全性
**場所**: Issue本文 > 影響範囲

CLAUDE.mdの`opencode-config.ts`エントリは「Ollama API/api/tagsからモデル取得」のみ記載。LM Studio対応後はこの説明の更新が必要。

---

### NTH-003: 将来的なプロバイダー拡張を見据えた汎用設計の提案

**カテゴリ**: 技術的妥当性
**場所**: Issue本文 > 提案する解決策

Ollama、LM Studioと個別にモデル取得関数を追加する設計は、今後プロバイダーが増えた場合にスケールしにくい。共通のProviderConfigインターフェースを定義する汎用設計も検討に値する。今回のスコープでは必須ではないが、共通化できるヘルパー関数の抽出を検討する旨を記載すると保守性が向上する。

---

## 参照ファイル

### コード

| ファイル | 関連性 | 該当行 |
|---------|--------|--------|
| `src/lib/cli-tools/opencode-config.ts` | 主要変更対象。Ollama失敗時の早期リターンが新設計との整合性問題 | L152-239 |
| `src/lib/claude-executor.ts` | `buildCliArgs()`で`ollama/`プレフィックスがハードコード | L110-115 |
| `tests/unit/cli-tools/opencode-config.test.ts` | 既存テスト298行。LM Studio関連テスト追加が必要 | 全体 |
| `src/lib/cli-tools/opencode.ts` | `startSession()`から`ensureOpencodeConfig()`呼び出し | L99 |
| `src/lib/cli-tools/types.ts` | CLIツール型定義。変更不要 | 全体 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | `opencode-config.ts`のモジュール説明更新が必要 |
