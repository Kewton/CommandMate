# Issue #152 Review Report - Stage 1

## Review Information

| Item | Value |
|------|-------|
| Issue Number | #152 |
| Issue Title | セッション一発目のメッセージが送信されない |
| Review Type | 通常レビュー（整合性・正確性） |
| Stage | 1 (1回目) |
| Reviewed At | 2026-02-04 |
| Overall Assessment | PASS_WITH_RECOMMENDATIONS |

---

## Executive Summary

Issue #152 は十分にドキュメント化されており、技術調査結果も正確です。コードスニペットと行番号は実際のコードベースと一致しています。提案された改善策は技術的に妥当です。いくつかの軽微な改善点を推奨します。

---

## Code Verification Results

### 1. src/lib/claude-session.ts

| Item | Status |
|------|--------|
| Referenced Lines | 165-225 |
| Actual Lines | 165-225 |
| Verification | ACCURATE |

**Findings:**
- `startClaudeSession()`関数の位置と内容は正確
- `maxWaitTime = 10000ms`（10秒）は正確
- `pollInterval = 500ms` は正確
- プロンプト検出パターン `/^>\s*$/m` と `/^─{10,}$/m` は正確

### 2. src/app/api/worktrees/[id]/send/route.ts

| Item | Status |
|------|--------|
| Referenced Lines | 94-124 |
| Actual Lines | 94-124 |
| Verification | ACCURATE |

**Findings:**
- `isRunning()` / `startSession()` / `sendMessage()` の呼び出しフローは正確
- ファイル全体は179行（Issueのスニペットは必要な部分のみ抜粋）
- cliTool変数はCLIToolManager経由で取得されることが確認済み

---

## Must Fix Issues

**None identified.**

Issueの技術的な記述に重大な誤りはありません。

---

## Should Fix Issues

### SF-001: CLIToolインターフェース経由の呼び出しに関する説明が不足

**Category:** missing_context
**Priority:** Medium

**Description:**
Issue内のコードスニペットは`src/lib/claude-session.ts`を直接参照していますが、実際の呼び出しは`src/lib/cli-tools/claude.ts`の`ClaudeTool`クラス経由で行われます。

**Current State:**
```
send/route.ts -> cliTool.startSession() -> ???
```

**Recommended:**
影響コンポーネントに`src/lib/cli-tools/claude.ts`（ClaudeToolクラス）を追加し、呼び出しチェーンを明確化:
```
send/route.ts -> ClaudeTool.startSession() -> startClaudeSession()
              -> ClaudeTool.sendMessage() -> sendMessageToClaude()
```

---

### SF-002: 案2のwaitForPrompt関数が未定義

**Category:** technical_accuracy
**Priority:** Medium

**Description:**
推奨される改善策の案2で`waitForPrompt(sessionName, 5000)`関数を使用していますが、この関数は現在のコードベースに存在しません。

**Current State:**
```typescript
// 送信前にプロンプト状態を確認
const output = await capturePane(sessionName, { startLine: -10 });
if (!/^>\s*$/m.test(output)) {
  await waitForPrompt(sessionName, 5000);  // <-- 未定義
}
```

**Recommended:**
`waitForPrompt`関数の新規実装が必要であることを明記し、期待される動作を定義:
- プロンプト検出パターン
- タイムアウト処理
- エラー時の挙動（throw or return false）

---

### SF-003: 受け入れ条件の具体化

**Category:** acceptance_criteria
**Priority:** Low

**Description:**
受け入れ条件「UIにローディング状態が正しく表示されること」の具体的な期待動作が不明確です。

**Current State:**
```
- [ ] UIにローディング状態が正しく表示されること
```

**Recommended:**
```
- [ ] セッション起動中は送信ボタンが無効化されること
- [ ] セッション起動中はスピナーまたはローディングインジケータが表示されること
- [ ] セッション起動完了後にメッセージ入力が可能になること
```

---

## Nice to Have

### NTH-001: 他のCLIツール（codex, gemini）への影響

Issue #4でCLIツールサポートが追加されており、codex、geminiも同様のセッション初期化ロジックを持つ可能性があります。本修正が他のCLIツールにも適用されるべきか検討が必要です。

**Recommendation:**
`src/lib/cli-tools/codex.ts`、`src/lib/cli-tools/gemini.ts`の初期化ロジックを確認し、共通の問題であれば`base.ts`レベルでの修正を検討。

---

### NTH-002: テスト手順の自動化

テスト手順は手動確認を前提としています。

**Recommendation:**
セッション初期化タイミングをテストする統合テストまたはE2Eテストの追加を検討。

---

### NTH-003: 案1のプロンプト検出パターンの妥当性

案1では`output.includes('Claude')`を追加していますが、Claude CLIの初期化画面に常に'Claude'文字列が含まれるかどうかの確認が必要です。

**Recommendation:**
Claude CLI初期化時の実際の出力例をスクリーンショットまたはログで確認し、検出パターンの妥当性を検証。

---

## Consistency Check

| Check | Status | Notes |
|-------|--------|-------|
| Codebase Consistency | CONSISTENT | コードスニペットと行番号は正確 |
| Documentation Consistency | CONSISTENT | CLAUDE.mdのアーキテクチャ記述と整合 |
| Existing Issues | NOT_CHECKED | 関連Issueの確認は未実施 |

---

## Summary of Recommendations

1. **SF-001:** 影響コンポーネントに`src/lib/cli-tools/claude.ts`を追加し、呼び出しチェーンを明確化
2. **SF-002:** 案2の`waitForPrompt`関数は新規実装が必要であることを明記
3. **SF-003:** 受け入れ条件のUIローディング状態について具体的な期待動作を定義

---

## Conclusion

Issue #152は技術的に正確で、問題の特定と解決策の提案が適切に行われています。上記の軽微な改善点を反映することで、より明確で実装しやすいIssueになります。

**Overall Assessment: PASS_WITH_RECOMMENDATIONS**
