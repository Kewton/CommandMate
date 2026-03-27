# Architecture Review: Issue #559 - Stage 2 整合性レビュー

**日付**: 2026-03-27
**対象Issue**: #559 - Copilot CLI スラッシュコマンド修正
**設計書**: dev-reports/design/issue-559-copilot-slash-cmd-fix-design-policy.md
**レビュー焦点**: 整合性 (設計書と実装コードベースの一致性)

---

## 総合評価

設計の基本方針（Copilot全コマンドをsendMessage()に委譲するアプローチC改）は正しく、コードベースの構造と整合している。ただし、ICLIToolインターフェースに既にsendMessage()が定義されている事実が設計書で見落とされており、不要な型キャストとimportが提案されている。この問題を解消すれば、実装変更はさらに最小化される。

**検出件数**: must_fix 1件, should_fix 3件, nice_to_have 2件
**総合リスク**: Low

---

## 検出事項一覧

### CR2-001 [should_fix] CopilotToolへの型キャストは不要

**問題**: 設計書セクション3-2で `manager.getTool('copilot') as CopilotTool` と型キャストを指示しているが、`ICLITool` インターフェース（src/lib/cli-tools/types.ts L56）に既に `sendMessage(worktreeId: string, message: string): Promise<void>` が定義されている。

**根拠**: `CLIToolManager.getTool()` は `ICLITool` を返し、`ICLITool.sendMessage()` は全ツール共通メソッドとして定義済み。Copilot固有のキャストは不要。

**影響**: 設計書のDR1-005（LSP非対称性）の懸念自体が存在しない問題を議論していることになる。

**推奨対応**: コード例を `await cliTool.sendMessage(params.id, command);` に修正。

---

### CR2-002 [should_fix] CopilotTool importが不要

**問題**: 設計書が `import { CopilotTool } from '@/lib/cli-tools/copilot';` の追加を指示しているが、CR2-001の通り型キャスト不要のため、このimportも不要。

**推奨対応**: import指示を削除。

---

### CR2-003 [must_fix] 既存テストのisCliToolTypeモックにcopilotが欠落

**問題**: `tests/unit/terminal-route.test.ts` L12のisCliToolTypeモックは以下の5ツールのみを許可:
```
['claude', 'codex', 'gemini', 'vibe-local', 'opencode']
```
`'copilot'` が含まれていないため、Copilot委譲テストを追加しても `cliToolId='copilot'` が400エラーになる。設計書のテスト戦略セクションにこの修正手順が記載されていない。

**推奨対応**: テスト戦略に「既存のisCliToolTypeモックにcopilotを追加する」手順を明記する。

---

### CR2-004 [should_fix] ICLITool.sendMessage()の存在を踏まえた将来拡張パスの見直し

**問題**: 設計書セクション8の将来拡張パス（handleTerminalCommand()追加）が、ICLIToolに既にsendMessage()が定義されている事実を考慮していない。全ツールがsendMessage()を持つため、他ツールでも同様の委譲が可能。

**推奨対応**: 将来の拡張パスの記述に、既存sendMessage()の活用可能性を追記する。

---

### CR2-005 [nice_to_have] sendEnterデフォルトパラメータの挙動未記載

**問題**: terminal/route.tsの既存sendKeys呼び出し（`sendKeys(sessionName, command)`）はsendEnter=trueがデフォルト適用される。CopilotTool.sendMessage()内では明示的にsendEnterを制御している。この挙動差異が設計書に記載されていない。

**影響**: sendMessage()に委譲するため実装には影響しない。設計書の完全性の問題。

---

### CR2-006 [nice_to_have] コード例が既存cliTool変数を再利用していない

**問題**: 設計書のコード例はL69の既存 `cliTool` 変数を再利用せず、別途 `manager.getTool('copilot')` を呼んでいる。既存コードパターンとの不整合。

**推奨対応**: CR2-001と合わせて、既存cliTool変数を活用する形に修正する。

---

## チェックリスト結果

| チェック項目 | 結果 | 備考 |
|-------------|------|------|
| 設計書がコードベース構造を正確に反映 | Pass (with findings) | CR2-001, CR2-002 |
| 関数シグネチャ・型が正確 | Pass (with findings) | CR2-001, CR2-004 |
| import パスが正確 | Fail | CR2-002: 不要なimport指示 |
| コード例が実際のパターンと一致 | Fail | CR2-006: 既存変数未利用 |
| 「変更なし」ファイルの検証 | Pass | copilot.ts等、正確 |
| テスト戦略の整合性 | Fail | CR2-003: モック修正手順欠落 |

---

## 推奨アクション（優先順）

1. **CR2-001/CR2-002/CR2-006 統合対応**: 設計書のコード例を簡素化し、既存のcliTool変数とICLITool.sendMessage()を活用する形に修正する
2. **CR2-003 対応**: テスト戦略にisCliToolTypeモックへのcopilot追加手順を明記する
3. **CR2-004 対応**: 将来の拡張パス記述を見直し、ICLIToolの既存sendMessage()活用可能性を反映する

---

*レビュー実施: 2026-03-27*
*対象Issue: #559*
*レビューステージ: Stage 2 整合性レビュー*
