# Issue #193 仮説検証レポート

## 検証日時
- 2026-02-08

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `prompt-detector.ts`の`detectMultipleChoicePrompt()`がClaude CLI固有の`❯`(U+276F)マーカーのみに対応 | Confirmed | Pass 1で`DEFAULT_OPTION_PATTERN`(❯ U+276F)の存在チェックを行い、なければ即`isPrompt: false`を返す |
| 2 | `cli-patterns.ts`にCodex固有の選択肢パターンが未定義 | Confirmed | `cli-patterns.ts`にCodex選択肢関連パターンは存在しない |
| 3 | `prompt-response/route.ts`の`detectPrompt()`がCodex形式を認識できず送信を拒否 | Confirmed | L75で`detectPrompt(cleanOutput)`を呼び出し、L77-83で`isPrompt: false`時に`prompt_no_longer_active`を返す |

## 詳細検証

### 仮説 1: `detectMultipleChoicePrompt()`がClaude CLI固有の❯マーカーのみに対応

**Issue内の記述**: `detectMultipleChoicePrompt()`内の2パス❯検出方式がClaude CLI専用の`❯`(U+276F)マーカーに依存

**検証手順**:
1. `src/lib/prompt-detector.ts`の`detectMultipleChoicePrompt()`関数を確認
2. Pass 1 (L274-281): `DEFAULT_OPTION_PATTERN` (`/^\s*\u276F\s*(\d+)\.\s*(.+)$/`) で❯の存在チェック
3. `hasDefaultLine`が`false`の場合、L283-288で即座に`isPrompt: false`を返す

**判定**: **Confirmed**

**根拠**: `prompt-detector.ts:274-288` — Pass 1で❯(U+276F)の存在を前提としており、Codex CLIが異なる選択肢マーカーを使用する場合、Pass 1の時点で検出に失敗する。

### 仮説 2: `cli-patterns.ts`にCodex固有の選択肢パターンが未定義

**Issue内の記述**: Codex固有の選択肢パターンが未定義

**検証手順**:
1. `src/lib/cli-patterns.ts`全体を確認
2. Codex関連パターン: `CODEX_THINKING_PATTERN`, `CODEX_PROMPT_PATTERN`, `CODEX_SEPARATOR_PATTERN` のみ存在
3. 選択肢（multiple choice）に関するCodexパターンは存在しない

**判定**: **Confirmed**

**根拠**: `cli-patterns.ts`にはCodexのthinking/prompt/separatorパターンのみ定義されており、選択肢表示に関するパターンは一切ない。

### 仮説 3: `prompt-response/route.ts`が送信を拒否

**Issue内の記述**: `detectPrompt()`がCodex形式を認識できず、送信を拒否する

**検証手順**:
1. `src/app/api/worktrees/[id]/prompt-response/route.ts`のL68-87を確認
2. L75: `detectPrompt(cleanOutput)` — CLIツール種別を考慮せず一律で`detectPrompt()`を呼び出す
3. L77-83: `promptCheck.isPrompt`が`false`の場合、`prompt_no_longer_active`として応答

**判定**: **Confirmed**

**根拠**: `prompt-response/route.ts:50`でcliToolIdを取得しているにもかかわらず、L75の`detectPrompt()`呼び出しにcliToolIdを渡しておらず、CLIツール別のプロンプト検出ができていない。これが直接的な原因で、Codex CLIの選択肢プロンプトに対して「プロンプトがアクティブでない」と誤判定される。

**Issueへの影響**: Issue記載の分析は正確。追加の指摘として、`prompt-response/route.ts`が`cliToolId`を`detectPrompt()`に渡していない設計上の問題がある。

---

## Stage 1レビューへの申し送り事項

- 全仮説がConfirmedのため、Issue記載の根本原因分析は正確
- 追加確認ポイント: `detectPrompt()`がCLIツール種別を引数として受け取る設計変更が必要かどうか
- `auto-yes-manager.ts`内の`detectPrompt()`呼び出しも同様にCLIツール種別を考慮していない可能性がある
- Codex CLIの実際の選択肢出力形式（スクリーンショットから推測する必要がある）の正確な把握が重要
