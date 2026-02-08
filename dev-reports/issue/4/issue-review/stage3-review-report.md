# Issue #4 影響範囲レビュー報告書

## 概要

- **Issue番号**: #4
- **タイトル**: codex対応
- **レビュー段階**: Stage 3（影響範囲レビュー 1回目）
- **レビュー日**: 2026-02-04

## レビュー結果サマリー

| 区分 | 件数 |
|------|------|
| 必須対応（Must Fix） | 2件 |
| 推奨対応（Should Fix） | 4件 |
| 改善提案（Nice to Have） | 3件 |

---

## 必須対応事項（Must Fix）

### IS-MF-001: prompt-detector.tsの影響範囲漏れ

**問題**:
Issue内の影響範囲リストに`src/lib/prompt-detector.ts`が含まれていない。Codexプロンプトパターン検出は`cli-patterns.ts`で定義されているが、`prompt-detector.ts`の`detectPrompt()`関数はClaude専用のパターン（y/n、yes/no、Approve?、multiple_choice）を前提としている。

**現状のコード** (`src/lib/prompt-detector.ts`):
```typescript
// Pattern 1: (y/n)
const yesNoPattern = /^(.+)\s+\(y\/n\)\s*$/m;

// Pattern 5: Approve?
const approvePattern = /^(.*?)Approve\?\s*$/m;
```

これらのパターンはClaude CLI固有であり、Codex CLIが異なるプロンプト形式を使用する場合は対応が必要。

**推奨対応**:
- 影響ファイルリストに`src/lib/prompt-detector.ts`を追加
- Codexプロンプト形式の調査と対応を技術スコープに含める

---

### IS-MF-002: E2Eテストの影響範囲漏れ

**問題**:
E2Eテスト`tests/e2e/cli-tool-selection.spec.ts`がIssue #33でCodex/Geminiタブ非表示に対応済みだが、Codex有効化後のテスト更新が影響範囲に含まれていない。

**現状のテストコード**:
```typescript
// Verify Codex and Gemini badges are NOT displayed
const codexBadge = firstCard.getByText('Codex', { exact: true });
const geminiBadge = firstCard.getByText('Gemini', { exact: true });
expect(await codexBadge.count()).toBe(0);
expect(await geminiBadge.count()).toBe(0);
```

Codex有効化後、このテストは失敗する。

**推奨対応**:
- 影響ファイルリストにE2Eテストファイルを追加
- Codex有効化後のテストシナリオ更新を明記

---

## 推奨対応事項（Should Fix）

### IS-SF-001: Auto-Yes機能の基本動作確認

**問題**:
`src/lib/auto-yes-manager.ts`と`src/lib/auto-yes-resolver.ts`の影響分析が不足。Auto-Yes機能はIssue #138でサーバー側ポーリングとして実装されており、Codexの場合のプロンプト検出・自動応答動作の検証が必要。

**推奨対応**:
Auto-Yes機能のCodex対応をPhase 2として分離する旨は記載済みだが、Phase 1でも基本動作確認（プロンプト検出が正しく動作するか）をテスト要件に含めることを推奨。

---

### IS-SF-002: response-poller.tsのCodexレスポンス処理

**問題**:
`src/lib/response-poller.ts`のCodex対応実装の詳細確認が影響範囲に含まれていない。同ファイルは以下の関数を含む：
- `cleanClaudeResponse()` - Claude専用
- `cleanGeminiResponse()` - Gemini専用
- `cleanCodexResponse()` - **存在しない**

**現状のコード**:
```typescript
// Clean up responses (remove shell prompts, setup commands, and errors)
let cleanedResponse = result.response;
if (cliToolId === 'gemini') {
  cleanedResponse = cleanGeminiResponse(result.response);
} else if (cliToolId === 'claude') {
  cleanedResponse = cleanClaudeResponse(result.response);
}
// Codex: cleanedResponse is used as-is (no cleaning)
```

**推奨対応**:
- 技術スコープに`response-poller.ts`のCodexレスポンス処理検証を追加
- 必要に応じて`cleanCodexResponse()`関数の追加を検討

---

### IS-SF-003: session-cleanup.tsの動作確認

**問題**:
`src/lib/session-cleanup.ts`がCodexを含む全CLIツールの一括クリーンアップに対応済みであることの確認が影響範囲に記載されていない。

**既存実装**:
```typescript
const CLI_TOOL_IDS: CLIToolType[] = ['claude', 'codex', 'gemini'];

// Kill sessions and stop response-pollers for each CLI tool
for (const cliToolId of CLI_TOOL_IDS) {
  // ...
}
```

**推奨対応**:
テスト要件に`session-cleanup.ts`のCodex対応動作確認を追加。

---

### IS-SF-004: status-detector.tsの既存テスト確認

**問題**:
`src/lib/__tests__/status-detector.test.ts`にCodex対応テストが既に存在するが、Issue内でテストカバレッジの確認が言及されていない。

**既存テスト**:
```typescript
describe('codex', () => {
  it('should return "ready" with high confidence when codex prompt is detected', () => {
    const output = `
Previous response
> Type your request
`;
    const result = detectSessionStatus(output, 'codex');
    expect(result.status).toBe('ready');
  });
});
```

**推奨対応**:
既存のCodexステータス検出テストを実行し、実際のCodex CLI出力との整合性を検証する作業を明記。

---

## 改善提案（Nice to Have）

### IS-NTH-001: ログ出力の動作確認

`src/lib/log-manager.ts`、`src/lib/conversation-logger.ts`のCodex対応確認が影響範囲に含まれていない。ログ出力の動作確認をテスト要件に追加することを推奨。

### IS-NTH-002: terminal/page.tsxとの機能差異整理

`terminal/page.tsx`でCodexタブは既に定義されているが、`WorktreeDetail.tsx`との機能差異（フルターミナル vs チャットUI）の整理が必要。UI有効化セクションに両ページの役割と変更範囲を明確化することを推奨。

### IS-NTH-003: 手動テスト手順の明記

既存の結合テスト群がCodex対応済みだが、実際のCodex CLI動作との結合テストは手動確認となる。手動テストの実施手順をテスト要件に追記することを推奨。

---

## 影響ファイル一覧

| ファイルパス | 種別 | 変更タイプ |
|-------------|------|-----------|
| `src/lib/cli-tools/codex.ts` | コア | レビュー・改善 |
| `src/lib/cli-patterns.ts` | コア | 検証 |
| `src/lib/prompt-detector.ts` | コア | 修正の可能性 |
| `src/lib/response-poller.ts` | コア | 検証・修正の可能性 |
| `src/lib/status-detector.ts` | コア | 検証 |
| `src/components/worktree/WorktreeDetail.tsx` | UI | 修正（isCliTab拡張） |
| `src/app/worktrees/[id]/terminal/page.tsx` | UI | 検証 |
| `src/lib/session-cleanup.ts` | 基盤 | 検証 |
| `src/lib/auto-yes-manager.ts` | 基盤 | Phase 2 |
| `src/lib/auto-yes-resolver.ts` | 基盤 | Phase 2 |
| `tests/unit/cli-tools/codex.test.ts` | テスト | 検証・拡張 |
| `src/lib/__tests__/cli-patterns.test.ts` | テスト | 拡張 |
| `src/lib/__tests__/status-detector.test.ts` | テスト | 検証 |
| `tests/e2e/cli-tool-selection.spec.ts` | テスト | 修正 |
| `tests/integration/api-send-cli-tool.test.ts` | テスト | 検証 |

---

## リスク分析

### 高リスク: Codex CLI EOL

- **リスク**: OpenAI Codex CLIがEOL（End of Life）の可能性があり、実際に利用可能かどうかの事前確認が最重要
- **影響**: 利用不可の場合、Issue全体がブロックされる
- **緩和策**: Issue着手前にCodex CLIのインストール・認証・基本動作を手動で確認

### 中リスク: プロンプト検出パターン精度

- **リスク**: `CODEX_PROMPT_PATTERN`（`/^>\s+.+/m`）が実際のCodex CLI出力と一致しない可能性
- **影響**: プロンプト検出失敗によるUI動作不良
- **緩和策**: 実際のCodex CLI出力をキャプチャし、パターンの精度検証

### 中リスク: UI状態管理の複雑化

- **リスク**: `WorktreeDetail.tsx`でisCliTab関数を拡張する際、既存のClaude固有ロジック（realtimeOutput、isThinking等）がCodexでも正しく動作するか不明
- **影響**: UI表示の不整合、状態管理のバグ
- **緩和策**: Claude/Codex両方での手動テストを実施

---

## 依存関係

```
WorktreeDetail.tsx
    |
    v
cli-tools/types.ts (CLIToolType)
    ^
    |
cli-tools/manager.ts
    |
    v
cli-tools/codex.ts
    ^
    |
response-poller.ts <-- cli-patterns.ts
    ^
    |
session-cleanup.ts
```

---

## 結論

Issue #4の影響範囲は概ね適切に定義されているが、以下の点の追記が必要：

1. **必須**: `prompt-detector.ts`を影響ファイルに追加
2. **必須**: E2Eテストの更新を影響範囲に追加
3. **推奨**: `response-poller.ts`のCodexレスポンス処理検証を明記
4. **推奨**: 既存テストの実行確認を明記

最大のリスクはCodex CLI自体のEOL状態であり、Issue着手前の事前確認が必須。既存アーキテクチャ（Strategyパターン）を維持しながらの対応が可能であり、影響範囲は限定的（約15ファイル）。
