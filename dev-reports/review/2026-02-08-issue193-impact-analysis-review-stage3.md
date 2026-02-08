# Issue #193 影響分析レビュー (Stage 3)

**レビュー日**: 2026-02-08
**対象**: Issue #193 - Codex CLI複数選択肢検出・応答対応
**設計書**: `dev-reports/design/issue-193-codex-multiple-choice-detection-design-policy.md`
**フォーカス**: 影響範囲 (Impact Scope) - 波及効果の分析

---

## 1. レビューサマリー

| 指標 | 値 |
|------|-----|
| 総指摘数 | 12 |
| must_fix | 3 |
| should_fix | 5 |
| nice_to_have | 4 |
| 判定 | 設計書の影響範囲分析は概ね正確だが、見落とされた波及効果が3件あり修正が必要 |

---

## 2. 影響範囲の全体像

### 2.1 detectPrompt を import するファイル一覧 (ソースコード全数調査)

| # | ファイル | 設計書での分類 | 実態 |
|---|---------|--------------|------|
| 1 | `src/lib/auto-yes-manager.ts` | 変更対象 (Phase 3) | 一致 |
| 2 | `src/lib/status-detector.ts` | 変更対象 (Phase 3) | 一致 |
| 3 | `src/lib/response-poller.ts` | 変更対象 (Phase 3, L442/L556) + 変更不要 (L248) | 一致 |
| 4 | `src/lib/claude-poller.ts` | 変更不要 (後方互換) | 一致 |
| 5 | `src/app/api/worktrees/[id]/prompt-response/route.ts` | 変更対象 (Phase 3) | 一致 |
| 6 | `src/app/api/worktrees/[id]/current-output/route.ts` | 変更対象 (Phase 3) | 一致 |
| 7 | `src/app/api/worktrees/[id]/respond/route.ts` | getAnswerInput のみ import | 設計書12.3節に記載済み |
| 8 | `tests/unit/prompt-detector.test.ts` | テスト追加 (Phase 4) | 一致 |

**結論**: detectPrompt の直接 import 先は全て設計書に網羅されている。

### 2.2 間接的に影響を受けるファイル (detectSessionStatus 経由)

| # | ファイル | 設計書の記載 | 問題 |
|---|---------|------------|------|
| 1 | `src/app/api/worktrees/route.ts` | **未記載** | DR3-001 |
| 2 | `src/app/api/worktrees/[id]/route.ts` | **未記載** | DR3-001 |

これらのファイルは `detectSessionStatus()` を呼び出しており、`status-detector.ts` の内部動作変更（`lastLines` から `cleanOutput` への変更）の影響を間接的に受ける。

### 2.3 テストファイルの影響マッピング

| # | テストファイル | 設計書の記載 | 更新内容 |
|---|-------------|------------|---------|
| 1 | `tests/unit/prompt-detector.test.ts` | Phase 4 (記載済み) | Codex テスト追加、後方互換テスト |
| 2 | `tests/unit/lib/cli-patterns.test.ts` | Phase 4 (記載済み) | getChoiceDetectionPatterns, detectPromptForCli テスト追加 |
| 3 | `tests/unit/lib/auto-yes-manager.test.ts` | Phase 4 (記載済み) | モック更新 |
| 4 | `tests/unit/api/prompt-response-verification.test.ts` | Phase 4 (記載済み) | モック更新 |
| 5 | `src/lib/__tests__/status-detector.test.ts` | **未記載** | DR3-002: windowing変更の動作確認 |
| 6 | `src/lib/__tests__/cli-patterns.test.ts` | **未記載** | DR3-007: テストファイル重複の確認 |
| 7 | `tests/integration/api-prompt-handling.test.ts` | **未記載** | DR3-005: 回帰テスト実行 |

---

## 3. 指摘事項詳細

### DR3-001 [must_fix] worktrees/route.ts と worktrees/[id]/route.ts が間接的影響を受けるが設計書に記載なし

**影響経路**: `worktrees/route.ts` -> `detectSessionStatus()` -> `detectPrompt()` -> `detectMultipleChoicePrompt()`

`detectSessionStatus()` のシグネチャ自体は変更されないが、内部で `detectPrompt()` に渡す出力が `lastLines`（15行）から `cleanOutput`（全量）に変更されることで、サイドバーのステータス判定動作が変わる。

**該当コード** (`src/app/api/worktrees/route.ts` L57-58):
```typescript
const output = await captureSessionOutput(worktree.id, cliToolId, 100);
const statusResult = detectSessionStatus(output, cliToolId);
```

**推奨**: 12.3節（動作確認が必要なファイル）に追加。

---

### DR3-002 [must_fix] status-detector.test.ts が設計書の更新対象テストに未記載

`src/lib/__tests__/status-detector.test.ts` は `detectSessionStatus()` を直接テストしている。特に以下のテストが windowing 変更の影響を受ける可能性がある:

- L374-385: 「should check only last 15 lines」-- full cleanOutput を `detectPrompt` に渡す変更後の期待値確認が必要
- L92-104: 「should detect multiple choice prompt as waiting」-- 15行以内に収まる multiple choice のテスト
- L203-351: Issue #180 past prompts テスト -- windowing変更後の動作確認

**推奨**: 8.2節および12.1節に `src/lib/__tests__/status-detector.test.ts` を追加。

---

### DR3-003 [must_fix] response-poller.ts L248 の stripAnsi 適用状態の明確化

設計書12.2節では L248 を「変更不要（Claude専用ガード内）」としている。しかし、L248 は既に `stripAnsi` 済みの `cleanFullOutput` を `detectPrompt` に渡しているのに対し、L442 は `stripAnsi` 未適用の `fullOutput` を渡している。この差異が設計書で明確化されていない。

**該当コード** (`src/lib/response-poller.ts`):
```typescript
// L244-248: Claude専用早期チェック（stripAnsi済み）
if (cliToolId === 'claude') {
    const fullOutput = lines.join('\n');
    const cleanFullOutput = stripAnsi(fullOutput);
    const promptDetection = detectPrompt(cleanFullOutput); // stripAnsi済み
}

// L441-442: 汎用チェック（stripAnsi未適用）
const fullOutput = lines.join('\n');
const promptDetection = detectPrompt(fullOutput); // stripAnsi未適用
```

**推奨**: 12.2節に L248 の stripAnsi 適用状態を明記。

---

### DR3-004 [should_fix] サイドバーステータスのパフォーマンス影響

`worktrees/route.ts` は `Promise.all` で全ワークツリー x 3 CLIツールの `detectSessionStatus()` を並列実行する。`captureSessionOutput` の capture_count は 100 であるため、`detectPrompt` に渡される出力は最大100行。15行から100行への変更は、`detectMultipleChoicePrompt` 内部の50行スライスにより実質的な計算量増加は最小限だが、7.2節に明記すべき。

---

### DR3-005 [should_fix] 統合テストの回帰テスト実行が未記載

`tests/integration/api-prompt-handling.test.ts` は `respond/route.ts` の統合テストであり、Phase 5 の回帰テスト対象として明示すべき。

---

### DR3-006 [should_fix] useAutoYes.ts の cliTool パラメータ検証対象の記載が不正確

設計書12.4節では `useAutoYes.ts` が「Auto-Yesポーリング」時に `current-output` API を呼び出すと記載しているが、実際には `useAutoYes` は `prompt-response` API を呼び出すのみ。`current-output` API は `WorktreeDetailRefactored.tsx` が呼び出している。

**該当コード** (`src/hooks/useAutoYes.ts` L86-89):
```typescript
fetch(`/api/worktrees/${worktreeId}/prompt-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer, cliTool }),
})
```

---

### DR3-007 [should_fix] cli-patterns テストファイルの重複

cli-patterns のテストが2つのディレクトリに存在:
- `src/lib/__tests__/cli-patterns.test.ts` (Issue #132 向け)
- `tests/unit/lib/cli-patterns.test.ts` (Issue #4 向け)

新規テスト追加先の明確化が必要。

---

### DR3-008 [should_fix] PromptDetectionResult の export 確認

`detectPromptForCli()` の戻り値型として `PromptDetectionResult` を `cli-patterns.ts` で import する必要がある。Phase 2 チェックリストに確認項目を追加すべき。

---

### DR3-009 [nice_to_have] claude-poller.ts の到達不能コードに関する注記

`claude-poller.ts` の `detectPrompt()` 呼び出し（L164, L232）は `startPolling()` が呼び出されていないため到達不能。将来の廃止/統合を検討すべき。

---

### DR3-010 [nice_to_have] respond/route.ts からの呼び出しチェーン

`respond/route.ts` -> `startPolling()` -> `checkForResponse()` -> `extractResponse()` -> `detectPrompt()` の呼び出しチェーンを12.3節に明記すべき。

---

### DR3-011 [nice_to_have] auto-yes-manager.test.ts のモック精査

`auto-yes-manager.test.ts` は `detectPrompt` を直接モックしていない。`detectPromptForCli` への移行後のモック設定変更の有無を確認すべき。

---

### DR3-012 [nice_to_have] E2Eテストでのサイドバーステータス確認

`detectSessionStatus()` の内部動作変更により、サイドバーステータス表示の E2E テストを Phase 5 に追加することを推奨。

---

## 4. 影響範囲チェックリスト

| # | チェック項目 | 結果 | 備考 |
|---|------------|------|------|
| 1 | detectPrompt を import するファイルが全て記載されているか | OK | 8ファイル全て網羅 |
| 2 | detectPrompt シグネチャ変更が動的/ランタイム使用を破壊しないか | OK | optional引数追加のみ、後方互換 |
| 3 | detectPromptForCli の cli-patterns.ts 追加でモジュール読み込み問題がないか | OK | 循環依存なし |
| 4 | 更新が必要だが未記載のテストファイルがないか | NG | status-detector.test.ts が未記載 (DR3-002) |
| 5 | ウィンドウイング変更のパフォーマンス影響が評価されているか | 部分的 | 明記が不十分 (DR3-004) |
| 6 | E2E/統合テストシナリオが明示されているか | 部分的 | 回帰テスト対象の明示不足 (DR3-005, DR3-012) |

---

## 5. 推奨アクション

### 即座に対応すべき項目 (must_fix: 3件)
1. **DR3-001**: 12.3節に `worktrees/route.ts` と `[id]/route.ts` を動作確認対象として追加
2. **DR3-002**: 8.2節と12.1節に `src/lib/__tests__/status-detector.test.ts` を追加
3. **DR3-003**: 12.2節の L248 に stripAnsi 適用状態の注記を追加

### 対応を推奨する項目 (should_fix: 5件)
4. **DR3-004**: 7.2節にパフォーマンス影響の詳細を追記
5. **DR3-005**: Phase 5 に統合テストの回帰テスト実行を追加
6. **DR3-006**: 12.4節の useAutoYes.ts の記載を修正
7. **DR3-007**: テストファイルの追加先を明確化
8. **DR3-008**: Phase 2 チェックリストに PromptDetectionResult の export 確認を追加

---

*Generated by architecture-review-agent for Issue #193 Stage 3*
*Date: 2026-02-08*
