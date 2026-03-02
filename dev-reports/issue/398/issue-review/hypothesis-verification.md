# Issue #398 仮説検証レポート

## 検証日時
- 2026-03-02

## 概要

Issue #398 は機能追加Issueです。バグ原因分析や推測を含む「仮説」は存在しませんが、
現状の実装に関する事実的な主張が含まれているため、コードベースと照合します。

## 検証結果サマリー

| # | 主張 | 判定 | 根拠 |
|---|------|------|------|
| 1 | OpenCodeのモデル選択はOllama（`localhost:11434/api/tags`）からのみモデルを取得している | Confirmed | `opencode-config.ts` L22: `OLLAMA_API_URL = 'http://localhost:11434/api/tags'`、単一APIのみ呼び出し |
| 2 | LM Studioを利用するユーザーはOpenCode連携でモデルを使用できない | Confirmed | `ensureOpencodeConfig()`にLM Studio APIへのアクセス処理が存在しない |
| 3 | 既存OllamaのDoS防御：レスポンスサイズ上限1MB・モデル数上限100件 | Confirmed | `MAX_OLLAMA_RESPONSE_SIZE = 1MB`, `MAX_OLLAMA_MODELS = 100` |

## 詳細検証

### 主張 1: Ollamaのみモデル取得

**Issue内の記述**: 「現在、OpenCodeのモデル選択はOllama（`localhost:11434/api/tags`）からのみモデルを取得している」

**検証手順**:
1. `src/lib/cli-tools/opencode-config.ts` を確認
2. `ensureOpencodeConfig()` 内のAPI呼び出しを確認

**判定**: Confirmed

**根拠**:
- L22: `export const OLLAMA_API_URL = 'http://localhost:11434/api/tags' as const;`
- L168: `const response = await fetch(OLLAMA_API_URL, { signal: controller.signal });`
- LM Studio APIへのアクセスは存在しない

---

### 主張 2: LM Studioユーザーは利用不可

**Issue内の記述**: 「LM Studioを利用するユーザーはOpenCode連携でモデルを使用できない」

**判定**: Confirmed

**根拠**:
- `opencode-config.ts` にLM Studio APIの呼び出しなし
- `opencode.json` の生成テンプレート（L215-225）は `ollama` プロバイダーセクションのみ
- 既存テストもOllama専用（`opencode-config.test.ts` 全298行）

---

### 主張 3: 既存DoS防御の仕様

**Issue内の記述**: 「レスポンスサイズ制限・モデル数制限のDoS防御（既存のOllamaと同等）」

**判定**: Confirmed

**根拠**:
- L52: `MAX_OLLAMA_RESPONSE_SIZE = 1 * 1024 * 1024` (1MB)
- L31: `MAX_OLLAMA_MODELS = 100`
- LM Studio実装も同等のDoS防御が必要

---

## Stage 1レビューへの申し送り事項

- 全主張がConfirmedのため、Issue記載の前提条件に誤りはない
- LM Studio OpenAI互換APIのレスポンス形式（`/v1/models`）の仕様確認が必要
  - OpenAI標準: `{ data: [{ id: string, ... }] }` 形式
  - Ollamaとは異なるため、別途パーサーが必要
- `opencode.json` の `lmstudio` プロバイダーセクションの正確なスキーマ確認が必要
  - OpenCode公式ドキュメントまたはスキーマファイルで確認すべき
- 既存 `opencode.json` が存在する場合は更新しない（既存ユーザー設定尊重）という制約は維持すべき
